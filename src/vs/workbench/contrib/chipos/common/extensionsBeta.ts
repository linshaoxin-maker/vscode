/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * FEAT-006c — `chipos.extensions.beta` controlled-rollout gate.
 *
 * A master kill-switch for the whole extension/capability system (rules,
 * commands, skills, hooks, subagents, plugins, and the prompt-resource
 * injection that feeds them to the reasoner). Default ON — turning it off
 * returns the IDE to the pre-extension baseline with no residual state: the
 * settings tabs hide and the per-turn injection stops (the collector emits
 * nothing), so the reasoner sees a vanilla prompt again.
 */

export const EXTENSIONS_BETA_KEY = 'chipos.extensions.beta';

/** The extension system is ON unless explicitly set to `false` (default true). */
export function isExtensionSystemEnabled(betaSetting: unknown): boolean {
	return betaSetting !== false;
}

/**
 * Settings-tab ids contributed by the extension system — hidden when the beta
 * gate is off. Baseline IDE tabs (general/models/features/connection/beta/
 * tools/eda) stay visible so the editor still works at the baseline.
 */
export const EXTENSION_SYSTEM_TAB_IDS: readonly string[] = ['rules', 'commands', 'skills', 'hooks', 'agents', 'plugins'];

/** Filter the settings nav down to baseline tabs when the extension system is off. */
export function visibleSettingsTabs(allTabIds: readonly string[], extensionSystemEnabled: boolean): string[] {
	if (extensionSystemEnabled) {
		return [...allTabIds];
	}
	const hidden = new Set(EXTENSION_SYSTEM_TAB_IDS);
	return allTabIds.filter(id => !hidden.has(id));
}
