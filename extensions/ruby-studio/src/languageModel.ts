/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Original, deliberately bounded Ruby lexical analysis. No language-server dependency. */
export type RubySymbolKind = 'class' | 'module' | 'method' | 'constant' | 'variable' | 'parameter' | 'instanceVariable';
export type TokenKind = 'identifier' | 'constant' | 'keyword' | 'instanceVariable' | 'globalVariable' | 'number' | 'literal' | 'symbol' | 'operator' | 'newline' | 'comment';
export interface RubyToken { kind: TokenKind; text: string; start: number; end: number; line: number; column: number; scopeId: number; definitionId?: string }
export interface RubyParameter { name: string; label: string; keyword: boolean }
export interface RubySymbol {
	id: string; uri: string; name: string; kind: RubySymbolKind; qualifiedName: string;
	start: number; end: number; bodyStart: number; bodyEnd: number; line: number; scopeId: number;
	owner: string; singleton: boolean; parentSymbolId?: string; parameters: RubyParameter[]; documentation: string;
	keywordParameter?: boolean; superclass?: string; dynamicAncestors?: boolean;
}
interface RubyScope {
	id: number; kind: 'top' | 'namespace' | 'method' | 'block'; parentId?: number; owner: string;
	start: number; end: number; singleton: boolean; symbolId?: string; locals: Map<string, RubySymbol>;
}
export interface RubyDocument {
	uri: string; project: string; text: string; tokens: RubyToken[]; symbols: RubySymbol[]; scopes: RubyScope[];
	unsafeLocalSyntax: boolean; complexNamespace: boolean; issues: string[]; template: boolean; localAssignments: RubyLocalAssignment[];
}
export interface RubyLocalAssignment { symbolId: string; scopeId: number; tokenIndex: number; operatorIndex: number; operator: string; standalone: boolean }
export interface RubyReference { uri: string; start: number; end: number; declaration: boolean; shorthand: boolean }
export interface RubyTextEdit { start: number; end: number; text: string }
export type RenameFailure = 'noSymbol' | 'dynamicMethod' | 'unsupportedVariable' | 'keywordParameter' | 'reflection' | 'interpolation' | 'unsupportedSyntax' | 'incompleteIndex' | 'ambiguousConstant' | 'collision' | 'invalidName';
export interface RubyRename { symbol?: RubySymbol; token?: RubyToken; failure?: RenameFailure; edits: Map<string, RubyTextEdit[]> }

const keywords = new Set('BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'.split(' '));
const assignments = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '||=', '&&=', '&=', '|=', '^=']);
const statementStarts = new Set(['=', '(', '[', '{', ',', ';', '=>', 'then', 'else', 'return']);
const reflection = new Set(['eval', 'binding', 'local_variables', 'local_variable_get', 'local_variable_set', 'class_eval', 'module_eval', 'instance_eval']);
const constantReflection = new Set([...reflection, 'const_get', 'const_set', 'constantize', 'safe_constantize', 'autoload']);
const receiverReflection = new Set([...constantReflection, 'define_method', 'define_singleton_method', 'singleton_class', 'send', 'public_send', 'remove_method', 'undef_method']);
const receiverControlFlow = new Set(['if', 'unless', 'case', 'when', 'else', 'elsif', 'while', 'until', 'for', 'rescue', 'ensure', 'begin', 'do', 'return', 'break', 'next', 'redo', 'retry', 'and', 'or']);

/** Skips quoted/interpolated contents rather than treating literal words as references. */
function quotedEnd(text: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < text.length) {
		if (text[i] === '\\') { i += 2; continue; }
		if (quote !== "'" && text.slice(i, i + 2) === '#{') {
			let depth = 1; i += 2;
			while (i < text.length && depth) {
				if (['"', "'", '`'].includes(text[i])) { i = quotedEnd(text, i, text[i]); }
				else if (text[i] === '\\') { i += 2; }
				else { if (text[i] === '{') { depth++; } else if (text[i] === '}') { depth--; } i++; }
			}
			continue;
		}
		if (text[i++] === quote) { return i; }
	}
	return text.length;
}

