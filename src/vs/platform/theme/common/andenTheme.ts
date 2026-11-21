/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService, IConfigurationValue } from '../../configuration/common/configuration.js';

export const ANDEN_DARK_THEME = 'Anden Dark';
export const ANDEN_LIGHT_THEME = 'Anden Light';

export const ANDEN_DARK_INITIAL_COLORS = {
	'editor.background': '#100D14',
	'foreground': '#FFFFFF',
	'sideBar.background': '#17131D',
};

export const ANDEN_LIGHT_INITIAL_COLORS = {
	'editor.background': '#FBF8FF',
	'foreground': '#1B0140',
	'sideBar.background': '#F5EFFA',
};

function hasExplicitValue<T>(setting: IConfigurationValue<T>): boolean {
	return [setting.policyValue, setting.applicationValue, setting.userValue, setting.workspaceValue, setting.workspaceFolderValue, setting.memoryValue].some(value => value !== undefined);
}

export function isAndenAutoDetectColorScheme(configuration: IConfigurationService): boolean {
	const detect = configuration.inspect<boolean>('window.autoDetectColorScheme');
	if (hasExplicitValue(detect)) {
		return detect.value === true;
	}
	// Enable system appearance by default, but keep an existing manual theme choice.
	return !hasExplicitValue(configuration.inspect('workbench.colorTheme'));
}
