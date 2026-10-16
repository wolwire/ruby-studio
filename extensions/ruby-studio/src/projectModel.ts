/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { RuntimeInfo } from './runtime';

export const projectConfigFiles = ['.ruby-version', '.ruby-gemset', '.tool-versions', 'mise.toml', '.mise.toml', 'Gemfile', 'Gemfile.lock', '.bundle/config', 'gems.rb', 'gems.locked'];
export interface ProjectFacts {
	root: string; kind: 'ruby' | 'gem' | 'rails' | 'unknown'; fingerprint: string;
	requestedRuby?: { version: string; gemset?: string; source: string };
	bundled: boolean; testRoots: string[];
}
export interface ProjectDependency {
	id: string; name: string; version: string; platform?: string; source: 'rubygems' | 'git' | 'path' | 'default' | 'stdlib';
	sourcePath?: string; requireRoots: string[]; dependencies: string[]; state: 'resolved' | 'missing';
}
export interface ProjectEnvironment {
	root: string; generation: number; facts?: ProjectFacts; runtime?: RuntimeInfo;
	sdk: 'resolving' | 'restricted' | 'ready' | 'missing' | 'mismatch' | 'error';
	bundle: 'none' | 'resolving' | 'ready' | 'missing-bundler' | 'missing-gems' | 'error';
	dependencies: ProjectDependency[]; issues: string[]; configurationFiles?: string[];
	index: { project: 'pending' | 'indexing' | 'ready' | 'partial'; libraries: 'pending' | 'indexing' | 'ready' | 'partial'; skippedRoots: string[] };
}
/** Read optional configuration without evaluating Ruby files. */
async function optional(file: string): Promise<string> {
	try { const stat = await fs.stat(file); if (stat.size > 1024 * 1024) { throw new Error('Project configuration exceeds 1 MiB.'); } return await fs.readFile(file, 'utf8'); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return ''; } throw error; }
}
/** Detect project markers and requested Ruby without executing application code. */
export async function detectProject(root: string): Promise<ProjectFacts> {
	root = await fs.realpath(root);
	const names = await fs.readdir(root);
	const values = await Promise.all(projectConfigFiles.map(file => optional(path.join(root, file))));
	const version = values[0].trim().split('@');
	const tools = values[2].match(/^ruby\s+(?<version>\S+)/m)?.groups?.version;
	const mise = (values[3] + '\n' + values[4]).match(/^\s*ruby\s*=\s*["'](?<version>[^"']+)["']/m)?.groups?.version;
	const requested = version[0] || tools || mise;
	const source = version[0] ? '.ruby-version' : tools ? '.tool-versions' : values[3] ? 'mise.toml' : '.mise.toml';
	const exists = async (file: string) => { try { return await fs.stat(path.join(root, file)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; } };
	const [binRails, app, routes] = await Promise.all([exists('bin/rails'), exists('app'), exists('config/routes.rb')]);
	const rails = (!!binRails && binRails.isFile()) || (!!app?.isDirectory() && !!routes?.isFile());
	const gemspecs = names.filter(name => name.endsWith('.gemspec')).sort();
	const gemspecContents = await Promise.all(gemspecs.map(name => optional(path.join(root, name))));
	return {
		root, kind: rails ? 'rails' : gemspecs.length ? 'gem' : names.some(name => /\.rb$/.test(name) || ['lib', 'test', 'spec', 'Gemfile', 'gems.rb', '.ruby-version'].includes(name)) ? 'ruby' : 'unknown',
		fingerprint: createHash('sha256').update(JSON.stringify([root, values, gemspecs, gemspecContents])).digest('hex'),
		requestedRuby: requested ? { version: requested.replace(/^(?:ruby-)/, ''), gemset: values[1].trim() || version[1] || undefined, source: path.join(root, source) } : undefined,
		bundled: names.includes('Gemfile') || names.includes('gems.rb') || !!values[7] || !!process.env.BUNDLE_GEMFILE,
		testRoots: ['features', 'spec', 'test'].map(name => path.join(root, name))
	};
}
/** Compare a concrete version request; ranges/manager aliases remain unresolved. */
export function requestedVersionMatches(request: string, description: string): boolean | undefined {
	if (!/^\d+\.\d+(?:\.\d+)?$/.test(request)) { return undefined; }
	const actual = description.match(/^ruby (?<version>\d+\.\d+\.\d+)/)?.groups?.version;
	return !!actual && (actual === request || actual.startsWith(request + '.'));
}
export interface EnvironmentResolver {
	trusted(): boolean;
	runtime(root: string, signal: AbortSignal): Promise<RuntimeInfo>;
	dependencies(runtime: RuntimeInfo, facts: ProjectFacts, signal: AbortSignal): Promise<Pick<ProjectEnvironment, 'bundle' | 'dependencies' | 'issues' | 'configurationFiles'>>;
}
/** Per-root cancellable generations prevent obsolete probes from publishing results. */
export class ProjectCoordinator {
	readonly states = new Map<string, ProjectEnvironment>();
	private readonly jobs = new Map<string, AbortController>();
	private sequence = 0;
	private disposed = false;
	constructor(private readonly resolver: EnvironmentResolver, private readonly publish: (state: ProjectEnvironment) => void) { }
	async refresh(root: string): Promise<void> {
		this.jobs.get(root)?.abort();
		const controller = new AbortController(); this.jobs.set(root, controller);
		const state: ProjectEnvironment = { root, generation: ++this.sequence, sdk: 'resolving', bundle: 'none', dependencies: [], issues: [], index: { project: 'pending', libraries: 'pending', skippedRoots: [] } };
		const current = () => !this.disposed && !controller.signal.aborted && this.jobs.get(root) === controller;
		const emit = () => { if (current()) { this.states.set(root, state); this.publish(state); } };
		emit();
		try {
			state.facts = await detectProject(root); if (!current()) { return; }
			if (!this.resolver.trusted()) { state.sdk = 'restricted'; emit(); return; }
			state.runtime = await this.resolver.runtime(root, controller.signal); if (!current()) { return; }
			const match = state.facts.requestedRuby && requestedVersionMatches(state.facts.requestedRuby.version, state.runtime.version);
			state.sdk = match === false ? 'mismatch' : 'ready';
			if (state.facts.kind === 'unknown' && state.runtime.manager === 'selected') { state.facts.kind = 'ruby'; }
			if (match === false) { state.issues.push('The selected Ruby does not match the project version request.'); }
			if (match === undefined && state.facts.requestedRuby) { state.issues.push('The project Ruby version request could not be compared exactly.'); }
			state.bundle = 'resolving'; emit();
			const dependencies = await this.resolver.dependencies(state.runtime, state.facts, controller.signal); if (!current()) { return; }
			state.bundle = dependencies.bundle; state.dependencies = dependencies.dependencies; state.issues.push(...dependencies.issues); state.configurationFiles = dependencies.configurationFiles; emit();
		} catch (error) {
			if (!current()) { return; }
			if (state.runtime) { state.bundle = 'error'; } else { state.sdk = state.facts ? 'missing' : 'error'; }
			state.issues.push(error instanceof Error ? error.message : 'Project initialization failed.'); emit();
		} finally { if (this.jobs.get(root) === controller) { this.jobs.delete(root); } }
	}
	cancel(root: string): void { this.jobs.get(root)?.abort(); this.jobs.delete(root); }
	remove(root: string): void { this.jobs.get(root)?.abort(); this.jobs.delete(root); this.states.delete(root); }
	dispose(): void { this.disposed = true; for (const job of this.jobs.values()) { job.abort(); } this.jobs.clear(); this.states.clear(); }
}
