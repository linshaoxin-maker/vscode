/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * ChipOS Release 配置 — 所有下载地址的唯一来源。
 *
 * 修改发布仓库时，只需改这一个文件。
 *
 * 涉及的下载场景：
 *   1. IDE 本地下载 Worker 二进制（downloadWorkerBinary.ts）
 *   2. 远端服务器自动 curl 下载 Worker 二进制（workerManager.ts）
 *   3. REH 下载地址由 product.json 的 updateUrl 字段控制（download.ts）
 */

/** Worker 和 REH 产物发布的 GitHub 仓库，格式：owner/repo */
export const CHIPOS_RELEASE_REPO = 'linshaoxin-maker/chipos-releases';

/** GitHub Releases 下载基础 URL */
export const CHIPOS_RELEASE_BASE_URL = `https://github.com/${CHIPOS_RELEASE_REPO}/releases/download`;

/** GitHub API — 查询最新 Release */
export const CHIPOS_RELEASE_API_URL = `https://api.github.com/repos/${CHIPOS_RELEASE_REPO}/releases/latest`;
