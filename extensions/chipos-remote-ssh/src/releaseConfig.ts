/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * ChipOS Release config (extension-side).
 *
 * **Single source of truth**: `product.json` → `chiposReleases.repo`.
 * This file just exports values derived from that field.
 *
 * Source-tree dev builds have `commit: ""` and the product.json field is
 * left empty by the packaging step. In that case we fall back to
 * `DEFAULT_REPO` so ChipOS dev workflows keep working without a
 * production product.json.
 *
 * Workbench-side mirror: `src/vs/workbench/contrib/chipos/common/releaseConfig.ts`
 * reads the same field via `IProductService.chiposReleases?.repo`.
 *
 * To switch the release host (e.g. linshaoxin-maker → chip-os):
 *   1. Edit `product.json` → `chiposReleases.repo`
 *   2. Edit `product.json` → `chiposDefaults.updateUrl` and `downloadUrl`
 *      (must point at the same repo; REH auto-update reads them directly)
 *   3. Re-build the IDE
 *
 * Steps 1–3 are the only places. This file doesn't need editing —
 * the constants are computed from product.json at module load.
 */

import { getProductInfo } from './download';

/**
 * Hardcoded fallback for source-tree dev builds (commit: ""). In production
 * builds, product.json `chiposReleases.repo` overrides this.
 *
 * Updating this value alone is NOT enough — production users get the value
 * from product.json. Always edit product.json for real changes.
 */
const DEFAULT_REPO = 'linshaoxin-maker/chipos-releases';

function _resolveRepo(): string {
	const fromProduct = getProductInfo().chiposReleases?.repo;
	return (fromProduct && fromProduct.trim()) || DEFAULT_REPO;
}

/** Worker / REH 产物发布的 GitHub 仓库, 格式: owner/repo */
export const CHIPOS_RELEASE_REPO = _resolveRepo();

/** GitHub Releases 下载基础 URL (derived from repo) */
export const CHIPOS_RELEASE_BASE_URL = `https://github.com/${CHIPOS_RELEASE_REPO}/releases/download`;

/** GitHub API — 查询最新 Release (derived from repo) */
export const CHIPOS_RELEASE_API_URL = `https://api.github.com/repos/${CHIPOS_RELEASE_REPO}/releases/latest`;
