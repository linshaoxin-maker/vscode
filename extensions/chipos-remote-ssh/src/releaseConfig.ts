/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * ChipOS Release 配置（扩展侧副本）
 *
 * 修改发布仓库时，同步修改：
 *   1. 这个文件
 *   2. src/vs/workbench/contrib/chipos/common/releaseConfig.ts（IDE 主体侧）
 *   3. vscode/product.json 的 updateUrl 字段（REH 下载地址）
 */

/** Worker 和 REH 产物发布的 GitHub 仓库，格式：owner/repo */
export const CHIPOS_RELEASE_REPO = 'linshaoxin-maker/chipos-releases';

/** GitHub Releases 下载基础 URL */
export const CHIPOS_RELEASE_BASE_URL = `https://github.com/${CHIPOS_RELEASE_REPO}/releases/download`;

/** GitHub API — 查询最新 Release */
export const CHIPOS_RELEASE_API_URL = `https://api.github.com/repos/${CHIPOS_RELEASE_REPO}/releases/latest`;
