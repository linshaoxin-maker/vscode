/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * ChipOS Release config (workbench-side).
 *
 * **Single source of truth for `repo`**: `product.json` → `chiposReleases.repo`.
 * Workbench callers should access it via `IProductService.chiposReleases?.repo`
 * directly (no helper needed for one-line lookups). This file is kept for
 * back-compat exports + the unrelated `CHIPOS_REASONER_VERSION` constant.
 *
 * Extension-side mirror: `extensions/chipos-remote-ssh/src/releaseConfig.ts`
 * reads the same field via `getProductInfo().chiposReleases.repo`.
 *
 * To switch release host (e.g. linshaoxin-maker → chip-os):
 *   1. Edit `product.json` → `chiposReleases.repo`
 *   2. Edit `product.json` → `chiposDefaults.updateUrl` + `downloadUrl`
 *      (must point at the same repo; REH auto-update reads them directly)
 *   3. Re-build the IDE
 *
 * The hardcoded `DEFAULT_REPO` below is only used in source-tree dev builds
 * where `product.json` fields are empty (commit: "").
 */

/**
 * Hardcoded fallback for source-tree dev builds. Production users get the
 * value from product.json. **Always edit product.json for real changes**;
 * editing this constant alone has no effect in production builds.
 */
export const DEFAULT_RELEASE_REPO = 'linshaoxin-maker/chipos-releases';

/**
 * @deprecated Workbench code should read `IProductService.chiposReleases?.repo`
 *             directly with `DEFAULT_RELEASE_REPO` as the fallback. This
 *             constant is kept only to avoid breaking imports during the
 *             refactor and is NOT live-updated from product.json.
 */
export const CHIPOS_RELEASE_REPO = DEFAULT_RELEASE_REPO;

/**
 * @deprecated Build at call site:
 *             `\`https://github.com/${repo}/releases/download\`` where `repo`
 *             comes from `IProductService.chiposReleases?.repo ?? DEFAULT_RELEASE_REPO`.
 */
export const CHIPOS_RELEASE_BASE_URL = `https://github.com/${DEFAULT_RELEASE_REPO}/releases/download`;

/**
 * @deprecated Build at call site:
 *             `\`https://api.github.com/repos/${repo}/releases/latest\``.
 */
export const CHIPOS_RELEASE_API_URL = `https://api.github.com/repos/${DEFAULT_RELEASE_REPO}/releases/latest`;

/**
 * Expected Reasoner backend version.
 * Must match the `reasoner_version` field returned by GET /health.
 * Bump this whenever the IDE <-> Reasoner protocol changes in a breaking way.
 *
 * Unlike the URL constants above, this is NOT a deployment-target field —
 * it's tied to the IDE source revision, so a constant is the right shape.
 */
export const CHIPOS_REASONER_VERSION = '0.1.0';
