/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { target, appLayout, readApp } from './ruby-studio-platform.mjs';

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

test('artifact verification accepts relative paths and rejects missing packaged entry points', t => {
	const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-studio-artifact-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const product = { nameShort: 'Ruby Studio', nameLong: 'Ruby Studio', applicationName: 'ruby-studio' };
	const layout = appLayout(directory, product);
	const extension = path.join(layout.resources, 'extensions/ruby-studio');
	const host = target();
	const worker = path.join(extension, 'native/bin', host.id, host.worker);
	fs.mkdirSync(path.dirname(worker), { recursive: true });
	fs.mkdirSync(path.dirname(layout.executable), { recursive: true });
	fs.writeFileSync(layout.executable, '', { mode: 0o755 });
	fs.writeFileSync(path.join(layout.resources, 'product.json'), JSON.stringify(product));
	fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ main: './extension.js', version: 'fixture' }));
	fs.writeFileSync(path.join(extension, 'extension.js'), '');
	// Use the actual worker: verification must reject a stale/wrong worker hash.
	fs.copyFileSync(path.join(source, 'extensions/ruby-studio/native/bin', host.id, host.worker), worker);
	assert.deepEqual(readApp(directory).resources, layout.resources);
	const args = [path.join(source, 'scripts/lib/ruby-studio-artifact.mjs'), 'verify', path.relative(source, directory)];
	assert.match(execFileSync(process.execPath, args, { cwd: source, encoding: 'utf8' }), /Verified/);
	fs.rmSync(path.join(extension, 'extension.js'));
	const rejected = spawnSync(process.execPath, args, { cwd: source, encoding: 'utf8' });
	assert.deepEqual({ status: rejected.status, error: /entry point is missing/.test(rejected.stderr) }, { status: 1, error: true });
});
