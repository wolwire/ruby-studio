/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, Server, Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RuntimeInfo, RuntimeService } from './runtime';

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject { [key: string]: JsonValue }
interface BridgeMessage { type: string; token?: string; id?: number; result?: JsonObject; error?: string; event?: string; body?: JsonObject }
interface DapRequest { seq: number; type: string; command: string; arguments?: JsonObject }

/** Inputs for the original standard-library TracePoint bridge. */
export interface DebugBridgeOptions {
	runtime: RuntimeInfo;
	bridgePath: string;
	script: string;
	args?: string[];
	rubyArgs?: string[];
	trusted: boolean;
}

/** Own the child process and authenticated private loopback debugger transport. */
export class RubyDebugBridge extends EventEmitter {
	private socket?: Socket;
	private child?: ChildProcess;
	private server?: Server;
	private nextId = 0;
	private closed = false;
	private readonly pending = new Map<number, { resolve: (result: JsonObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

	static async launch(options: DebugBridgeOptions): Promise<RubyDebugBridge> {
		if (!options.trusted) { throw new Error('Trust the workspace before debugging Ruby.'); }
		if (!(await fs.stat(options.script)).isFile()) { throw new Error('The debug script does not exist.'); }
		if (!(await fs.stat(options.runtime.cwd)).isDirectory()) { throw new Error('The debug working directory does not exist.'); }
		const bridge = new RubyDebugBridge();
		const token = randomBytes(32).toString('hex');
		let readyResolve: (() => void) | undefined;
		let readyReject: ((error: Error) => void) | undefined;
		const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
		const timeout = setTimeout(() => readyReject?.(new Error('The Ruby debugger did not connect within 15 seconds.')), 15000);
		bridge.server = createServer(socket => {
			if (bridge.socket) { socket.destroy(); return; }
			let buffer = '';
			let authenticated = false;
			socket.setEncoding('utf8');
			socket.on('data', data => {
				buffer += data;
				if (buffer.length > 4 * 1024 * 1024) { socket.destroy(); readyReject?.(new Error('Debugger message exceeded its size limit.')); return; }
				let end: number;
				while ((end = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
					try {
						const message = JSON.parse(line) as BridgeMessage;
						if (!authenticated) {
							if (message.type !== 'ready' || message.token !== token) { socket.destroy(); return; }
							authenticated = true; bridge.socket = socket; bridge.server?.close(); readyResolve?.();
						} else { bridge.receive(message); }
					} catch (error) { readyReject?.(error instanceof Error ? error : new Error(String(error))); socket.destroy(); }
				}
			});
			socket.on('error', error => { if (!authenticated) { readyReject?.(error); } });
			socket.on('close', () => { if (authenticated) { bridge.rejectPending(new Error('Ruby debugger disconnected.')); } });
		});
		await new Promise<void>((resolve, reject) => { bridge.server!.once('error', reject); bridge.server!.listen(0, '127.0.0.1', resolve); });
		const address = bridge.server.address();
		if (!address || typeof address === 'string') { bridge.dispose(); throw new Error('Cannot bind the Ruby debugger transport.'); }
		bridge.child = spawn(options.runtime.ruby, [...(options.rubyArgs || []), options.bridgePath, options.script, ...(options.args || [])], {
			cwd: options.runtime.cwd, env: { ...options.runtime.env, RUBY_STUDIO_DEBUG_PORT: String(address.port), RUBY_STUDIO_DEBUG_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true
		});
		bridge.child.stdout?.on('data', data => bridge.emit('output', { category: 'stdout', output: data.toString() }));
		bridge.child.stderr?.on('data', data => bridge.emit('output', { category: 'stderr', output: data.toString() }));
		bridge.child.on('error', error => { readyReject?.(error); bridge.emit('output', { category: 'stderr', output: error.message + '\n' }); });
		bridge.child.on('close', (code, signal) => { readyReject?.(new Error(`Ruby debugger exited before connecting (${code ?? signal}).`)); bridge.rejectPending(new Error('Ruby process exited.')); bridge.emit('exit', { code, signal }); });
		try { await ready; return bridge; }
		catch (error) { bridge.dispose(); throw error; }
		finally { clearTimeout(timeout); }
	}

	private receive(message: BridgeMessage): void {
		if (message.type === 'response' && typeof message.id === 'number') {
			const pending = this.pending.get(message.id);
			if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); if (message.error) { pending.reject(new Error(message.error)); } else { pending.resolve(message.result || {}); } }
		} else if (message.type === 'event' && message.event) { this.emit('event', { event: message.event, body: message.body || {} }); }
	}

	/** Send one framed request; process output never enters this transport. */
	request(command: string, args: JsonObject = {}): Promise<JsonObject> {
		if (!this.socket || this.closed) { return Promise.reject(new Error('The Ruby debugger is not connected.')); }
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Ruby debugger request timed out: ${command}`)); }, 10000);
			this.pending.set(id, { resolve, reject, timer });
			this.socket!.write(JSON.stringify({ id, command, arguments: args }) + '\n');
		});
	}

	private rejectPending(error: Error): void { this.pending.forEach(pending => { clearTimeout(pending.timer); pending.reject(error); }); this.pending.clear(); }

	/** Terminate the owned process group, including children started by the program. */
	dispose(): void {
		if (this.closed) { return; }
		this.closed = true;
		this.socket?.destroy(); this.server?.close(); this.rejectPending(new Error('Ruby debugging stopped.'));
		const child = this.child;
		if (child?.pid && child.exitCode === null) {
			try { if (process.platform === 'win32') { child.kill(); } else { process.kill(-child.pid, 'SIGTERM'); } } catch { /* Process already exited. */ }
			const force = setTimeout(() => { if (child.exitCode === null) { try { if (process.platform === 'win32') { child.kill('SIGKILL'); } else { process.kill(-child.pid!, 'SIGKILL'); } } catch { /* Process already exited. */ } } }, 1000);
			force.unref();
		}
	}
}

/** Translate DAP requests into the original Ruby bridge protocol. */
class RubyDebugAdapter implements vscode.DebugAdapter {
	private readonly emitter: vscode.EventEmitter<vscode.DebugProtocolMessage>;
	readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage>;
	private sequence = 0;
	private bridge?: RubyDebugBridge;
	private readonly breakpoints = new Map<string, { lines: number[]; ids: number[] }>();
	private nextBreakpointId = 0;
	private configured = false;
	private started = false;
	private ended = false;
	private disposed = false;
	private stopOnEntry = false;

	constructor(private readonly runtime: RuntimeService, private readonly bridgePath: string, private readonly folder?: vscode.WorkspaceFolder) {
		const api: typeof vscode = require('vscode');
		this.emitter = new api.EventEmitter<vscode.DebugProtocolMessage>();
		this.onDidSendMessage = this.emitter.event;
	}

	private send(message: object): void { this.emitter.fire({ seq: ++this.sequence, ...message } as vscode.DebugProtocolMessage); }
	private event(event: string, body: JsonObject = {}): void { this.send({ type: 'event', event, body }); }
	private respond(request: DapRequest, body: JsonObject = {}, error?: string): void { this.send({ type: 'response', request_seq: request.seq, command: request.command, success: !error, body, ...(error ? { message: error } : {}) }); }
	private finish(): void { if (!this.ended) { this.ended = true; this.event('terminated'); } }
	private async start(): Promise<void> { if (this.bridge && this.configured && !this.started) { this.started = true; await this.bridge.request('start', { stopOnEntry: this.stopOnEntry }); } }

	handleMessage(message: vscode.DebugProtocolMessage): void { void this.handle(message as DapRequest); }

	private async handle(request: DapRequest): Promise<void> {
		const args = request.arguments || {};
		try {
			switch (request.command) {
				case 'initialize':
					this.respond(request, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true, supportsEvaluateForHovers: false, supportsStepBack: false, exceptionBreakpointFilters: [] });
					this.event('initialized'); return;
				case 'launch': {
					const api: typeof vscode = require('vscode');
					if (!api.workspace.isTrusted) { throw new Error(api.l10n.t('Trust this workspace before debugging Ruby.')); }
					if (!await api.workspace.saveAll(false)) { throw new Error(api.l10n.t('Save all files before debugging.')); }
					const sdk = await this.runtime.get(this.folder);
					const script = typeof args.script === 'string' ? args.script : typeof args.program === 'string' ? args.program : '';
					if (!script) { throw new Error(api.l10n.t('A Ruby debug script is required.')); }
					if (args.env && (typeof args.env !== 'object' || Array.isArray(args.env) || Object.values(args.env).some(value => typeof value !== 'string'))) { throw new Error('Debug environment variables must be strings.'); }
					const strings = (value: JsonValue | undefined): string[] => { if (value === undefined) { return []; } if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) { throw new Error('Debug arguments must be strings.'); } return value as string[]; };
					const cwd = typeof args.cwd === 'string' ? path.resolve(sdk.cwd, args.cwd) : sdk.cwd;
					this.stopOnEntry = args.stopOnEntry === true;
					this.bridge = await RubyDebugBridge.launch({ runtime: { ...sdk, cwd, env: { ...sdk.env, ...(args.env as Record<string, string> || {}) } }, bridgePath: this.bridgePath, script: path.resolve(cwd, script), args: strings(args.args), rubyArgs: strings(args.rubyArgs), trusted: true });
					if (this.disposed) { this.bridge.dispose(); return; }
					this.bridge.on('event', (event: { event: string; body: JsonObject }) => { if (event.event === 'terminated') { this.finish(); } else { this.event(event.event, event.body); } });
					this.bridge.on('output', (body: JsonObject) => this.event('output', body));
					this.bridge.on('exit', (event: { code: number | null }) => { this.event('exited', { exitCode: event.code ?? 0 }); this.finish(); });
					for (const [filename, stored] of this.breakpoints) {
						const result = await this.bridge.request('setBreakpoints', { path: filename, lines: stored.lines });
						(result.breakpoints as JsonObject[]).forEach((breakpoint, index) => this.event('breakpoint', { reason: 'changed', breakpoint: { ...breakpoint, id: stored.ids[index], source: { path: filename } } }));
					}
					this.respond(request); await this.start(); return;
				}
				case 'configurationDone': this.configured = true; this.respond(request); await this.start(); return;
				case 'setBreakpoints': {
					const source = args.source as JsonObject | undefined;
					if (!source || typeof source.path !== 'string') { throw new Error('A local breakpoint source path is required.'); }
					const lines = ((args.breakpoints || []) as JsonObject[]).map(item => Number(item.line)).filter(line => Number.isInteger(line) && line > 0);
					const ids = lines.map(() => ++this.nextBreakpointId);
					this.breakpoints.set(source.path, { lines, ids });
					const result = this.bridge ? await this.bridge.request('setBreakpoints', { path: source.path, lines }) : { breakpoints: lines.map(line => ({ verified: false, line, message: 'The Ruby instruction sequence is validated when debugging starts.' })) };
					this.respond(request, { breakpoints: (result.breakpoints as JsonObject[]).map((breakpoint, index) => ({ ...breakpoint, id: ids[index] })) }); return;
				}
				case 'threads': this.respond(request, { threads: [{ id: 1, name: 'Ruby Main Thread' }] }); return;
				case 'stackTrace': case 'scopes': case 'variables': case 'evaluate':
					if (!this.bridge) { throw new Error('The Ruby debugger has not launched.'); }
					this.respond(request, await this.bridge.request(request.command, args)); return;
				case 'continue': case 'next': case 'stepIn': case 'stepOut': case 'pause':
					if (!this.bridge) { throw new Error('The Ruby debugger has not launched.'); }
					await this.bridge.request(request.command, args); this.respond(request, request.command === 'continue' ? { allThreadsContinued: true } : {});
					if (request.command !== 'pause') { this.event('continued', { threadId: 1, allThreadsContinued: true }); } return;
				case 'disconnect': case 'terminate': this.bridge?.dispose(); this.respond(request); this.finish(); return;
				case 'setExceptionBreakpoints': this.respond(request, { breakpoints: [] }); return;
				default: this.respond(request, {}, `Unsupported Ruby debug request: ${request.command}`); return;
			}
		} catch (error) { this.respond(request, {}, error instanceof Error ? error.message : String(error)); if (request.command === 'launch') { this.finish(); } }
	}

	dispose(): void { this.disposed = true; this.bridge?.dispose(); this.emitter.dispose(); }
}

/** Register Ruby Studio's own DAP adapter; no external Ruby debugger is used. */
export function registerDebugging(context: vscode.ExtensionContext, runtime: RuntimeService): vscode.Disposable[] {
	const api: typeof vscode = require('vscode');
	return [api.debug.registerDebugAdapterDescriptorFactory('rubyStudio', {
		createDebugAdapterDescriptor: session => new api.DebugAdapterInlineImplementation(new RubyDebugAdapter(runtime, api.Uri.joinPath(context.extensionUri, 'ruby', 'debug_bridge.rb').fsPath, session.workspaceFolder))
	})];
}
