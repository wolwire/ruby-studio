/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type SettingValue = string | number | boolean | null;
export interface SettingField {
	key: string; section: string; label: string; type: 'string' | 'number' | 'boolean' | 'select'; options?: string[]; min?: number; max?: number; language?: 'ruby';
}

/** Only these configuration keys can be changed by the settings window. */
export const settingFields: SettingField[] = [
	{ key: 'workbench.colorTheme', section: 'appearance', label: 'Color Theme', type: 'string' },
	{ key: 'window.zoomLevel', section: 'appearance', label: 'UI Zoom Level', type: 'number', min: -8, max: 8 },
	{ key: 'workbench.sideBar.location', section: 'appearance', label: 'Tool Window Position', type: 'select', options: ['left', 'right'] },
	{ key: 'editor.fontFamily', section: 'editor', label: 'Font Family', type: 'string' },
	{ key: 'editor.fontSize', section: 'editor', label: 'Font Size', type: 'number', min: 6, max: 100 },
	{ key: 'editor.tabSize', section: 'editor', label: 'Ruby Indent Size', type: 'number', min: 1, max: 16, language: 'ruby' },
	{ key: 'editor.insertSpaces', section: 'editor', label: 'Use Spaces for Ruby Indentation', type: 'boolean', language: 'ruby' },
	{ key: 'editor.formatOnSave', section: 'editor', label: 'Format on Save', type: 'boolean' },
	{ key: 'editor.minimap.enabled', section: 'editor', label: 'Show Minimap', type: 'boolean' },
	{ key: 'files.autoSave', section: 'editor', label: 'Auto Save', type: 'select', options: ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'] },
	{ key: 'rubyStudio.interpreterPath', section: 'sdk', label: 'Ruby Executable', type: 'string' },
	{ key: 'rubyStudio.syntaxCheck', section: 'language', label: 'Check Ruby Syntax', type: 'boolean' },
	{ key: 'rubyStudio.languageDiagnostics', section: 'language', label: 'Ruby Inspections', type: 'boolean' },
	{ key: 'rubyStudio.language.enabled', section: 'language', label: 'Built-in Ruby Language Service', type: 'boolean' },
	{ key: 'rubyStudio.maxIndexedFiles', section: 'language', label: 'Maximum Indexed Files', type: 'number', min: 1, max: 10000 },
];

/** Validate the entire draft before changing any configuration. Null means inherit. */
export function validateSettingsDraft(draft: Record<string, SettingValue>): void {
	if (!draft || typeof draft !== 'object' || Array.isArray(draft)) { throw new Error('Expected a settings draft.'); }
	for (const [key, value] of Object.entries(draft)) {
		const field = settingFields.find(field => field.key === key);
		if (!field) { throw new Error(`Unsupported setting: ${key}`); }
		if (value === null) { continue; }
		if (field.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) || value < field.min! || value > field.max! : field.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string' || value.includes('\0') || value.length > 4096) { throw new Error(`Invalid value for ${field.label}.`); }
		if (field.options && !field.options.includes(String(value))) { throw new Error(`Choose a supported ${field.label}.`); }
	}
}
