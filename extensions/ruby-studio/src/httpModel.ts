/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface HttpRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

/** Parses a .http block and document variables without evaluating code or reading environment secrets. */
export function parseRequest(text: string, caretLine: number): HttpRequest {
	const lines = text.split(/\r?\n/);
	const variables = new Map<string, string>();
	for (const line of lines) {
		const match = line.match(/^@(?<key>[A-Za-z_]\w*)\s*=\s*(?<value>.*)$/);
		if (match?.groups) { variables.set(match.groups.key, match.groups.value); }
	}
	let start = 0;
	let end = lines.length;
	for (let line = 0; line < lines.length; line++) {
		if (/^###/.test(lines[line])) {
			if (line <= caretLine) { start = line + 1; } else { end = line; break; }
		}
	}
	const block = lines.slice(start, end);
	while (block.length && (/^\s*(?:#|@|\/\/)/.test(block[0]) || !block[0].trim())) { block.shift(); }
	const first = block.shift()?.trim().match(/^(?:(?<method>GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(?<url>\S+)(?:\s+HTTP\/\d(?:\.\d)?)?$/i);
	if (!first?.groups) { throw new Error('Place the caret in a request beginning with METHOD http(s)://host/path.'); }
	const substitute = (value: string): string => value.replace(/\{\{\s*(?<key>[A-Za-z_]\w*)\s*\}\}/g, (_match: string, key: string) => {
		const replacement = variables.get(key);
		if (replacement === undefined) { throw new Error(`Undefined HTTP variable: ${key}`); }
		return replacement;
	});
	const headers: Record<string, string> = {};
	while (block.length && block[0].trim()) {
		const line = block.shift()!;
		if (/^\s*#/.test(line)) { continue; }
		const match = line.match(/^(?<key>[!#$%&'*+.^_`|~\w-]+):\s*(?<value>.*)$/);
		if (!match?.groups) { throw new Error(`Invalid HTTP header: ${line}`); }
		headers[match.groups.key] = substitute(match.groups.value);
	}
	if (block.length) { block.shift(); }
	const method = (first.groups.method || 'GET').toUpperCase();
	const body = block.join('\n').trimEnd();
	if (body && (method === 'GET' || method === 'HEAD')) { throw new Error(`${method} requests cannot contain a body.`); }
	const url = new URL(substitute(first.groups.url));
	if (!['http:', 'https:'].includes(url.protocol)) { throw new Error('Only HTTP and HTTPS requests are supported.'); }
	return { method, url: url.toString(), headers, ...(body ? { body: substitute(body) } : {}) };
}
