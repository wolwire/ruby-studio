/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectProject } from './projectModel';
import { findExecutable } from './runtime';
export interface ProjectDraft { name: string; parent: string; interpreter: string }
export interface ProjectValidation { destination?: string; existing?: 'empty' | 'nonempty' | 'rails'; error?: string }
/** Revalidate the effective destination and never treat the project name as a path. */
export async function validateProject(draft: ProjectDraft): Promise<ProjectValidation> {
	if (!draft || typeof draft.name !== 'string' || typeof draft.parent !== 'string' || typeof draft.interpreter !== 'string') { return { error: 'Invalid project settings.' }; }
	if (!draft.name.trim() || !/^[a-zA-Z0-9-._ ]+$/.test(draft.name) || ['.', '..'].includes(draft.name)) { return { error: 'Use a project name with letters, digits, spaces, dots, hyphens or underscores.' }; }
	if (process.platform === 'win32' && (/[. ]$/.test(draft.name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(draft.name))) { return { error: 'This project name is reserved on Windows.' }; }
	if (!path.isAbsolute(draft.parent)) { return { error: 'Choose an absolute parent directory.' }; }
	try {
		const parent = await fs.realpath(draft.parent);
		if (!(await fs.stat(parent)).isDirectory()) { return { error: 'The parent must be a directory.' }; }
		await fs.access(parent, fs.constants.W_OK);
		const destination = path.join(parent, draft.name);
		let existing: ProjectValidation['existing'];
		try {
			const stat = await fs.lstat(destination);
			if (!stat.isDirectory() || stat.isSymbolicLink()) { return { error: 'The destination must be a directory, not a file or symbolic link.' }; }
			await fs.access(destination, fs.constants.W_OK);
			existing = (await fs.readdir(destination)).length ? 'nonempty' : 'empty';
			if ((await detectProject(destination)).kind === 'rails') { existing = 'rails'; }
			try { if ((await fs.lstat(path.join(destination, '.vscode'))).isSymbolicLink()) { return { error: 'Project settings cannot be stored through a symbolic link.' }; } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
		return { destination, existing, error: draft.interpreter.trim() ? undefined : 'Select a Ruby SDK before creating the project.' };
	} catch { return { error: 'The project location is unavailable or is not writable.' }; }
}
/** Create only the directory; scoped SDK settings are written by the native JSON editing service. */
export async function createProjectDirectory(draft: ProjectDraft, existing: 'create' | 'open' | 'reject' = 'reject'): Promise<{ destination: string; created: boolean; openExisting: boolean }> {
	const check = await validateProject(draft);
	if (check.error || !check.destination) { throw new Error(check.error || 'Invalid project location.'); }
	if (check.existing === 'rails' && existing !== 'open') { throw new Error('Open the existing Rails application instead.'); }
	if (check.existing && existing === 'open') { return { destination: check.destination, created: false, openExisting: true }; }
	if (check.existing === 'nonempty' && existing !== 'create') { throw new Error('The destination is not empty. Choose Open Existing or Create Here.'); }
	if (check.existing) { return { destination: check.destination, created: false, openExisting: false }; }
	await fs.mkdir(check.destination); // Non-recursive: a racing creator cannot be silently overwritten.
	return { destination: check.destination, created: true, openExisting: false };
}
/** Discover SDK executable paths without launching them or reading project hooks. */
export async function discoverInterpreters(cwd: string): Promise<string[]> {
	const candidates = new Set<string>();
	for (const item of [process.env.RUBY_STUDIO_RUBY, await findExecutable('ruby', process.env, cwd)]) { if (item) { candidates.add(item); } }
	for (const directory of ['.rbenv/versions', '.asdf/installs/ruby', '.rubies', '.ruby-studio/sdk/rubies'].map(item => path.join(os.homedir(), item))) {
		try { for (const entry of (await fs.readdir(directory)).slice(0, 100)) { const executable = path.join(directory, entry, 'bin', process.platform === 'win32' ? 'ruby.exe' : 'ruby'); try { await fs.access(executable, fs.constants.X_OK); candidates.add(executable); } catch { /* Not an SDK. */ } } } catch { /* Optional manager. */ }
	}
	return [...candidates];
}
