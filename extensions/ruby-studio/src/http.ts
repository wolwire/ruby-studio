/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { parseRequest } from './httpModel';

/** Executes the request block at the caret only after an explicit trusted command. */
export function registerHttp(): vscode.Disposable[] {
	return [vscode.commands.registerCommand('rubyStudio.sendRequest', async () => {
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before sending HTTP requests.'));
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor) { return; }
		try {
			const request = parseRequest(editor.document.getText(), editor.selection.active.line);
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('HTTP {0}', request.method), cancellable: true }, async (_, token) => {
				const abort = new AbortController();
				const cancellation = token.onCancellationRequested(() => abort.abort());
				const timeout = setTimeout(() => abort.abort(), 30000);
				try {
					const started = Date.now();
					const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: abort.signal, redirect: 'manual' });
					// Stream with a display limit instead of allocating an unbounded response.
					const reader = response.body?.getReader();
					const chunks: Uint8Array[] = [];
					let size = 0;
					let truncated = false;
					if (reader) {
						while (true) {
							const part = await reader.read();
							if (part.done) { break; }
							size += part.value.byteLength;
							if (size > 4 * 1024 * 1024) { truncated = true; await reader.cancel(); break; }
							chunks.push(part.value);
						}
					}
					const body = Buffer.concat(chunks).toString('utf8');
					const text = `HTTP ${response.status} ${response.statusText}\n${Array.from(response.headers, ([key, value]) => `${key}: ${value}`).join('\n')}\n\n${body}\n\n# ${Date.now() - started} ms${truncated ? ' — response truncated at 4 MiB' : ''}\n`;
					await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'http', content: text }), { viewColumn: vscode.ViewColumn.Beside, preview: true });
				} finally { clearTimeout(timeout); cancellation.dispose(); }
			});
		} catch (error) { void vscode.window.showErrorMessage(vscode.l10n.t('HTTP Request: {0}', error instanceof Error ? error.message : String(error))); }
	})];
}
