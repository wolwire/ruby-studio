/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSettingsDraft } = require('../out/settingsModel');

test('settings drafts allow explicit scopes to inherit and preserve paths as data', () => {
	assert.doesNotThrow(() => validateSettingsDraft({
		'rubyStudio.interpreterPath': "/project with spaces/ruby'$(literal)",
		'editor.fontSize': 16, 'rubyStudio.syntaxCheck': true, 'files.autoSave': 'onFocusChange', 'editor.tabSize': null
	}));
});
test('invalid settings drafts are rejected before any configuration is updated', () => {
	for (const draft of [null, [], { 'unrelated.secret': 'x' }, { 'editor.fontSize': NaN }, { 'editor.fontSize': 999 },
		{ 'editor.tabSize': 0 }, { 'rubyStudio.syntaxCheck': 'true' }, { 'files.autoSave': 'invalid' }, { 'rubyStudio.interpreterPath': 'a\0b' }]) {
		assert.throws(() => validateSettingsDraft(draft));
	}
});
