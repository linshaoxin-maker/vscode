/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';

export type ChipOSSettingsTab = 'general' | 'models' | 'features' | 'connection' | 'rules' | 'beta' | 'tools' | 'edaTools';

export interface IChipOSSettingsEditorOptions {
	readonly initialTab?: ChipOSSettingsTab;
}

export class ChipOSSettingsEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.chiposSettings';

	readonly resource = URI.from({ scheme: 'chipos-settings', authority: 'settings' });

	override get typeId(): string {
		return ChipOSSettingsEditorInput.ID;
	}

	override getName(): string {
		return localize('chiposSettings', 'ChipOS Settings');
	}

	override getIcon(): ThemeIcon {
		return Codicon.gear;
	}

	override matches(other: unknown): boolean {
		return other instanceof ChipOSSettingsEditorInput;
	}

	override dispose(): void {
		super.dispose();
	}
}
