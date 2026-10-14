/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

class DatabaseItem extends vscode.TreeItem {
	constructor(label: string, readonly kind: 'database' | 'table' | 'column', readonly file: string, readonly table?: string) {
		super(label, kind === 'column' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
		this.iconPath = new vscode.ThemeIcon(kind === 'database' ? 'database' : kind === 'table' ? 'table' : 'symbol-field');
		if (kind === 'table') { this.command = { command: 'rubyStudio.queryDatabase', title: vscode.l10n.t('View Table'), arguments: [this] }; }
	}
}

function quoteIdentifier(name: string): string { return `"${name.replace(/"/g, '""')}"`; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!)); }

interface DatabaseQueryTarget { file: string; table?: string }

class DatabaseTree implements vscode.TreeDataProvider<DatabaseItem>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<DatabaseItem | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	constructor(private readonly context: vscode.ExtensionContext) { }
	dispose(): void { this.changed.dispose(); }
	refresh(): void { this.changed.fire(undefined); }
	getTreeItem(item: DatabaseItem): DatabaseItem { return item; }
	getChildren(item?: DatabaseItem): DatabaseItem[] {
		if (!vscode.workspace.isTrusted) { return []; }
		if (!item) { return this.context.workspaceState.get<string[]>('rubyStudio.databases', []).map(file => new DatabaseItem(path.basename(file), 'database', file)); }
		const database = new DatabaseSync(item.file, { readOnly: true, allowExtension: false });
		try {
			if (item.kind === 'database') {
				return database.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => new DatabaseItem(String(row.name), 'table', item.file, String(row.name)));
			}
			if (item.kind === 'table') {
				return database.prepare(`PRAGMA table_info(${quoteIdentifier(item.table!)})`).all().map(row => new DatabaseItem(`${row.name} : ${row.type}${row.pk ? ' (PK)' : ''}`, 'column', item.file));
			}
			return [];
		} finally { database.close(); }
	}
}

/** Provides an original read-only SQLite schema browser and bounded results grid. */
export function registerDatabase(context: vscode.ExtensionContext): vscode.Disposable[] {
	const tree = new DatabaseTree(context);
	const disposables: vscode.Disposable[] = [tree, vscode.window.registerTreeDataProvider('rubyStudio.database', tree)];
	const panels = new Map<vscode.WebviewPanel, vscode.Disposable>();
	disposables.push({ dispose: () => {
		const current = [...panels.entries()]; panels.clear();
		for (const [panel, listener] of current) { listener.dispose(); panel.dispose(); }
	} });
	disposables.push(vscode.commands.registerCommand('rubyStudio.openDatabase', async (uri?: vscode.Uri) => {
		if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before opening a database.')); return undefined; }
		const files = uri ? [uri] : await vscode.window.showOpenDialog({ canSelectMany: false, filters: { SQLite: ['sqlite', 'sqlite3', 'db'], All: ['*'] }, openLabel: vscode.l10n.t('Open SQLite Database') });
		if (!files?.length) { return undefined; }
		try {
			if (files[0].scheme !== 'file') { throw new Error(vscode.l10n.t('Choose a local SQLite database file.')); }
			const database = new DatabaseSync(files[0].fsPath, { readOnly: true, allowExtension: false });
			try { database.prepare('SELECT name FROM sqlite_schema LIMIT 1').all(); } finally { database.close(); }
			const saved = context.workspaceState.get<string[]>('rubyStudio.databases', []);
			await context.workspaceState.update('rubyStudio.databases', [...new Set([...saved, files[0].fsPath])]);
			tree.refresh();
			return files[0];
		} catch (error) { void vscode.window.showErrorMessage(vscode.l10n.t('Database: {0}', error instanceof Error ? error.message : String(error))); return undefined; }
	}), vscode.commands.registerCommand('rubyStudio.refreshDatabase', () => tree.refresh()), vscode.commands.registerCommand('rubyStudio.queryDatabase', async (item?: DatabaseQueryTarget) => {
		if (!vscode.workspace.isTrusted) { return undefined; }
		try {
			const file = item?.file || await vscode.window.showQuickPick(context.workspaceState.get<string[]>('rubyStudio.databases', []), { placeHolder: vscode.l10n.t('Select SQLite Database') });
			if (!file) { void vscode.window.showInformationMessage(vscode.l10n.t('Open a SQLite database from the Database view first.')); return undefined; }
			const editor = vscode.window.activeTextEditor;
			const selected = editor?.document.languageId === 'sql' ? editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection) : undefined;
			const sql = item?.table ? `SELECT * FROM ${quoteIdentifier(item.table)} LIMIT 501` : selected || await vscode.window.showInputBox({ prompt: vscode.l10n.t('Read-Only SQL Query'), value: 'SELECT name FROM sqlite_schema' });
			if (!sql) { return undefined; }
			const database = new DatabaseSync(file, { readOnly: true, allowExtension: false });
			let rows: Record<string, string>[] = [];
			let columns: string[] = [];
			let truncated = false;
			try {
				const statement = database.prepare(sql);
				statement.setReadBigInts(true);
				columns = statement.columns().map(column => column.name);
				for (const row of statement.iterate()) {
					if (rows.length === 500) { truncated = true; break; }
					rows.push(Object.fromEntries(columns.map(column => [column, row[column] instanceof Uint8Array ? `<${row[column].byteLength} bytes>` : row[column] === null ? 'NULL' : String(row[column])])));
				}
			} finally { database.close(); }
			const panel = vscode.window.createWebviewPanel('rubyStudio.results', vscode.l10n.t('SQL Results — {0}', path.basename(file)), vscode.ViewColumn.Beside, { enableScripts: false });
			const listener = panel.onDidDispose(() => { panels.delete(panel); listener.dispose(); });
			panels.set(panel, listener);
			const status = truncated ? vscode.l10n.t('{0} rows (limited to 500) · Read-only connection', rows.length) : vscode.l10n.t('{0} rows · Read-only connection', rows.length);
			panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px}table{border-collapse:collapse;font-family:var(--vscode-editor-font-family)}th,td{padding:8px 14px;border:1px solid var(--vscode-panel-border);text-align:left;white-space:pre-wrap}th{background:var(--vscode-sideBar-background)}pre{white-space:pre-wrap;color:var(--vscode-descriptionForeground)}</style></head><body><h2>${escapeHtml(path.basename(file))}</h2><pre>${escapeHtml(sql)}</pre><p>${escapeHtml(status)}</p><table><thead><tr>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(column => `<td>${escapeHtml(row[column])}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
			return { columns, rows, truncated, readOnly: true as const };
		} catch (error) {
			void vscode.window.showErrorMessage(vscode.l10n.t('SQL Query: {0}', error instanceof Error ? error.message : String(error)));
			if (item && !(item instanceof DatabaseItem)) { throw error; }
			return undefined;
		}
	}), vscode.workspace.onDidGrantWorkspaceTrust(() => tree.refresh()));
	return disposables;
}
