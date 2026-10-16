/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root.
 *--------------------------------------------------------------------------------------------*/
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, limit = 60000) { const end = Date.now() + limit; while (Date.now() < end) { const value = await fn(); if (value) { return value; } await delay(100); } throw new Error(`${label} timed out`); }
exports.run = async () => {
	const report = { suite: 'Project Environment Native Extension Host', success: false, checks: [] };
	const folder = vscode.workspace.workspaceFolders[0]; const root = folder.uri.fsPath;
	try {
		await vscode.extensions.getExtension('ruby-studio.ruby-studio').activate();
		const state = async () => (await vscode.commands.executeCommand('rubyStudio.getProjectEnvironments')).find(item => item.root === root);
		if (!vscode.workspace.isTrusted) {
			await until(async () => (await state())?.sdk === 'restricted', 'Restricted environment');
			await assert.rejects(fs.access(path.join(root, 'wrapper-executed')), { code: 'ENOENT' });
			const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, 'main.rb'));
			assert.ok((await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri)).length);
			report.checks.push({ name: 'Restricted project permits static symbols without executing its selected wrapper', status: 'passed' });
		} else {
			const environment = await until(async () => { const item = await state(); return item?.bundle === 'ready' && item; }, 'Resolved project libraries');
			await vscode.commands.executeCommand('rubyStudio.rebuildIndex');
			report.index = (await state()).index;
			assert.equal(environment.runtime.manager, 'selected'); assert.ok(environment.dependencies.some(item => item.name === 'lifecycle_fixture' && item.source === 'path'));
			report.checks.push({ name: 'Opening resolves the explicitly selected SDK and actual local dependency sources', status: 'passed' });
			const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, 'main.rb'));
			const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, document.positionAt(document.getText().indexOf('LifecycleFixture') + 2));
			assert.ok(definitions.some(item => (item.uri || item.targetUri).fsPath === path.join(root, 'vendor/gems/lifecycle_fixture/lib/lifecycle_fixture.rb')));
			report.checks.push({ name: 'Definition provider reaches an indexed dependency excluded from the ordinary workspace scan', status: 'passed' });
			await fs.writeFile(path.join(root, '.ruby-version'), '0.0.1');
			const changed = await until(async () => { const item = await state(); return item?.sdk === 'mismatch' && item.generation > environment.generation && item; }, 'External version-file refresh');
			assert.equal(changed.runtime.ruby, environment.runtime.ruby);
			report.checks.push({ name: 'External version-file edits refresh and report mismatch while preserving the explicit SDK', status: 'passed' });
		}
		report.success = true;
	} catch (error) { report.error = error.stack; report.environments = await vscode.commands.executeCommand('rubyStudio.getProjectEnvironments'); throw error; }
	finally { await fs.writeFile(process.env.RUBY_STUDIO_PROJECT_INTEGRATION_RESULT, JSON.stringify(report, null, 2)); }
};
