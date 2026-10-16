/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { RuntimeInfo } from './runtime';
import type { ProjectFacts, ProjectEnvironment, ProjectDependency } from './projectModel';
const execute = promisify(execFile);
/** Resolve installed source roots with the selected interpreter and effective Bundler configuration. */
export async function resolveDependencies(runtime: RuntimeInfo, facts: ProjectFacts, extensionPath: string, signal: AbortSignal): Promise<Pick<ProjectEnvironment, 'bundle' | 'dependencies' | 'issues' | 'configurationFiles'>> {
	let stdout: string;
	try {
		({ stdout } = await execute(runtime.ruby, [path.join(extensionPath, 'ruby', 'environment_probe.rb'), facts.bundled ? 'bundle' : 'auto'], { cwd: facts.root, env: runtime.env, signal, timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }));
	} catch (error) {
		if (signal.aborted) { throw error; }
		throw new Error('The project dependency probe failed or exceeded its time/output limit. Check the selected interpreter and refresh.');
	}
	const line = stdout.split(/\r?\n/).findLast(item => item.startsWith('RUBY_STUDIO_ENVIRONMENT='));
	if (!line) { throw new Error('The dependency probe returned no environment data.'); }
	const result = JSON.parse(line.slice('RUBY_STUDIO_ENVIRONMENT='.length)) as Pick<ProjectEnvironment, 'bundle' | 'dependencies' | 'issues' | 'configurationFiles'>;
	if (!['none', 'ready', 'missing-bundler', 'missing-gems', 'error'].includes(result.bundle) || !Array.isArray(result.dependencies) || !Array.isArray(result.issues) || result.issues.some(item => typeof item !== 'string')) { throw new Error('Invalid dependency probe response.'); }
	if (!Array.isArray(result.configurationFiles) || result.configurationFiles.length > 32 || result.configurationFiles.some(file => typeof file !== 'string' || !path.isAbsolute(file))) { throw new Error('Invalid dependency configuration paths.'); }
	result.configurationFiles = [...new Set(result.configurationFiles)];
	result.dependencies = result.dependencies.filter((item: ProjectDependency) => typeof item.id === 'string' && typeof item.name === 'string' && typeof item.version === 'string' && Array.isArray(item.requireRoots) && item.requireRoots.every(root => typeof root === 'string' && path.isAbsolute(root)) && Array.isArray(item.dependencies));
	return result;
}
