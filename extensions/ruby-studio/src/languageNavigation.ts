/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as path from 'node:path';
import { RubyDocument, RubyIndex, RubySymbol } from './languageModel';

interface NavigationService {
	readonly index: RubyIndex;
	enabled(document?: vscode.TextDocument): boolean;
	ensure(document: vscode.TextDocument): Promise<RubyDocument | undefined>;
	ready(): Promise<void>;
}
interface HierarchyContext { uri: string; symbol?: RubySymbol; project: string; revision: number }

function position(document: RubyDocument, offset: number): vscode.Position {
	const before = document.text.slice(0, offset);
	return new vscode.Position(before.split('\n').length - 1, offset - before.lastIndexOf('\n') - 1);
}
function sourceRange(document: RubyDocument, start: number, end: number): vscode.Range { return new vscode.Range(position(document, start), position(document, end)); }

/** Native read/write highlights, type/call hierarchy, and Go to Super share the same static index. */
export function registerRubyNavigation(service: NavigationService, selector: vscode.DocumentSelector): vscode.Disposable[] {
	// VS Code retains original hierarchy items for the lifetime of each hierarchy session.
	// Carry the initiating environment on that item, including for shared dependency files.
	const contexts = new WeakMap<vscode.TypeHierarchyItem | vscode.CallHierarchyItem, HierarchyContext>();
	const context = (item: vscode.TypeHierarchyItem | vscode.CallHierarchyItem): HierarchyContext | undefined => {
		const entry = contexts.get(item);
		return service.enabled() && entry?.revision === service.index.revision ? entry : undefined;
	};
	const typeItem = (symbol: RubySymbol, project: string): vscode.TypeHierarchyItem => {
		const model = service.index.documents.get(symbol.uri)!;
		const item = new vscode.TypeHierarchyItem(symbol.kind === 'module' ? vscode.SymbolKind.Module : vscode.SymbolKind.Class, symbol.qualifiedName, vscode.l10n.t('Ruby · Explicit Inheritance'), vscode.Uri.parse(symbol.uri), sourceRange(model, symbol.bodyStart, symbol.bodyEnd), sourceRange(model, symbol.start, symbol.end));
		contexts.set(item, { uri: symbol.uri, symbol, project, revision: service.index.revision }); return item;
	};
	const callItem = (uri: string, symbol: RubySymbol | undefined, project: string): vscode.CallHierarchyItem => {
		const model = service.index.documents.get(uri)!;
		const item = new vscode.CallHierarchyItem(symbol ? vscode.SymbolKind.Method : vscode.SymbolKind.File, symbol?.qualifiedName || path.basename(vscode.Uri.parse(uri).fsPath), vscode.l10n.t('Ruby · Statically Resolved Calls'), vscode.Uri.parse(uri), sourceRange(model, symbol?.bodyStart || 0, symbol?.bodyEnd ?? model.text.length), sourceRange(model, symbol?.start || 0, symbol?.end || 0));
		contexts.set(item, { uri, symbol, project, revision: service.index.revision }); return item;
	};
	return [
		vscode.languages.registerDocumentHighlightProvider(selector, {
			async provideDocumentHighlights(document, caret, token) {
				if (!await service.ensure(document) || token.isCancellationRequested) { return []; }
				const symbols = service.index.resolve(document.uri.toString(), document.offsetAt(caret))?.definitions || [];
				const references = [...new Map(symbols.flatMap(symbol => service.index.references(symbol)).filter(reference => reference.uri === document.uri.toString()).map(reference => [reference.start, reference])).values()];
				return references.map(reference => new vscode.DocumentHighlight(new vscode.Range(document.positionAt(reference.start), document.positionAt(reference.end)), reference.write ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read));
			}
		}),
		vscode.languages.registerTypeHierarchyProvider(selector, {
			async prepareTypeHierarchy(document, caret, token) {
				const model = await service.ensure(document); if (!model || token.isCancellationRequested) { return []; }
				return (service.index.resolve(model.uri, document.offsetAt(caret))?.definitions || []).filter(symbol => ['class', 'module'].includes(symbol.kind)).map(symbol => typeItem(symbol, model.project));
			},
			async provideTypeHierarchySupertypes(item, token) {
				await service.ready(); const entry = context(item); if (!entry?.symbol || token.isCancellationRequested) { return []; }
				return service.index.supertypes(entry.symbol, entry.project).map(symbol => typeItem(symbol, entry.project));
			},
			async provideTypeHierarchySubtypes(item, token) {
				await service.ready(); const entry = context(item); if (!entry?.symbol || token.isCancellationRequested) { return []; }
				return service.index.subtypes(entry.symbol, entry.project).map(symbol => typeItem(symbol, entry.project));
			}
		}),
		vscode.languages.registerCallHierarchyProvider(selector, {
			async prepareCallHierarchy(document, caret, token) {
				const model = await service.ensure(document); if (!model || token.isCancellationRequested) { return []; }
				return (service.index.resolve(model.uri, document.offsetAt(caret))?.definitions || []).filter(symbol => symbol.kind === 'method').map(symbol => callItem(symbol.uri, symbol, model.project));
			},
			async provideCallHierarchyIncomingCalls(item, token) {
				await service.ready(); const entry = context(item); if (!entry?.symbol || token.isCancellationRequested) { return []; }
				const grouped = new Map<string, { uri: string; caller?: RubySymbol; ranges: vscode.Range[] }>();
				for (const site of service.index.incomingCalls(entry.symbol, entry.project)) {
					const key = site.caller?.id || site.uri; const group = grouped.get(key) || { uri: site.uri, caller: site.caller, ranges: [] };
					group.ranges.push(sourceRange(service.index.documents.get(site.uri)!, site.start, site.end)); grouped.set(key, group);
				}
				return [...grouped.values()].map(group => new vscode.CallHierarchyIncomingCall(callItem(group.uri, group.caller, entry.project), group.ranges));
			},
			async provideCallHierarchyOutgoingCalls(item, token) {
				await service.ready(); const entry = context(item); if (!entry || token.isCancellationRequested) { return []; }
				const grouped = new Map<string, { target: RubySymbol; ranges: vscode.Range[] }>();
				for (const site of service.index.outgoingCalls(entry.uri, entry.symbol, entry.project)) {
					const group = grouped.get(site.target.id) || { target: site.target, ranges: [] };
					group.ranges.push(sourceRange(service.index.documents.get(site.uri)!, site.start, site.end)); grouped.set(site.target.id, group);
				}
				return [...grouped.values()].map(group => new vscode.CallHierarchyOutgoingCall(callItem(group.target.uri, group.target, entry.project), group.ranges));
			}
		}),
		vscode.commands.registerCommand('rubyStudio.gotoSuper', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !await service.ensure(editor.document)) { return; }
			const targets = service.index.superDeclarations(editor.document.uri.toString(), editor.document.offsetAt(editor.selection.active));
			if (!targets.length) { void vscode.window.showInformationMessage(vscode.l10n.t('No Explicit Ruby Super Declaration Found.')); return; }
			const chosen = targets.length === 1 ? targets[0] : (await vscode.window.showQuickPick(targets.map(symbol => ({ label: symbol.qualifiedName, description: vscode.workspace.asRelativePath(vscode.Uri.parse(symbol.uri)), symbol })), { placeHolder: vscode.l10n.t('Choose Ruby Super Declaration') }))?.symbol;
			if (!chosen) { return; }
			const target = await vscode.workspace.openTextDocument(vscode.Uri.parse(chosen.uri));
			await vscode.window.showTextDocument(target, { selection: new vscode.Range(target.positionAt(chosen.start), target.positionAt(chosen.end)) });
		})
	];
}
