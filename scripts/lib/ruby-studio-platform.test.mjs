/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { target, appLayout } from './ruby-studio-platform.mjs';

test('native packages use the platform-specific executable, worker and bundle layout', () => {
	const product = { nameShort: 'Ruby Studio', nameLong: 'Ruby Studio', applicationName: 'ruby-studio' };
	const app = path.resolve('fixture with spaces');
	const cases = [['linux', 'x64', 'ruby-studio', 'resources/app', 'ruby-studio-lexer'], ['win32', 'x64', 'Ruby Studio.exe', 'resources/app', 'ruby-studio-lexer.exe'], ['darwin', 'x64', 'Ruby Studio.app/Contents/MacOS/Ruby Studio', 'Ruby Studio.app/Contents/Resources/app', 'ruby-studio-lexer'], ['darwin', 'arm64', 'Ruby Studio.app/Contents/MacOS/Ruby Studio', 'Ruby Studio.app/Contents/Resources/app', 'ruby-studio-lexer']];
	assert.deepEqual(cases.map(([platform, arch]) => {
		const layout = appLayout(app, product, platform);
		return [platform, arch, path.relative(app, layout.executable).split(path.sep).join('/'), path.relative(app, layout.resources).split(path.sep).join('/'), target(platform, arch).worker];
	}), cases);
});

test('unsupported architectures fail before an incorrect native package can be produced', () => {
	for (const [platform, arch] of [['win32', 'arm64'], ['linux', 'arm64'], ['darwin', 'ia32']]) { assert.throws(() => target(platform, arch), /Unsupported native build target/); }
});
