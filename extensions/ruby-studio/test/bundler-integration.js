/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root.
 *--------------------------------------------------------------------------------------------*/
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, limit = 45000) { const end = Date.now() + limit; while (Date.now() < end) { const value = await fn(); if (value) { return value; } await delay(100); } throw new Error(`${label} timed out`); }
exports.run = async () => {
	const report = { suite: 'Effective Bundler Configuration Native Extension Host', success: false, checks: [] };
	const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
	const external = process.env.RUBY_STUDIO_BUNDLER_FIXTURE;
	try {
		await vscode.extensions.getExtension('ruby-studio.ruby-studio').activate();
		const state = async () => (await vscode.commands.executeCommand('rubyStudio.getProjectEnvironments')).find(item => item.root === root);
		const waitReady = generation => until(async () => { const item = await state(); return item?.bundle === 'ready' && item.generation > generation && item; }, 'Resolved effective environment');
		let current = await waitReady(0);
		const gemfile = path.join(external, 'Custom Gemfile'); const lockfile = gemfile + '.lock'; const userConfig = path.join(external, 'new-user/config');
		assert.ok(current.configurationFiles.includes(gemfile) && current.configurationFiles.includes(lockfile) && current.configurationFiles.includes(userConfig));
		assert.ok(current.dependencies.some(item => item.name === 'optional_fixture'));
		report.checks.push({ name: 'Selected-runtime custom Gemfile overrides an unrelated unavailable workspace Bundler', status: 'passed' });
		const original = await fs.readFile(gemfile, 'utf8');
		await fs.writeFile(gemfile + '.new', original.replace('dependency', 'replacement'));
		await fs.rename(gemfile + '.new', gemfile);
		current = await waitReady(current.generation);
		assert.equal(current.dependencies.find(item => item.name === 'lifecycle_fixture').requireRoots[0], path.join(external, 'replacement/lib'));
		await vscode.commands.executeCommand('rubyStudio.rebuildIndex');
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'main.rb')));
		const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, new vscode.Position(0, 3));
		assert.ok(definitions.some(item => (item.uri || item.targetUri).fsPath === path.join(external, 'replacement/lib/lifecycle_fixture.rb')));
		report.checks.push({ name: 'Atomic external Gemfile replacement refreshes dependency navigation automatically', status: 'passed' });
		const lock = await fs.readFile(lockfile, 'utf8');
		await fs.writeFile(lockfile, lock + '\nBUNDLED WITH\n   99.99.99\n');
		current = await until(async () => { const item = await state(); return item?.bundle === 'missing-bundler' && item.generation > current.generation && item; }, 'Missing Bundler after external lock edit');
		await fs.writeFile(lockfile + '.new', lock); await fs.rename(lockfile + '.new', lockfile);
		current = await waitReady(current.generation);
		report.checks.push({ name: 'External lockfile changes report unavailable Bundler and recover without manual refresh', status: 'passed' });
		await fs.mkdir(path.dirname(userConfig), { recursive: true });
		await fs.writeFile(userConfig, '---\nBUNDLE_WITHOUT: "optional"\nBUNDLE_RUBYGEMS__ORG: "private-token-for-test"\n');
		current = await waitReady(current.generation);
		assert.ok(!current.dependencies.some(item => item.name === 'optional_fixture'));
		assert.ok(!JSON.stringify(current).includes('private-token-for-test'));
		report.checks.push({ name: 'Creating previously absent external user config changes resolved groups without exposing values', status: 'passed' });
		await fs.unlink(userConfig); current = await waitReady(current.generation);
		assert.ok(current.dependencies.some(item => item.name === 'optional_fixture'));
		report.checks.push({ name: 'Deleting external user config restores dependencies automatically', status: 'passed' });
		report.success = true;
	} catch (error) { report.error = error.stack; report.environments = await vscode.commands.executeCommand('rubyStudio.getProjectEnvironments'); throw error; }
	finally { await fs.writeFile(process.env.RUBY_STUDIO_BUNDLER_RESULT, JSON.stringify(report, null, 2)); }
};
