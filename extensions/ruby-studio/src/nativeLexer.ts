/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { RubyToken, TokenKind } from './languageModel';

interface NativeFrame {
	id: number;
	count: number;
	fallback: boolean;
}
interface Pending {
	text: string;
	resolve: (tokens: RubyToken[] | undefined) => void;
	timer: ReturnType<typeof setTimeout>;
}
const kinds: (TokenKind | undefined)[] = [undefined, 'identifier', 'constant', 'keyword', 'instanceVariable', 'number', 'literal', 'symbol', 'operator', 'newline', 'comment', 'globalVariable'];

/** Keeps CPU-heavy tokenization in one application-owned Rust process, away from the extension event loop. */
export class NativeRubyLexer {
	private child?: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, Pending>();
	private nextId = 0;
	private readonly chunks: Buffer[] = [];
	private bufferedBytes = 0;
	private frame?: NativeFrame;
	private unavailable = false;
	private disposed = false;
	private reported = false;
	private successfulRequests = 0;
	private readonly binary: string;

	constructor(extensionPath: string, private readonly report: (message: string) => void) {
		this.binary = path.join(extensionPath, 'native', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'ruby-studio-lexer.exe' : 'ruby-studio-lexer');
	}

	get status(): string { return this.unavailable ? 'TypeScript fallback' : this.successfulRequests ? `Rust worker (${this.successfulRequests} documents tokenized)` : 'Rust worker (starts on first document)'; }

	/** Returns undefined when the native backend is unavailable or explicitly declines a lexical shape. */
	tokenize(text: string): Promise<RubyToken[] | undefined> {
		if (this.unavailable || this.disposed || this.pending.size >= 64 || Buffer.byteLength(text) > 16 * 1024 * 1024) { return Promise.resolve(undefined); }
		if (!this.child) { this.start(); }
		if (!this.child) { return Promise.resolve(undefined); }
		const id = ++this.nextId;
		return new Promise(resolve => {
			const timer = setTimeout(() => { this.pending.delete(id); resolve(undefined); this.fail('Native Ruby tokenization timed out.'); }, 15000);
			this.pending.set(id, { text, resolve, timer });
			const body = Buffer.from(text, 'utf8');
			this.child!.stdin.write(Buffer.concat([Buffer.from(`${id} ${body.byteLength}\n`), body]));
		});
	}

	private start(): void {
		const child = spawn(this.binary, ['--binary'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		this.child = child;
		child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
		child.stderr.setEncoding('utf8').on('data', (text: string) => { if (!this.reported) { this.reported = true; this.report(text.slice(0, 2000)); } });
		child.stdin.on('error', () => this.fail('Native Ruby worker closed its input.'));
		child.once('error', error => this.fail(error.message));
		child.once('exit', () => { if (!this.disposed) { this.fail('Native Ruby worker stopped.'); } });
	}

	/** Handles fragmented/coalesced frames without repeatedly copying the entire response. */
	private consume(chunk: Buffer): void {
		if (this.unavailable || this.disposed) { return; }
		this.chunks.push(chunk); this.bufferedBytes += chunk.byteLength;
		if (this.bufferedBytes > 32 * 1024 * 1024) { this.fail('Native Ruby response exceeded the protocol limit.'); return; }
		try {
			while (this.bufferedBytes || this.frame) {
				if (!this.frame) {
					let length = 0;
					let found = false;
					for (const part of this.chunks) {
						const newline = part.indexOf(10);
						if (newline >= 0) { length += newline + 1; found = true; break; }
						length += part.byteLength;
						if (length > 128) { throw new Error('Invalid frame header'); }
					}
					if (!found) { return; }
					if (length > 128) { throw new Error('Invalid frame header'); }
					const match = /^(\d+) (\d+) ([01])\n$/.exec(this.readBytes(length).toString('ascii'));
					if (!match) { throw new Error('Invalid frame header'); }
					const id = Number(match[1]); const count = Number(match[2]); const fallback = match[3] === '1';
					if (!Number.isSafeInteger(id) || !Number.isInteger(count) || count > 1000000 || fallback && count !== 0) { throw new Error('Invalid frame size'); }
					this.frame = { id, count, fallback };
				}
				const length = this.frame.count * 17;
				if (this.bufferedBytes < length) { return; }
				const frame = this.frame; this.frame = undefined;
				this.receive(frame, this.readBytes(length));
			}
		} catch { this.fail('Native Ruby worker returned an invalid response.'); }
	}

	private readBytes(length: number): Buffer {
		if (!length) { return Buffer.alloc(0); }
		const first = this.chunks[0];
		if (first.byteLength >= length) {
			const result = first.subarray(0, length);
			if (first.byteLength === length) { this.chunks.shift(); } else { this.chunks[0] = first.subarray(length); }
			this.bufferedBytes -= length; return result;
		}
		const result = Buffer.allocUnsafe(length);
		let offset = 0;
		while (offset < length) {
			const part = this.chunks[0]; const take = Math.min(part.byteLength, length - offset);
			part.copy(result, offset, 0, take); offset += take;
			if (take === part.byteLength) { this.chunks.shift(); } else { this.chunks[0] = part.subarray(take); }
		}
		this.bufferedBytes -= length; return result;
	}

	private receive(frame: NativeFrame, payload: Buffer): void {
		const pending = this.pending.get(frame.id);
		if (!pending) { return; }
		let tokens: RubyToken[] | undefined;
		if (!frame.fallback) {
			let previousEnd = 0;
			tokens = new Array<RubyToken>(frame.count);
			for (let i = 0, offset = 0; i < frame.count; i++, offset += 17) {
				const kind = kinds[payload[offset]]; const start = payload.readUInt32LE(offset + 1); const end = payload.readUInt32LE(offset + 5);
				const line = payload.readUInt32LE(offset + 9); const column = payload.readUInt32LE(offset + 13);
				if (!kind || start < previousEnd || end < start || end > pending.text.length || line > pending.text.length || column > pending.text.length) { throw new Error('Invalid token position'); }
				previousEnd = end;
				tokens[i] = { kind, text: pending.text.slice(start, end), start, end, line, column, scopeId: 0 };
			}
			this.successfulRequests++;
		}
		clearTimeout(pending.timer); this.pending.delete(frame.id); pending.resolve(tokens);
	}

	private fail(message: string): void {
		this.unavailable = true;
		if (!this.reported && !this.disposed) { this.reported = true; this.report(message); }
		this.child?.kill(); this.child = undefined;
		this.chunks.length = 0; this.bufferedBytes = 0; this.frame = undefined;
		for (const request of this.pending.values()) { clearTimeout(request.timer); request.resolve(undefined); }
		this.pending.clear();
	}

	dispose(): void { this.disposed = true; this.fail(''); }
}
