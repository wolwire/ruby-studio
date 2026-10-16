/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root.
 *--------------------------------------------------------------------------------------------*/
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { const end = Date.now() + 60000; while (Date.now() < end) { const result = await fn(); if (result) { return result; } await delay(100); } throw new Error(`${label} timed out`); }
exports.run = async () => {
	const report = { suite: 'Stage 2 Native Ruby Navigation', success: false, checks: [] };
	const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
	const base = 'module Billing\n  class Base\n    # Creates an invoice.\n    # @param [Integer] amount invoice amount\n    def initialize(amount, tax: 0, discount: 0)\n    end\n    # Calculates a total.\n    def total(amount, tax: 0, discount: 0)\n      amount + tax - discount\n    end\n  end\nend\n';
	const invoice = 'module Billing\n  class Invoice < Base\n    def total(amount, tax: 0, discount: 0)\n      super(amount, tax: tax, discount: discount)\n    end\n    def calculate\n      value = 1\n      value += 2\n      total(value, discount: 3, tax: 4)\n      total(value)\n    end\n  end\nend\nBilling::Invoice.new(1, tax: 2, )\n';
	const check = async (name, fn) => { await fn(); report.checks.push({ name, status: 'passed' }); };
	try {
		await fs.writeFile(path.join(root, 'base.rb'), base); await fs.writeFile(path.join(root, 'invoice.rb'), invoice);
		await vscode.extensions.getExtension('ruby-studio.ruby-studio').activate();
		await until(async () => (await vscode.commands.executeCommand('rubyStudio.getProjectEnvironments')).some(state => state.root === root && ['none', 'ready'].includes(state.bundle) && ['ready', 'mismatch'].includes(state.sdk)), 'Project environment');
		const baseUri = vscode.Uri.file(path.join(root, 'base.rb'));
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'invoice.rb')));
		await vscode.commands.executeCommand('rubyStudio.rebuildIndex');
		await check('Native type hierarchy follows the explicit parent and child across files', async () => {
			const types = await vscode.commands.executeCommand('vscode.prepareTypeHierarchy', document.uri, document.positionAt(invoice.indexOf('Invoice')));
			const parents = await vscode.commands.executeCommand('vscode.provideSupertypes', types[0]);
			await vscode.window.showTextDocument(baseUri);
			await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', baseUri);
			const children = await vscode.commands.executeCommand('vscode.provideSubtypes', parents[0]);
			assert.deepEqual([parents.map(item => item.name), children.map(item => item.name)], [['Billing::Base'], ['Billing::Invoice']]);
		});
		await check('Native call hierarchy groups repeated calls and resolves super to its parent method', async () => {
			const methods = await vscode.commands.executeCommand('vscode.prepareCallHierarchy', document.uri, document.positionAt(invoice.indexOf('calculate')));
			const outgoing = await vscode.commands.executeCommand('vscode.provideOutgoingCalls', methods[0]);
			assert.deepEqual(outgoing.map(call => [call.to.name, call.fromRanges.length]), [['Billing::Invoice#total', 2]]);
			const incoming = await vscode.commands.executeCommand('vscode.provideIncomingCalls', outgoing[0].to);
			assert.ok(incoming.some(call => call.from.name === 'Billing::Invoice#calculate' && call.fromRanges.length === 2));
			const supers = await vscode.commands.executeCommand('vscode.provideOutgoingCalls', outgoing[0].to);
			assert.equal(supers[0].to.name, 'Billing::Base#total');
		});
		await check('Native document highlights distinguish assignments from reads', async () => {
			const highlights = await vscode.commands.executeCommand('vscode.executeDocumentHighlights', document.uri, document.positionAt(invoice.indexOf('value =')));
			assert.deepEqual(highlights.map(item => item.kind), [vscode.DocumentHighlightKind.Write, vscode.DocumentHighlightKind.Write, vscode.DocumentHighlightKind.Read, vscode.DocumentHighlightKind.Read]);
		});
		await check('Constructor keyword completion excludes already supplied arguments', async () => {
			const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, document.positionAt(invoice.lastIndexOf(')')));
			assert.ok(result.items.some(item => item.label === 'discount:'));
			assert.ok(!result.items.some(item => item.label === 'tax:'));
			const replacing = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, document.positionAt(invoice.lastIndexOf('tax: 2') + 2));
			assert.equal(replacing.items.find(item => item.label === 'tax:').insertText, 'tax');
		});
		await check('Native parameter info tracks out-of-order keyword arguments', async () => {
			const help = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', document.uri, document.positionAt(invoice.indexOf('tax: 4') + 6), ':');
			assert.equal(help.activeParameter, 1); assert.equal(help.signatures[0].parameters[1].label, 'tax: 0');
		});
		await check('Go to Ruby Super navigates from the overriding method to its parent declaration', async () => {
			const editor = await vscode.window.showTextDocument(document); editor.selection = new vscode.Selection(document.positionAt(invoice.indexOf('def total') + 4), document.positionAt(invoice.indexOf('def total') + 4));
			await vscode.commands.executeCommand('rubyStudio.gotoSuper');
			assert.deepEqual([vscode.window.activeTextEditor.document.uri.fsPath, vscode.window.activeTextEditor.selection.start.line], [baseUri.fsPath, 7]);
		});
		await check('Qualified namespace completion exposes direct members', async () => {
			const change = new vscode.WorkspaceEdit(); change.insert(document.uri, document.positionAt(document.getText().length), '\nBilling::'); await vscode.workspace.applyEdit(change);
			const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, document.positionAt(document.getText().length));
			assert.ok(result.items.some(item => item.label === 'Invoice')); assert.ok(result.items.some(item => item.label === 'Base')); assert.ok(!result.items.some(item => item.label === 'initialize'));
			const absolute = new vscode.WorkspaceEdit(); absolute.insert(document.uri, document.positionAt(document.getText().length), '\nBilling\n::'); await vscode.workspace.applyEdit(absolute);
			const global = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, document.positionAt(document.getText().length));
			assert.ok(global.items.some(item => item.label === 'Billing')); assert.ok(!global.items.some(item => item.label === 'Invoice'));
		});
		await check('Edits invalidate existing hierarchy sessions instead of using stale declaration offsets', async () => {
			const types = await vscode.commands.executeCommand('vscode.prepareTypeHierarchy', document.uri, document.positionAt(document.getText().indexOf('Invoice')));
			const change = new vscode.WorkspaceEdit(); change.insert(document.uri, new vscode.Position(0, 0), '# shifted declarations\n'); await vscode.workspace.applyEdit(change);
			await vscode.commands.executeCommand('rubyStudio.rebuildIndex');
			assert.deepEqual(await vscode.commands.executeCommand('vscode.provideSupertypes', types[0]), []);
		});
		report.success = true;
	} catch (error) { report.error = error.stack; throw error; }
	finally { await fs.writeFile(process.env.RUBY_STUDIO_NAVIGATION_RESULT, JSON.stringify(report, null, 2)); }
};
