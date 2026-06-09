/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestService, isSuccess, asText } from '../../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';

/**
 * Plugin catalog client (FEAT-002d). Fetches a curated `catalog.json` (the
 * chipos-releases allow-list) over raw HTTPS, with a 24h cache + stale-on-error
 * fallback, and parses it into {@link CatalogEntry}s the Plugins tab browses.
 * Installing an entry routes through the FEAT-002b Git-install flow (its `repo`
 * URL is still host-checked + trust-gated there). Modelled on
 * modelDiscoveryService.ts (IRequestService + isSuccess + asText).
 */

/** One browsable plugin in the catalog. `repo` is the https Git URL to install. */
export interface CatalogEntry {
	readonly id: string;
	readonly name: string;
	readonly repo: string;
	readonly description?: string;
	/** FEAT-006b: free-text category for the browser filter; absent ⇒ Uncategorized. */
	readonly category?: string;
	readonly author?: string;
	readonly ref?: string;
	readonly verified?: boolean;
}

/** Result of a catalog read. `offline` = served from a stale cache after a fetch failure. */
export interface CatalogResult {
	readonly entries: CatalogEntry[];
	readonly offline: boolean;
}

/**
 * Parse + validate a `catalog.json` payload into {@link CatalogEntry}s. Accepts
 * either a bare array or a `{ "plugins": [...] }` wrapper. Entries missing the
 * required `name`/`repo` (or otherwise malformed) are skipped so one bad entry
 * never breaks the whole list. Pure (no I/O) — unit-testable.
 */
export function parseCatalogEntries(jsonText: string): CatalogEntry[] {
	let raw: unknown;
	try {
		raw = JSON.parse(jsonText);
	} catch {
		return [];
	}
	const list: unknown[] = Array.isArray(raw)
		? raw
		: (raw && typeof raw === 'object' && Array.isArray((raw as { plugins?: unknown }).plugins))
			? (raw as { plugins: unknown[] }).plugins
			: [];
	const out: CatalogEntry[] = [];
	for (const item of list) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const o = item as Record<string, unknown>;
		const name = typeof o.name === 'string' ? o.name.trim() : '';
		const repo = typeof o.repo === 'string' ? o.repo.trim() : '';
		if (!name || !repo) {
			continue; // required fields
		}
		const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : name;
		out.push({
			id,
			name,
			repo,
			description: typeof o.description === 'string' ? o.description : undefined,
			category: typeof o.category === 'string' && o.category.trim() ? o.category.trim() : undefined,
			author: typeof o.author === 'string' ? o.author : undefined,
			ref: typeof o.ref === 'string' ? o.ref : undefined,
			verified: o.verified === true,
		});
	}
	return out;
}

/** Bucket label for entries with no `category`. */
export const UNCATEGORIZED = 'Uncategorized';

/** Distinct categories present in the catalog, sorted (Uncategorized last). Pure. */
export function catalogCategories(entries: readonly CatalogEntry[]): string[] {
	const set = new Set<string>();
	for (const e of entries) {
		set.add(e.category?.trim() || UNCATEGORIZED);
	}
	return [...set].sort((a, b) => (a === UNCATEGORIZED ? 1 : b === UNCATEGORIZED ? -1 : a.localeCompare(b)));
}

/**
 * Filter the catalog by a free-text query (matched case-insensitively against
 * name / description / author) and an optional exact category. Empty query + no
 * category returns everything. Pure (no I/O) — unit-testable.
 */
export function filterCatalogEntries(entries: readonly CatalogEntry[], query: string, category?: string): CatalogEntry[] {
	const q = query.trim().toLowerCase();
	const cat = category?.trim();
	return entries.filter(e => {
		if (cat && cat !== (e.category?.trim() || UNCATEGORIZED)) {
			return false;
		}
		if (!q) {
			return true;
		}
		return e.name.toLowerCase().includes(q)
			|| (e.description?.toLowerCase().includes(q) ?? false)
			|| (e.author?.toLowerCase().includes(q) ?? false);
	});
}

const CACHE_KEY = 'chipos.plugins.catalog.payload';
const CACHE_TS_KEY = 'chipos.plugins.catalog.timestamp';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class ChiposPluginCatalogService {
	constructor(
		@IRequestService private readonly _requestService: IRequestService,
		@IStorageService private readonly _storageService: IStorageService,
		@IProductService private readonly _productService: IProductService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) { }

	/** Catalog URL: `chipos.plugins.catalogUrl` override, else derived from the chipos-releases repo. */
	private _catalogUrl(): string {
		const configured = this._configurationService.getValue<string>('chipos.plugins.catalogUrl');
		if (configured && configured.trim()) {
			return configured.trim();
		}
		const repo = this._productService.chiposReleases?.repo || 'linshaoxin-maker/chipos-releases';
		return `https://raw.githubusercontent.com/${repo}/main/catalog.json`;
	}

	/**
	 * Return the catalog entries: a fresh cache (<24h) if present, otherwise
	 * fetch + cache; on a fetch failure fall back to any cache (even stale) with
	 * `offline: true`. `opts.now`/`opts.fetch` are injectable for hermetic tests.
	 */
	async getCatalog(token: CancellationToken, opts?: { now?: number; forceRefresh?: boolean; fetch?: () => Promise<string> }): Promise<CatalogResult> {
		const now = opts?.now ?? Date.now();
		if (!opts?.forceRefresh) {
			const fresh = this._readCache(now, false);
			if (fresh) {
				return { entries: fresh, offline: false };
			}
		}
		const fetch = opts?.fetch ?? (() => this._fetchText(token));
		try {
			const text = await fetch();
			const entries = parseCatalogEntries(text);
			this._writeCache(text, now);
			return { entries, offline: false };
		} catch (err) {
			const stale = this._readCache(now, true);
			if (stale) {
				return { entries: stale, offline: true };
			}
			throw err;
		}
	}

	private async _fetchText(token: CancellationToken): Promise<string> {
		const context = await this._requestService.request({ url: this._catalogUrl() }, token);
		if (!isSuccess(context)) {
			throw new Error(`Catalog fetch failed (HTTP ${context.res.statusCode ?? '?'}).`);
		}
		return (await asText(context)) ?? '';
	}

	private _readCache(now: number, ignoreTtl: boolean): CatalogEntry[] | undefined {
		const text = this._storageService.get(CACHE_KEY, StorageScope.APPLICATION);
		const tsStr = this._storageService.get(CACHE_TS_KEY, StorageScope.APPLICATION);
		if (!text || !tsStr) {
			return undefined;
		}
		const ts = Number(tsStr);
		if (!ignoreTtl && (!isFinite(ts) || now - ts > CACHE_TTL_MS)) {
			return undefined;
		}
		return parseCatalogEntries(text);
	}

	private _writeCache(text: string, now: number): void {
		this._storageService.store(CACHE_KEY, text, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._storageService.store(CACHE_TS_KEY, String(now), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}