/** Tokenizes source with stable UTF-16 offsets, preserving literal and comment boundaries. */
export function tokenizeRuby(text: string): RubyToken[] {
	const tokens: RubyToken[] = [];
	const heredocs: { marker: string; indented: boolean }[] = [];
	let i = 0; let line = 0; let column = 0;
	const push = (kind: TokenKind, end: number) => {
		const token = { kind, text: text.slice(i, end), start: i, end, line, column, scopeId: 0 };
		tokens.push(token);
		for (; i < end; i++) { if (text[i] === '\n') { line++; column = 0; } else { column++; } }
	};
	while (i < text.length) {
		const ch = text[i];
		if (ch === ' ' || ch === '\t' || ch === '\r') { i++; column++; continue; }
		if (ch === '\n') {
			push('newline', i + 1);
			while (heredocs.length) {
				const heredoc = heredocs.shift()!;
				let end = i;
				while (end < text.length) {
					let next = text.indexOf('\n', end); if (next < 0) { next = text.length; }
					const value = text.slice(end, next).replace(/\r$/, '');
					const terminal = (heredoc.indented ? value.trimStart() : value) === heredoc.marker;
					end = next < text.length ? next + 1 : next;
					if (terminal) { break; }
				}
				push('literal', end);
			}
			continue;
		}
		if (column === 0 && /^__END__(?:\r?\n|$)/.test(text.slice(i))) { push('literal', text.length); break; }
		if (column === 0 && /^=begin(?:\s|$)/.test(text.slice(i))) {
			const match = /^=end(?:[^\n]*)(?:\n|$)/m.exec(text.slice(i + 6));
			push('comment', match ? i + 6 + match.index + match[0].length : text.length); continue;
		}
		if (ch === '#') { const end = text.indexOf('\n', i); push('comment', end < 0 ? text.length : end); continue; }
		if (['"', "'", '`'].includes(ch)) { push('literal', quotedEnd(text, i, ch)); continue; }
		const heredoc = /^<<(?<mode>[-~]?)(?:(?<quote>['"`])(?<quoted>[A-Za-z_]\w*)\k<quote>|(?<bare>[A-Za-z_]\w*))/.exec(text.slice(i));
		if (heredoc?.groups) { heredocs.push({ marker: heredoc.groups.quoted || heredoc.groups.bare, indented: !!heredoc.groups.mode }); push('literal', i + heredoc[0].length); continue; }
		const percent = /^%(?:[qQwWiIrxs])?(?<delimiter>[^\w\s=])/.exec(text.slice(i));
		if (percent?.groups) {
			const delimiter = percent.groups.delimiter;
			const close = ({ '(': ')', '[': ']', '{': '}', '<': '>' } as Record<string, string>)[delimiter] || delimiter;
			let end = i + percent[0].length; let depth = 1;
			while (end < text.length && depth) { if (text[end] === '\\') { end += 2; continue; } if (delimiter !== close && text[end] === delimiter) { depth++; } else if (text[end] === close) { depth--; } end++; }
			push('literal', end); continue;
		}
		if (ch === ':' && text[i + 1] !== ':' && /[A-Za-z_@]/.test(text[i + 1] || '') && !(tokens.at(-1)?.end === i && tokens.at(-1)?.kind === 'identifier')) {
			const symbol = /^:[A-Za-z_@]\w*[!?=]?/.exec(text.slice(i))!;
			push('symbol', i + symbol[0].length); continue;
		}
		const previous = tokens.findLast(token => token.kind !== 'comment' && token.kind !== 'newline');
		if (ch === '/' && text[i + 1] !== '=' && (!previous || statementStarts.has(previous.text) || ['=~', '!~', 'when'].includes(previous.text) || (/\s/.test(text[i - 1] || '') && !/\s/.test(text[i + 1] || '')))) {
			let end = i + 1; let characterClass = false;
			while (end < text.length && text[end] !== '\n') {
				if (text[end] === '\\') { end += 2; continue; }
				if (text[end] === '[') { characterClass = true; } else if (text[end] === ']') { characterClass = false; }
				if (text[end++] === '/' && !characterClass) { while (/[a-z]/i.test(text[end] || '')) { end++; } push('literal', end); break; }
			}
			if (i === end) { continue; }
		}
		const global = /^\$(?:[A-Za-z_]\w*|\d+|[^\sA-Za-z_])/.exec(text.slice(i));
		if (global) { push('globalVariable', i + global[0].length); continue; }
		const name = /^(?:@@?[A-Za-z_]\w*|[A-Za-z_]\w*[!?]?)/.exec(text.slice(i));
		if (name) {
			const value = name[0];
			const receiver = previous?.text === '.' || previous?.text === '&.';
			const label = text[i + value.length] === ':' && text[i + value.length + 1] !== ':';
			push(value.startsWith('@') ? 'instanceVariable' : /^[A-Z]/.test(value) ? 'constant' : keywords.has(value) && !receiver && !label ? 'keyword' : 'identifier', i + value.length); continue;
		}
		const number = /^(?:0[xob][\da-f_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?[ri]?)/i.exec(text.slice(i));
		if (number) { push('number', i + number[0].length); continue; }
		const operator = /^(?:\*\*=|\|\|=|&&=|===|<=>|\.\.\.|::|&\.|=>|==|!=|<=|>=|=~|!~|<<|>>|\*\*|\.\.|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|&&|\|\||->)/.exec(text.slice(i));
		push('operator', i + (operator?.[0].length || 1));
	}
	return tokens;
}

/** Returns contiguous source documentation above a declaration without interpreting Markdown. */
function documentation(text: string, line: number): string {
	const lines = text.split(/\r?\n/); const result: string[] = [];
	for (let i = line - 1; i >= 0 && result.length < 12; i--) {
		const match = /^\s*#\s?(.*)$/.exec(lines[i]); if (!match) { break; }
		result.unshift(match[1]);
	}
	return result.join('\n');
}

/** Keeps only executable ERB tag contents, preserving every UTF-16 offset and newline. */
export function maskRubyTemplate(text: string): string {
	const masked: string[] = text.split('').map(character => character === '\n' || character === '\r' ? character : ' ');
	let cursor = 0;
	while (cursor < text.length) {
		const start = text.indexOf('<%', cursor); if (start < 0) { break; }
		let end = text.indexOf('%>', start + 2); if (end < 0) { end = text.length; }
		let content = start + 2;
		if (text[content] !== '#' && text[content] !== '%') {
			if (text[content] === '=' || text[content] === '-') { content++; }
			const finish = text[end - 1] === '-' ? end - 1 : end;
			for (let i = content; i < finish; i++) { masked[i] = text[i]; }
		}
		cursor = end + 2;
	}
	return masked.join('');
}

/** Builds declarations and lexical scopes; unsupported Ruby forms remain explicitly bounded. */
export function parseRuby(uri: string, text: string, project = '', template = false, pretokenized?: RubyToken[]): RubyDocument {
	const tokens = pretokenized ? pretokenized.map(token => { const copy = { ...token, scopeId: 0 }; delete copy.definitionId; return copy; }) : tokenizeRuby(template ? maskRubyTemplate(text) : text);
	const scopes: RubyScope[] = [{ id: 0, kind: 'top', owner: '', start: 0, end: text.length, singleton: false, locals: new Map() }];
	const symbols: RubySymbol[] = [];
	const model: RubyDocument = { uri, project, text, tokens, symbols, scopes, unsafeLocalSyntax: false, complexNamespace: false, issues: [], template, localAssignments: [] };
	const frames: { closer: 'end' | '}' | 'newline'; kind: string; line: number; scopeId?: number; endlessAfter?: number }[] = [];
	const headers = new Set<number>();
	let current = 0;
	const newScope = (kind: RubyScope['kind'], start: number, owner = scopes[current].owner, singleton = scopes[current].singleton, symbolId?: string): number => {
		const id = scopes.length; scopes.push({ id, kind, start, end: text.length, parentId: current, owner, singleton, symbolId, locals: new Map() }); current = id; return id;
	};
	const parentSymbol = (): string | undefined => { let scope: RubyScope | undefined = scopes[current]; while (scope) { if (scope.symbolId) { return scope.symbolId; } scope = scope.parentId === undefined ? undefined : scopes[scope.parentId]; } return undefined; };
	const declare = (token: RubyToken, kind: RubySymbolKind, name = token.text, qualifiedName = name, singleton = false): RubySymbol => {
		const symbol: RubySymbol = { id: `${uri}#${symbols.length}`, uri, kind, name, qualifiedName, start: token.start, end: token.end, bodyStart: token.start, bodyEnd: token.end, line: token.line, scopeId: current, owner: scopes[current].owner, singleton, parentSymbolId: parentSymbol(), parameters: [], documentation: documentation(text, token.line) };
		symbols.push(symbol); token.definitionId = symbol.id; return symbol;
	};
	const local = (name: string, scopeId: number, before: number): RubySymbol | undefined => {
		let scope: RubyScope | undefined = scopes[scopeId];
		while (scope) { const result = scope.locals.get(name); if (result && result.start <= before) { return result; } if (scope.kind !== 'block') { break; } scope = scope.parentId === undefined ? undefined : scopes[scope.parentId]; }
		return undefined;
	};
	const bind = (token: RubyToken, kind: 'variable' | 'parameter' = 'variable', force = false): RubySymbol => {
		const existing = !force ? local(token.text, current, token.start) : scopes[current].locals.get(token.text);
		if (existing) { token.definitionId = existing.id; return existing; }
		const symbol = declare(token, kind); scopes[current].locals.set(token.text, symbol); return symbol;
	};
	const closeFrame = (end: number): void => {
		const frame = frames.pop(); if (frame?.scopeId !== undefined) { const scope = scopes[frame.scopeId]; scope.end = end; const symbol = symbols.find(symbol => symbol.id === scope.symbolId); if (symbol) { symbol.bodyEnd = end; } current = scope.parentId ?? 0; }
	};
	const blockParameters = (start: number): void => {
		if (tokens[start]?.text !== '|') { return; }
		let nameExpected = true; let localOnly = false;
		for (let p = start + 1; p < tokens.length && tokens[p].text !== '|'; p++) {
			const token = tokens[p]; token.scopeId = current; headers.add(p);
			if (token.text === ';') { localOnly = true; nameExpected = true; }
			else if ([',', '('].includes(token.text)) { nameExpected = true; }
			else if (nameExpected && token.kind === 'identifier') { const symbol = bind(token, localOnly ? 'variable' : 'parameter', true); symbol.keywordParameter = tokens[p + 1]?.text === ':'; nameExpected = false; }
		}
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]; token.scopeId = current;
		const previous = tokens[i - 1]; const next = tokens[i + 1];
		if (token.kind === 'newline') { while (frames.at(-1)?.closer === 'newline' && token.start >= (frames.at(-1)?.endlessAfter || 0)) { closeFrame(token.start); } continue; }
		if (headers.has(i) || token.kind === 'comment' || token.kind === 'literal' || token.kind === 'symbol') { continue; }
		if (token.kind === 'keyword' && (token.text === 'class' || token.text === 'module')) {
			if (next?.text === '<<') { const id = newScope('namespace', token.start, scopes[current].owner, true); frames.push({ closer: 'end', kind: 'singleton', line: token.line, scopeId: id }); headers.add(i + 1); headers.add(i + 2); continue; }
			let p = i + 1; let absolute = false; if (tokens[p]?.text === '::') { absolute = true; p++; }
			const pathTokens: RubyToken[] = [];
			while (tokens[p]?.kind === 'constant') { pathTokens.push(tokens[p]); headers.add(p); if (tokens[p + 1]?.text !== '::') { break; } headers.add(p + 1); p += 2; }
			if (pathTokens.length) {
				const owner = scopes[current].owner; const path = pathTokens.map(token => token.text).join('::');
				const qualified = absolute || !owner ? path : `${owner}::${path}`;
				if (owner && pathTokens.length > 1) { model.complexNamespace = true; }
				const nameToken = pathTokens.at(-1)!; const symbol = declare(nameToken, token.text, nameToken.text, qualified); symbol.bodyStart = token.start;
				if (token.text === 'class' && tokens[p + 1]?.text === '<') {
					let q = p + 2; const parts: string[] = []; let absoluteSuperclass = false;
					if (tokens[q]?.text === '::') { absoluteSuperclass = true; q++; }
					while (tokens[q]?.kind === 'constant') { parts.push(tokens[q].text); if (tokens[q + 1]?.text !== '::') { break; } q += 2; }
					if (parts.length) { symbol.superclass = `${absoluteSuperclass ? '::' : ''}${parts.join('::')}`; }
				}
				const id = newScope('namespace', token.start, qualified, true, symbol.id); frames.push({ closer: 'end', kind: token.text, line: token.line, scopeId: id });
			}
			continue;
		}
		if (token.kind === 'keyword' && token.text === 'def') {
			let p = i + 1; let singleton = scopes[current].kind === 'namespace' && frames.some(frame => frame.kind === 'singleton'); let owner = scopes[current].owner;
			if (tokens[p]?.text === 'self' && tokens[p + 1]?.text === '.') { singleton = true; headers.add(p); headers.add(p + 1); p += 2; }
			else if (tokens[p]?.kind === 'constant') {
				const parts: string[] = []; let q = p;
				while (tokens[q]?.kind === 'constant') { parts.push(tokens[q].text); if (tokens[q + 1]?.text !== '::') { break; } q += 2; }
				if (tokens[q + 1]?.text === '.') { singleton = true; owner = parts.join('::'); for (; p <= q + 1; p++) { headers.add(p); } }
			}
			const nameToken = tokens[p];
			if (!nameToken || !['identifier', 'keyword', 'operator'].includes(nameToken.kind)) { model.unsafeLocalSyntax = true; continue; }
			headers.add(p); let name = nameToken.text; let afterName = p + 1;
			if (name === '[' && tokens[afterName]?.text === ']') { name = '[]'; nameToken.end = tokens[afterName].end; headers.add(afterName++); }
			if (['+', '-'].includes(name) && tokens[afterName]?.text === '@' && tokens[afterName].start === nameToken.end) { name += '@'; nameToken.end = tokens[afterName].end; headers.add(afterName++); }
			if (tokens[afterName]?.text === '=' && tokens[afterName].start === nameToken.end) { name += '='; nameToken.end = tokens[afterName].end; headers.add(afterName++); }
			const symbol = declare(nameToken, 'method', name, `${owner}${singleton ? '.' : '#'}${name}`, singleton); symbol.owner = owner; symbol.bodyStart = token.start;
			const id = newScope('method', token.start, owner, singleton, symbol.id);
			let end = afterName; let parenthesized = tokens[end]?.text === '(';
			if (parenthesized) { let depth = 1; end++; while (end < tokens.length && depth) { if (tokens[end].text === '(') { depth++; } else if (tokens[end].text === ')') { depth--; } if (depth) { end++; } } }
			else { while (end < tokens.length && tokens[end].kind !== 'newline' && tokens[end].text !== ';') { end++; } }
			const endless = tokens[afterName]?.text === '=' || (parenthesized && tokens[end + 1]?.text === '=');
			const endlessEquals = parenthesized ? end + 1 : afterName;
			let endlessBody = endlessEquals + 1;
			while (tokens[endlessBody]?.kind === 'newline' || tokens[endlessBody]?.kind === 'comment') { endlessBody++; }
			if (endless && tokens[endlessBody]?.line !== tokens[endlessEquals]?.line) { model.unsafeLocalSyntax = true; }
			const parameterStart = parenthesized ? afterName + 1 : afterName;
			const parameterEnd = endless && !parenthesized ? parameterStart : end;
			let groupStart = parameterStart; let depth = 0;
			for (let q = parameterStart; q <= parameterEnd; q++) {
				const value = tokens[q]?.text;
				if (q === parameterEnd || (value === ',' && depth === 0)) {
					const group = tokens.slice(groupStart, q); const first = group.find(token => token.kind === 'identifier');
					if (first) { const parameter = bind(first, 'parameter', true); parameter.keywordParameter = group[group.indexOf(first) + 1]?.text === ':'; symbol.parameters.push({ name: first.text, label: text.slice(group[0].start, group.at(-1)!.end), keyword: !!parameter.keywordParameter }); }
					groupStart = q + 1;
				} else if (['(', '[', '{'].includes(value)) { depth++; } else if ([')', ']', '}'].includes(value)) { depth--; }
			}
			for (let q = i + 1; q <= (parenthesized ? end : parameterEnd - 1); q++) { if (tokens[q]) { tokens[q].scopeId = id; headers.add(q); } }
			frames.push({ closer: endless ? 'newline' : 'end', kind: 'def', line: token.line, scopeId: id, endlessAfter: endless ? tokens[endlessBody]?.start : undefined });
			continue;
		}
		if (token.kind === 'keyword' && ['if', 'unless', 'while', 'until', 'for', 'case', 'begin'].includes(token.text)) {
			const opener = ['case', 'begin', 'for'].includes(token.text) || !previous || previous.kind === 'newline' || statementStarts.has(previous.text);
			if (opener) { frames.push({ closer: 'end', kind: token.text, line: token.line }); }
			if (token.text === 'for') { for (let p = i + 1; p < tokens.length && tokens[p].text !== 'in'; p++) { if (tokens[p].kind === 'identifier') { bind(tokens[p]); headers.add(p); } } }
			continue;
		}
		if (token.kind === 'keyword' && token.text === 'in' && !frames.some(frame => frame.kind === 'for' && frame.line === token.line)) { model.unsafeLocalSyntax = true; }
		if (token.kind === 'keyword' && token.text === 'do') {
			if (frames.some(frame => ['while', 'until', 'for'].includes(frame.kind) && frame.line === token.line)) { continue; }
			const id = newScope('block', token.start); frames.push({ closer: 'end', kind: 'do', line: token.line, scopeId: id }); blockParameters(i + 1); continue;
		}
		if (token.text === '->') {
			let opening = i + 1; let depth = 0;
			while (opening < tokens.length) { const value = tokens[opening]; if (!depth && ['{', 'do'].includes(value.text)) { break; } if (value.text === '(') { depth++; } else if (value.text === ')') { depth--; } if (value.kind === 'newline') { break; } opening++; }
			if (!['{', 'do'].includes(tokens[opening]?.text)) { model.unsafeLocalSyntax = true; continue; }
			const id = newScope('block', token.start); frames.push({ closer: tokens[opening].text === '{' ? '}' : 'end', kind: 'lambda', line: token.line, scopeId: id });
			let expectName = true;
			for (let p = i + 1; p <= opening; p++) { const value = tokens[p]; headers.add(p); value.scopeId = current; if (['(', ','].includes(value.text)) { expectName = true; } else if (expectName && value.kind === 'identifier') { const parameter = bind(value, 'parameter', true); parameter.keywordParameter = tokens[p + 1]?.text === ':'; expectName = false; } }
			continue;
		}
		if (token.text === '{') {
			const block = previous && (['identifier', 'constant'].includes(previous.kind) || [')', ']', '->'].includes(previous.text));
			const id = block ? newScope('block', token.start) : undefined;
			frames.push({ closer: '}', kind: block ? 'block' : 'hash', line: token.line, scopeId: id }); if (block) { blockParameters(i + 1); } continue;
		}
		if ((token.kind === 'keyword' && token.text === 'end') || token.text === '}') {
			if (frames.at(-1)?.closer === (token.text === 'end' ? 'end' : '}')) { closeFrame(token.end); } else { model.unsafeLocalSyntax = true; model.issues.push('Unmatched scope delimiter in the lexical index.'); }
			continue;
		}
		if (token.kind === 'identifier' && /^_[1-9]$/.test(token.text) && scopes[current].kind === 'block' && ![...scopes[current].locals.values()].some(symbol => symbol.kind === 'parameter' && !/^_[1-9]$/.test(symbol.name))) { bind(token, 'parameter', true); }
		if (token.kind === 'identifier' && ['include', 'prepend', 'extend'].includes(token.text) && scopes[current].kind === 'namespace') { const symbol = symbols.find(symbol => symbol.id === scopes[current].symbolId); if (symbol) { symbol.dynamicAncestors = true; } }
		if (token.text === '=>' && next?.kind === 'identifier' && tokens.slice(Math.max(0, i - 20), i).some(value => value.line === token.line && value.text === 'rescue')) { bind(next); }
		if (!assignments.has(token.text)) { continue; }
		let start = i - 1;
		if (tokens[start]?.text === ')') {
			let depth = 1; start--;
			while (start >= 0 && depth) { if (tokens[start].text === ')') { depth++; } else if (tokens[start].text === '(') { depth--; } if (depth) { start--; } }
		} else {
			while (start >= 2 && [',', '::'].includes(tokens[start - 1].text) && ['identifier', 'constant'].includes(tokens[start - 2].kind)) { start -= 2; }
		}
		const left = tokens.slice(start, i);
		if (left.length && left.every(value => ['identifier', 'constant'].includes(value.kind) || [',', '*', '::', '(', ')'].includes(value.text))) {
			for (const value of left) {
				if (value.definitionId || ['.', '&.'].includes(tokens[tokens.indexOf(value) - 1]?.text)) { continue; }
				if (value.kind === 'identifier' && !/[!?]$/.test(value.text)) {
					const symbol = bind(value); const tokenIndex = tokens.indexOf(value); const before = tokens[tokenIndex - 1];
					model.localAssignments.push({ symbolId: symbol.id, scopeId: current, tokenIndex, operatorIndex: i, operator: token.text, standalone: left.length === 1 && (!before || before.kind === 'newline' || before.text === ';') });
				}
				else if (value.kind === 'constant' && tokens[tokens.indexOf(value) + 1]?.text !== '::') {
					let first = tokens.indexOf(value); while (first >= 2 && tokens[first - 1].text === '::' && tokens[first - 2].kind === 'constant') { first -= 2; }
					const path = tokens.slice(first, tokens.indexOf(value) + 1).filter(value => value.kind === 'constant').map(value => value.text).join('::');
					if (scopes[current].owner && path.includes('::')) { model.complexNamespace = true; }
					declare(value, 'constant', value.text, scopes[current].owner ? `${scopes[current].owner}::${path}` : path);
				}
			}
		} else if (previous?.kind === 'instanceVariable' && !previous.text.startsWith('@@')) { declare(previous, 'instanceVariable', previous.text, `${scopes[current].owner}${scopes[current].singleton ? '.' : '#'}${previous.text}`, scopes[current].singleton); }
	}
	while (frames.at(-1)?.closer === 'newline') { closeFrame(text.length); }
	if (frames.length) { model.unsafeLocalSyntax = true; model.issues.push('The lexical index has an unfinished scope; Ruby syntax checking provides authoritative diagnostics.'); }
	return model;
}

/** A workspace-folder-isolated index of original static Ruby declarations and references. */
export class RubyIndex {
	readonly documents = new Map<string, RubyDocument>();
	complete = true;
	private readonly declarations = new Map<string, RubySymbol[]>();
	private readonly receiverTypes = new Map<string, string | null>();

	update(uri: string, text: string, project = '', template = false, pretokenized?: RubyToken[]): RubyDocument {
		const document = parseRuby(uri, text, project, template, pretokenized); this.documents.set(uri, document); this.rebuild(); return document;
	}
	remove(uri: string): void { this.documents.delete(uri); this.rebuild(); }
	clear(): void { this.documents.clear(); this.declarations.clear(); this.receiverTypes.clear(); }
	private key(project: string, name: string): string { return `${project}\0${name}`; }
	private rebuild(): void {
		this.declarations.clear(); this.receiverTypes.clear();
		for (const document of this.documents.values()) { for (const symbol of document.symbols) { if (['class', 'module', 'constant', 'method', 'instanceVariable'].includes(symbol.kind)) { const key = this.key(document.project, symbol.qualifiedName); const symbols = this.declarations.get(key) || []; symbols.push(symbol); this.declarations.set(key, symbols); } } }
	}
	private declared(document: RubyDocument, qualified: string): RubySymbol[] { return this.declarations.get(this.key(document.project, qualified)) || []; }
	private superclass(document: RubyDocument, owner: string): string | undefined {
		const classes = this.declared(document, owner).filter(symbol => symbol.kind === 'class');
		if (classes.length !== 1 || !classes[0].superclass || classes[0].dynamicAncestors) { return undefined; }
		const symbol = classes[0]; const source = this.documents.get(symbol.uri)!; const name = symbol.superclass!;
		for (const outer of name.startsWith('::') ? [''] : this.namespaceOwners(source, symbol.scopeId)) {
			const qualified = outer ? `${outer}::${name}` : name.replace(/^::/, '');
			if (this.declared(source, qualified).some(candidate => candidate.kind === 'class')) { return qualified; }
		}
		return undefined;
	}
	private methods(document: RubyDocument, owner: string, name: string, singleton: boolean, visited = new Set<string>()): RubySymbol[] {
		if (visited.has(owner) || visited.size > 12) { return []; } visited.add(owner);
		const direct = this.declared(document, `${owner}${singleton ? '.' : '#'}${name}`); if (direct.length) { return direct; }
		const parent = this.superclass(document, owner); return parent ? this.methods(document, parent, name, singleton, visited) : [];
	}

	/** A custom singleton new keeps its target; the ordinary constructor points at initialize. */
	private constructorTargets(document: RubyDocument, owner: string): RubySymbol[] {
		const custom = this.methods(document, owner, 'new', true);
		if (custom.length) { return custom; }
		return this.declared(document, owner).some(symbol => symbol.kind === 'class') ? this.methods(document, owner, 'initialize', false) : [];
	}

	/** Requires one indexed class and a closed, explicit superclass path without mixins. */
	private closedClassHierarchy(document: RubyDocument, owner: string, visited = new Set<string>()): boolean {
		if (visited.has(owner) || visited.size > 12) { return false; } visited.add(owner);
		const declarations = this.declared(document, owner); const symbol = declarations[0];
		if (declarations.length !== 1 || symbol.kind !== 'class' || symbol.dynamicAncestors) { return false; }
		const source = this.documents.get(symbol.uri)!;
		if (source.unsafeLocalSyntax || source.complexNamespace) { return false; }
		if (!symbol.superclass) { return true; }
		const parent = this.superclass(document, owner);
		return !!parent && this.closedClassHierarchy(document, parent, visited);
	}

	/** Bounds a constructor assignment to a complete expression, excluding chained or conditional results. */
	private constructorAssignment(document: RubyDocument, assignment: RubyLocalAssignment): { owner: string; end: number } | undefined {
		if (!assignment.standalone || assignment.operator !== '=') { return undefined; }
		const tokens = document.tokens; let end = assignment.operatorIndex + 1; const closing: string[] = [];
		while (end < tokens.length) {
			const token = tokens[end];
			if (!closing.length && (token.kind === 'newline' || token.text === ';' || token.kind === 'comment')) { break; }
			if (['(', '[', '{'].includes(token.text)) { closing.push(({ '(': ')', '[': ']', '{': '}' } as Record<string, string>)[token.text]); }
			else if ([')', ']', '}'].includes(token.text) && closing.pop() !== token.text) { return undefined; }
			end++;
		}
		if (closing.length) { return undefined; }
		let cursor = assignment.operatorIndex + 1;
		if (tokens[cursor]?.text === '::') { cursor++; }
		if (tokens[cursor]?.kind !== 'constant') { return undefined; }
		while (tokens[cursor + 1]?.text === '::' && tokens[cursor + 2]?.kind === 'constant') { cursor += 2; }
		const classIndex = cursor;
		if (tokens[++cursor]?.text !== '.' || tokens[++cursor]?.text !== 'new') { return undefined; }
		cursor++;
		if (cursor !== end) {
			if (tokens[cursor]?.text !== '(' || tokens[end - 1]?.text !== ')') { return undefined; }
			let depth = 0;
			for (; cursor < end; cursor++) { if (tokens[cursor].text === '(') { depth++; } else if (tokens[cursor].text === ')') { depth--; if (!depth && cursor !== end - 1) { return undefined; } } }
			if (depth) { return undefined; }
		}
		const classes = this.constant(document, classIndex);
		return classes.length === 1 && classes[0].kind === 'class' ? { owner: classes[0].qualifiedName, end: tokens[end - 1].end } : undefined;
	}

	/** Recognizes one same-scope, straight-line Class.new binding; this is not dynamic type inference. */
	private localReceiver(document: RubyDocument, receiver: RubyToken): string | undefined {
		if (!this.complete || document.unsafeLocalSyntax || document.complexNamespace) { return undefined; }
		const symbol = this.local(document, receiver);
		if (!symbol || symbol.kind !== 'variable' || symbol.scopeId !== receiver.scopeId || !['top', 'method'].includes(document.scopes[symbol.scopeId].kind)) { return undefined; }
		const assignments = document.localAssignments.filter(assignment => assignment.symbolId === symbol.id);
		if (assignments.length !== 1 || assignments[0].scopeId !== symbol.scopeId) { return undefined; }
		const candidate = this.constructorAssignment(document, assignments[0]);
		if (!candidate || receiver.start <= candidate.end) { return undefined; }
		if (this.receiverTypes.has(symbol.id)) { return this.receiverTypes.get(symbol.id) || undefined; }
		const hasControlFlow = document.tokens.some(token => token.scopeId === symbol.scopeId && ((token.kind === 'keyword' && receiverControlFlow.has(token.text)) || ['&&', '||', '?'].includes(token.text)));
		const hasBlocks = document.scopes.some(scope => scope.kind === 'block' && scope.parentId === symbol.scopeId);
		const reflected = [...this.documents.values()].some(source => source.project === document.project && source.tokens.some(token => (token.kind === 'identifier' && receiverReflection.has(token.text)) || (token.kind === 'keyword' && ['alias', 'undef'].includes(token.text))));
		const safe = !hasControlFlow && !hasBlocks && !reflected && this.closedClassHierarchy(document, candidate.owner)
			&& !this.methods(document, candidate.owner, 'new', true).length && !this.declared(document, 'Class.new').length;
		this.receiverTypes.set(symbol.id, safe ? candidate.owner : null);
		return safe ? candidate.owner : undefined;
	}

	/** Resolves super from the enclosing method to the same name on its explicit parent class. */
	private superTargets(document: RubyDocument, scopeId: number): RubySymbol[] {
		let scope: RubyScope | undefined = document.scopes[scopeId];
		while (scope && scope.kind === 'block') { scope = scope.parentId === undefined ? undefined : document.scopes[scope.parentId]; }
		if (scope?.kind !== 'method') { return []; }
		const method = document.symbols.find(symbol => symbol.id === scope.symbolId); const parent = method && this.superclass(document, method.owner);
		return method && parent ? this.methods(document, parent, method.name, method.singleton) : [];
	}
	tokenAt(uri: string, offset: number): RubyToken | undefined { return this.documents.get(uri)?.tokens.find(token => token.start <= offset && offset < token.end); }
	private local(document: RubyDocument, token: RubyToken, name = token.text): RubySymbol | undefined {
		let scope: RubyScope | undefined = document.scopes[token.scopeId];
		while (scope) { const symbol = scope.locals.get(name); if (symbol && symbol.start <= token.start) { return symbol; } if (scope.kind !== 'block') { break; } scope = scope.parentId === undefined ? undefined : document.scopes[scope.parentId]; }
		return undefined;
	}
	private namespaceOwners(document: RubyDocument, scopeId: number): string[] {
		const owners: string[] = []; let scope: RubyScope | undefined = document.scopes[scopeId];
		while (scope) { if (scope.kind === 'namespace' && scope.owner && !owners.includes(scope.owner)) { owners.push(scope.owner); } scope = scope.parentId === undefined ? undefined : document.scopes[scope.parentId]; }
		owners.push(''); return owners;
	}
	private constant(document: RubyDocument, index: number): RubySymbol[] {
		let start = index; while (start >= 2 && document.tokens[start - 1].text === '::' && document.tokens[start - 2].kind === 'constant') { start -= 2; }
		const absolute = document.tokens[start - 1]?.text === '::';
		const parts = document.tokens.slice(start, index + 1).filter(token => token.kind === 'constant').map(token => token.text);
		if (absolute) { return this.declared(document, parts.join('::')); }
		for (const owner of this.namespaceOwners(document, document.tokens[index].scopeId)) { const result = this.declared(document, owner ? `${owner}::${parts.join('::')}` : parts.join('::')); if (result.length) { return result; } }
		return [];
	}
	resolve(uri: string, offset: number): { token: RubyToken; definitions: RubySymbol[] } | undefined {
		const document = this.documents.get(uri); const token = this.tokenAt(uri, offset); if (!document || !token) { return undefined; }
		return { token, definitions: this.resolveToken(document, document.tokens.indexOf(token)) };
	}
	private resolveToken(document: RubyDocument, index: number): RubySymbol[] {
		const token = document.tokens[index];
		if (token.definitionId) { const symbol = document.symbols.find(symbol => symbol.id === token.definitionId); return symbol ? [symbol] : []; }
		if (token.kind === 'constant') { return document.tokens[index + 1]?.text === ':' && !this.isShorthand(document, index) ? [] : this.constant(document, index); }
		const scope = document.scopes[token.scopeId];
		if (token.kind === 'keyword' && token.text === 'super') { return this.superTargets(document, token.scopeId); }
		if (token.kind === 'instanceVariable') { return this.declared(document, `${scope.owner}${scope.singleton ? '.' : '#'}${token.text}`); }
		if (token.kind !== 'identifier') { return []; }
		const previous = document.tokens[index - 1];
		if (['.', '&.'].includes(previous?.text)) {
			const receiver = document.tokens[index - 2]; if (!receiver) { return []; }
			const methodName = document.tokens[index + 1]?.text === '=' ? `${token.text}=` : token.text;
			if (receiver.text === 'self') { return methodName === 'new' && scope.singleton ? this.constructorTargets(document, scope.owner) : this.methods(document, scope.owner, methodName, scope.singleton); }
			if (receiver.kind === 'constant') { const owner = this.constant(document, index - 2); if (owner.length && owner.every(symbol => symbol.qualifiedName === owner[0].qualifiedName)) { return methodName === 'new' ? this.constructorTargets(document, owner[0].qualifiedName) : this.methods(document, owner[0].qualifiedName, methodName, true); } }
			if (receiver.kind === 'identifier') { const owner = this.localReceiver(document, receiver); if (owner) { return this.methods(document, owner, methodName, false); } }
			return [];
		}
		if (document.tokens[index + 1]?.text === ':' && !this.isShorthand(document, index)) { return []; }
		const local = this.local(document, token); if (local) { return [local]; }
		return this.methods(document, scope.owner, token.text, scope.singleton);
	}
	private isShorthand(document: RubyDocument, index: number): boolean { let next = index + 2; while (document.tokens[next]?.kind === 'comment') { next++; } return document.tokens[index + 1]?.text === ':' && (!document.tokens[next] || [',', ')', '}', '\n'].includes(document.tokens[next].text)); }
	references(symbol: RubySymbol, includeDeclaration = true): RubyReference[] {
		const results: RubyReference[] = [];
		for (const document of this.documents.values()) {
			if (document.project !== this.documents.get(symbol.uri)?.project) { continue; }
			for (const [index, token] of document.tokens.entries()) {
				if (!this.resolveToken(document, index).some(result => result.id === symbol.id)) { continue; }
				const declaration = document.uri === symbol.uri && token.start === symbol.start;
				if (includeDeclaration || !declaration) { results.push({ uri: document.uri, start: token.start, end: token.end, declaration, shorthand: this.isShorthand(document, index) }); }
			}
		}
		return results;
	}

	/** Refuses dynamic method renames, uncertain scopes, capture and hidden string references. */
	rename(uri: string, offset: number, newName?: string): RubyRename {
		const result: RubyRename = { edits: new Map() };
		const found = this.resolve(uri, offset); const document = this.documents.get(uri);
		if (!found?.definitions.length || !document) { result.failure = 'noSymbol'; return result; }
		const symbol = found.definitions[0]; result.symbol = symbol; result.token = found.token;
		if (symbol.kind === 'method') { result.failure = 'dynamicMethod'; return result; }
		if (/^_[1-9]$/.test(symbol.name)) { result.failure = 'unsupportedVariable'; return result; }
		if (!['variable', 'parameter', 'class', 'module', 'constant'].includes(symbol.kind)) { result.failure = 'unsupportedVariable'; return result; }
		if (symbol.keywordParameter) { result.failure = 'keywordParameter'; return result; }
		const constant = ['class', 'module', 'constant'].includes(symbol.kind);
		const source = this.documents.get(symbol.uri)!;
		if (source.unsafeLocalSyntax || (constant && [...this.documents.values()].some(document => document.project === source.project && (document.unsafeLocalSyntax || document.complexNamespace)))) { result.failure = 'unsupportedSyntax'; return result; }
		if (constant && !this.complete) { result.failure = 'incompleteIndex'; return result; }
		if (constant && this.declared(source, symbol.qualifiedName).length !== 1) { result.failure = 'ambiguousConstant'; return result; }
		const relevant = constant ? [...this.documents.values()].filter(document => document.project === source.project) : [source];
		if (relevant.some(document => document.tokens.some(token => token.kind === 'identifier' && (constant ? constantReflection : reflection).has(token.text)))) { result.failure = 'reflection'; return result; }
		const namePattern = new RegExp(`\\b${symbol.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
		if (relevant.some(document => document.tokens.some(token => (token.kind === 'literal' || token.kind === 'symbol') && (constant || token.text.includes('#{')) && namePattern.test(token.text)))) { result.failure = 'interpolation'; return result; }
		if (newName === undefined) { return result; }
		if (!(constant ? /^[A-Z]\w*$/ : /^[a-z_]\w*$/).test(newName) || keywords.has(newName) || /^_[1-9]$/.test(newName)) { result.failure = 'invalidName'; return result; }
		if (newName === symbol.name) { return result; }
		if (constant) {
			const qualified = symbol.qualifiedName.slice(0, -symbol.name.length) + newName;
			if (this.declared(source, qualified).length) { result.failure = 'collision'; return result; }
			for (const reference of this.references(symbol, false)) {
				const document = this.documents.get(reference.uri)!; const index = document.tokens.findIndex(token => token.start === reference.start);
				if (document.tokens[index - 1]?.text === '::') { continue; }
				if (this.namespaceOwners(document, document.tokens[index].scopeId).some(owner => this.declared(document, owner ? `${owner}::${newName}` : newName).length)) { result.failure = 'collision'; return result; }
			}
		} else {
			const reaches = (from: number, target: number): boolean => { let scope: RubyScope | undefined = source.scopes[from]; while (scope) { if (scope.id === target) { return true; } if (scope.kind !== 'block') { break; } scope = scope.parentId === undefined ? undefined : source.scopes[scope.parentId]; } return false; };
			if (source.symbols.some(other => ['variable', 'parameter'].includes(other.kind) && other.name === newName && (reaches(other.scopeId, symbol.scopeId) || reaches(symbol.scopeId, other.scopeId)))) { result.failure = 'collision'; return result; }
			if (source.tokens.some(token => reaches(token.scopeId, symbol.scopeId) && ((token.kind === 'identifier' && token.text === newName) || (token.kind === 'literal' && token.text.includes('#{') && new RegExp(`\\b${newName}\\b`).test(token.text))))) { result.failure = 'collision'; return result; }
		}
		for (const reference of this.references(symbol)) {
			const edits = result.edits.get(reference.uri) || [];
			edits.push({ start: reference.start, end: reference.end + (reference.shorthand ? 1 : 0), text: reference.shorthand ? `${symbol.name}: ${newName}` : newName }); result.edits.set(reference.uri, edits);
		}
		return result;
	}

	/** Returns only known lexical candidates; unknown object receiver types get no guesses. */
	completions(uri: string, offset: number): RubySymbol[] {
		const document = this.documents.get(uri); if (!document) { return []; }
		const before = document.tokens.filter(token => token.end <= offset && token.kind !== 'comment' && token.kind !== 'newline');
		const last = before.at(-1); const scope = document.scopes.filter(scope => scope.start <= offset && scope.end >= offset).at(-1) || document.scopes[0];
		if (last?.text === '.' || last?.text === '&.') {
			const receiver = before.at(-2); let owner: string | undefined; let singleton = true;
			if (receiver?.text === 'self') { owner = scope.owner; singleton = scope.singleton; }
			else if (receiver?.kind === 'constant') { const definitions = this.constant(document, document.tokens.indexOf(receiver)); if (definitions.length) { owner = definitions[0].qualifiedName; } }
			else if (receiver?.kind === 'identifier') { owner = this.localReceiver(document, receiver); singleton = false; }
			if (owner === undefined) { return []; }
			return this.ownerMethods(document, owner, singleton);
		}
		const visible: RubySymbol[] = [];
		let current: RubyScope | undefined = scope;
		while (current) { visible.push(...[...current.locals.values()].filter(symbol => symbol.start <= offset)); if (current.kind !== 'block') { break; } current = current.parentId === undefined ? undefined : document.scopes[current.parentId]; }
		visible.push(...this.ownerMethods(document, scope.owner, scope.singleton));
		for (const other of this.documents.values()) { if (other.project === document.project) { visible.push(...other.symbols.filter(symbol => ['class', 'module', 'constant'].includes(symbol.kind))); } }
		return [...new Map(visible.map(symbol => [symbol.name, symbol])).values()];
	}
	private ownerMethods(document: RubyDocument, owner: string, singleton: boolean, visited = new Set<string>()): RubySymbol[] {
		if (visited.has(owner) || visited.size > 12) { return []; } visited.add(owner);
		const own = [...this.documents.values()].filter(other => other.project === document.project).flatMap(other => other.symbols).filter(symbol => symbol.kind === 'method' && symbol.owner === owner && symbol.singleton === singleton);
		const parent = this.superclass(document, owner); return parent ? [...own, ...this.ownerMethods(document, parent, singleton, visited).filter(symbol => !own.some(candidate => candidate.name === symbol.name))] : own;
	}

	/** Locates a parenthesized, statically resolvable method call and its active argument. */
	signature(uri: string, offset: number): { symbols: RubySymbol[]; activeParameter: number } | undefined {
		const document = this.documents.get(uri); if (!document) { return undefined; }
		const before = document.tokens.filter(token => token.start < offset && token.kind !== 'comment'); let depth = 0; let commas = 0;
		for (let i = before.length - 1; i >= 0; i--) {
			const token = before[i];
			if ([')', ']', '}'].includes(token.text)) { depth++; }
			else if (['(', '[', '{'].includes(token.text)) {
				if (depth) { depth--; }
				else if (token.text === '(' && (before[i - 1]?.kind === 'identifier' || before[i - 1]?.text === 'super')) { const methods = this.resolve(uri, before[i - 1].start)?.definitions.filter(symbol => symbol.kind === 'method') || []; return methods.length ? { symbols: methods, activeParameter: commas } : undefined; }
			} else if (token.text === ',' && !depth) { commas++; }
		}
		return undefined;
	}
}

/** Whitespace-only formatting deliberately preserves multiline literal and DATA bytes. */
export function rubyWhitespaceEdits(text: string, pretokenized?: RubyToken[]): RubyTextEdit[] {
	const protectedTokens = (pretokenized || tokenizeRuby(text)).filter(token => token.kind === 'literal');
	const edits: RubyTextEdit[] = []; const lines = text.split('\n'); let start = 0;
	for (const line of lines) { const trailing = /[\t ]+(?=\r?$)/.exec(line); if (trailing) { const from = start + trailing.index; const end = from + trailing[0].length; if (!protectedTokens.some(token => token.start < end && token.end > from)) { edits.push({ start: from, end, text: '' }); } } start += line.length + 1; }
	return edits;
}

/** Parses actual Ruby -c diagnostics; it never invents a syntax error from indentation. */
export function parseRubySyntaxOutput(output: string): { line: number; message: string; warning: boolean }[] {
	const result: { line: number; message: string; warning: boolean }[] = [];
	for (const value of output.split(/\r?\n/)) {
		const match = /^(?:-e|-|[^\n]+?):(?<line>\d+):\s*(?<message>.+)$/.exec(value);
		if (match?.groups) { const message = match.groups.message.trim(); if (!result.some(item => item.line === Number(match.groups!.line) - 1 && item.message === message)) { result.push({ line: Math.max(0, Number(match.groups.line) - 1), message, warning: /^warning:/.test(message) }); } }
	}
	return result;
}

/** Extracts only a literal that is the complete RHS of a standalone local assignment. */
export function extractRubyLiteral(document: RubyDocument, start: number, end: number, name?: string): RubyTextEdit[] | undefined {
	if (document.unsafeLocalSyntax || document.tokens.some(token => token.kind === 'identifier' && reflection.has(token.text))) { return undefined; }
	const lineStart = document.text.lastIndexOf('\n', start - 1) + 1;
	const lineEnd = document.text.indexOf('\n', end);
	const prefix = document.text.slice(lineStart, start);
	const suffix = document.text.slice(end, lineEnd < 0 ? document.text.length : lineEnd).replace(/\r$/, '');
	const expression = document.text.slice(start, end);
	if (!/^(?<indent>[\t ]*)[a-z_]\w*\s*=\s*$/.test(prefix) || !/^\s*(?:#.*)?$/.test(suffix)) { return undefined; }
	if (!/^(?:\d[\d_]*(?:\.\d[\d_]*)?|true|false|nil|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\#\n]|\\.)*")$/.test(expression)) { return undefined; }
	if (name === undefined) { return []; }
	if (!/^[a-z_]\w*$/.test(name) || keywords.has(name) || /^_[1-9]$/.test(name) || new RegExp(`\\b${name}\\b`).test(document.text)) { return undefined; }
	const indent = /^[\t ]*/.exec(prefix)![0]; const eol = document.text.includes('\r\n') ? '\r\n' : '\n';
	return [{ start: lineStart, end: lineStart, text: `${indent}${name} = ${expression}${eol}` }, { start, end, text: name }];
}
