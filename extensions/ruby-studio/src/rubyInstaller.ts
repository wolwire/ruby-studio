/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { findExecutable, resolveRuntime, RuntimeInfo } from './runtime';

interface InstallerOperation {
	trusted: boolean;
	signal: AbortSignal;
	onOutput: (text: string) => void;
}
interface RubyDownload { version: string; url: string; sha256: string; root: string }
const sourceCatalog = 'https://cache.ruby-lang.org/pub/ruby/index.txt';
const windowsCatalog = 'https://api.github.com/repos/oneclick/rubyinstaller2/releases?per_page=100';

/** Version names never become shell fragments or arbitrary filesystem paths. */
export function parseRubyVersions(output: string): string[] {
	return [...new Set(output.split(/\s+/).filter(value => /^\d+\.\d+\.\d+$/.test(value)))].sort((a, b) => {
		const left = a.split('.').map(Number); const right = b.split('.').map(Number);
		return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
	});
}

/** The Ruby project's catalog supplies the archive URL and its SHA-256 digest. */
export function parseRubySourceCatalog(text: string): RubyDownload[] {
	const result: RubyDownload[] = [];
	for (const line of text.split(/\r?\n/)) {
		const [name, url, , sha256] = line.split('\t');
		const version = /^ruby-(\d+\.\d+\.\d+)$/.exec(name)?.[1];
		if (!version || !/^[a-f0-9]{64}$/.test(sha256 || '')) { continue; }
		const [major, minor] = version.split('.').map(Number);
		if (major < 3 || major === 3 && minor < 1) { continue; }
		if (url !== `https://cache.ruby-lang.org/pub/ruby/${major}.${minor}/ruby-${version}.tar.gz`) { continue; }
		result.push({ version, url, sha256, root: `ruby-${version}` });
	}
	return result;
}

/** Windows packages are official per-user RubyInstaller packages, selected by host architecture. */
export function parseRubyWindowsCatalog(text: string, arch: string, localize: (message: string) => string = message => message): RubyDownload[] {
	const result: RubyDownload[] = [];
	const architecture = arch === 'arm64' ? 'arm' : arch === 'x64' ? 'x64' : undefined;
	if (!architecture) { return result; }
	const releases = JSON.parse(text) as { draft?: boolean; prerelease?: boolean; tag_name?: string; assets?: { name: string; digest?: string; browser_download_url: string }[] }[];
	if (!Array.isArray(releases)) { throw new Error(localize('Invalid RubyInstaller release catalog.')); }
	for (const release of releases) {
		if (release.draft || release.prerelease) { continue; }
		const match = /^RubyInstaller-(\d+\.\d+\.\d+)-(\d+)$/.exec(release.tag_name || '');
		if (!match) { continue; }
		for (const asset of release.assets || []) {
			const root = `rubyinstaller-${match[1]}-${match[2]}-${architecture}`;
			const url = `https://github.com/oneclick/rubyinstaller2/releases/download/${release.tag_name}/${root}.exe`;
			if (asset.name !== `${root}.exe` || asset.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) { continue; }
			if (!result.some(item => item.version === match[1])) { result.push({ version: match[1], url, sha256: asset.digest!.slice(7), root }); }
		}
	}
	return result;
}

/** Reject archive entries that could escape the private extraction directory. */
export function validateRubyArchive(entries: string, root: string, localize: (message: string) => string = message => message): void {
	const names = entries.split(/\r?\n/).filter(Boolean).map(name => name.replace(/\\/g, '/'));
	if (!names.length || names.some(name => /^[\/\\]|^[a-z]:/i.test(name) || name.split('/').some(part => part === '..') || /[\x00-\x1f]/.test(name) || name !== root && !name.startsWith(root + '/'))) {
		throw new Error(localize('The Ruby archive contains unexpected paths.'));
	}
}

/** Own download/build orchestration: no rbenv, ruby-build, RVM or global Ruby changes. */
export class RubyInstaller {
	readonly rubies: string;
	private readonly env: NodeJS.ProcessEnv;
	private catalog?: RubyDownload[];

	constructor(private readonly storage: string, env: NodeJS.ProcessEnv = process.env, private readonly localize: (message: string, ...args: string[]) => string = (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => args[Number(index)]), private readonly request: typeof fetch = fetch) {
		this.rubies = path.join(storage, 'rubies');
		const hostPath = env.PATH || Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
		this.env = { ...env, PATH: [hostPath, ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')])].filter(Boolean).join(path.delimiter), NO_COLOR: '1' };
		for (const key of Object.keys(this.env)) {
			if (/^(RUBYOPT|RUBYLIB|GEM_HOME|GEM_PATH|BUNDLE_.*)$/i.test(key) || key.toUpperCase() === 'PATH' && key !== 'PATH') { delete this.env[key]; }
		}
	}

	private check(operation: InstallerOperation): void {
		if (!operation.trusted) { throw new Error(this.localize('Trust this workspace before installing Ruby.')); }
		if (!['darwin', 'linux', 'win32'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) { throw new Error(this.localize('Ruby SDK installation is unavailable on this platform.')); }
		if (operation.signal.aborted) { throw new Error(this.localize('Ruby installation cancelled.')); }
	}

	/** Cancellation waits for compiler/download descendants before deleting a partial SDK. */
	private run(executable: string, args: string[], operation: InstallerOperation, cwd = this.storage, timeout = 120000): Promise<string> {
		this.check(operation);
		operation.onOutput(`> ${[executable, ...args].map(value => JSON.stringify(value)).join(' ')}\n`);
		return new Promise((resolve, reject) => {
			const child = spawn(executable, args, { cwd, env: this.env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = ''; let tail = ''; let reason = ''; let killer: NodeJS.Timeout | undefined;
			const kill = (signal: NodeJS.Signals) => {
				if (!child.pid) { return; }
				if (process.platform === 'win32') {
					const taskkill = spawn(path.join(this.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
					taskkill.on('error', () => { child.kill(); });
				} else { try { process.kill(-child.pid, signal); } catch { /* Already exited. */ } }
			};
			const stop = (message: string) => { if (!reason) { reason = message; kill('SIGTERM'); killer = setTimeout(() => kill('SIGKILL'), 3000); } };
			const abort = () => stop(this.localize('Ruby installation cancelled.'));
			const timer = setTimeout(() => stop(this.localize('Ruby installation timed out. See the installation log.')), timeout);
			operation.signal.addEventListener('abort', abort, { once: true }); if (operation.signal.aborted) { abort(); }
			const output = (text: string) => { tail = (tail + text).slice(-8000); operation.onOutput(text); };
			child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
			child.stdout.on('data', (text: string) => { stdout = (stdout + text).slice(-4 * 1024 * 1024); output(text); }); child.stderr.on('data', output);
			const cleanup = () => { clearTimeout(timer); if (killer) { clearTimeout(killer); } operation.signal.removeEventListener('abort', abort); };
			child.on('error', error => { cleanup(); reject(error); });
			child.on('close', code => {
				if (reason && process.platform !== 'win32') { kill('SIGKILL'); } cleanup();
				if (reason || code !== 0) { reject(new Error(reason || this.localize('Ruby installation command failed ({0}).\n{1}', String(code), tail))); } else { resolve(stdout); }
			});
		});
	}

	private async catalogText(operation: InstallerOperation): Promise<string> {
		this.check(operation);
		const response = await this.request(process.platform === 'win32' ? windowsCatalog : sourceCatalog, { signal: AbortSignal.any([operation.signal, AbortSignal.timeout(120000)]), headers: { 'User-Agent': 'Ruby-Studio-SDK-Installer', Accept: process.platform === 'win32' ? 'application/vnd.github+json' : 'text/plain' } });
		if (!response.ok || !response.body) { throw new Error(this.localize('Could not load Ruby versions ({0}). Try Refresh Versions again.', String(response.status))); }
		let text = ''; const decoder = new TextDecoder();
		for await (const chunk of response.body) {
			if (text.length + chunk.byteLength > 8 * 1024 * 1024) { throw new Error(this.localize('The Ruby version catalog is too large.')); }
			text += decoder.decode(chunk, { stream: true });
		}
		return text + decoder.decode();
	}

	async versions(operation: InstallerOperation): Promise<string[]> {
		try {
			const text = await this.catalogText(operation);
			const catalog = process.platform === 'win32' ? parseRubyWindowsCatalog(text, process.arch, this.localize) : parseRubySourceCatalog(text);
			const versions = parseRubyVersions(catalog.map(item => item.version).join('\n'));
			if (!versions.length) { throw new Error(this.localize('No verified Ruby downloads are available for this platform.')); }
			this.catalog = catalog; return versions;
		} catch (error) { this.check(operation); throw error; }
	}

	private async download(release: RubyDownload, filename: string, operation: InstallerOperation): Promise<void> {
		this.check(operation);
		operation.onOutput(this.localize('Downloading Ruby {0}…', release.version) + '\n');
		const response = await this.request(release.url, { signal: AbortSignal.any([operation.signal, AbortSignal.timeout(15 * 60 * 1000)]) });
		if (!response.ok || !response.body) { throw new Error(this.localize('Ruby download failed ({0}).', String(response.status))); }
		const file = await fs.open(filename, 'wx'); const hash = createHash('sha256'); let bytes = 0; let reported = 0;
		try {
			for await (const chunk of response.body) {
				this.check(operation); bytes += chunk.byteLength;
				if (bytes > 512 * 1024 * 1024) { throw new Error(this.localize('The Ruby download exceeds the size limit.')); }
				hash.update(chunk); await file.writeFile(chunk);
				if (bytes - reported > 1024 * 1024) { reported = bytes; operation.onOutput(`${Math.round(bytes / 1024 / 1024)} MB\n`); }
			}
		} finally { await file.close(); }
		if (hash.digest('hex') !== release.sha256) { throw new Error(this.localize('Ruby download checksum verification failed. Nothing was installed.')); }
		operation.onOutput(this.localize('Ruby download checksum verified.') + '\n');
	}

	private alive(pid: number): boolean {
		if (!Number.isInteger(pid) || pid <= 0) { return true; }
		try { process.kill(pid, 0); return true; }
		catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
	}

	private async lock(destination: string): Promise<() => Promise<void>> {
		const filename = destination + '.installing';
		try { const file = await fs.open(filename, 'wx'); try { await file.writeFile(String(process.pid)); } finally { await file.close(); } }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
			const recovery = filename + '.recovering';
			try { await fs.mkdir(recovery); }
			catch { throw new Error(this.localize('This Ruby version is already being installed in another window.')); }
			const replacement = filename + '-' + randomBytes(8).toString('hex');
			try {
				// Re-read under the recovery lease, then atomically replace the dead
				// owner's file. There is no gap in which another install can claim it.
				if (this.alive(Number(await fs.readFile(filename, 'utf8')))) { throw new Error(this.localize('This Ruby version is already being installed in another window.')); }
				await fs.writeFile(replacement, String(process.pid), { flag: 'wx' });
				await fs.rename(replacement, filename);
			} finally { await fs.rm(replacement, { force: true }); await fs.rm(recovery, { recursive: true, force: true }); }
		}
		return () => fs.rm(filename, { force: true });
	}

	async install(version: string, operation: InstallerOperation): Promise<RuntimeInfo> {
		this.check(operation);
		if (!/^\d+\.\d+\.\d+$/.test(version)) { throw new Error(this.localize('Select a complete stable Ruby version.')); }
		if (!this.catalog) { await this.versions(operation); }
		const release = this.catalog!.find(item => item.version === version);
		if (!release) { throw new Error(this.localize('This Ruby version is unavailable. Refresh the version list.')); }
		await fs.mkdir(this.rubies, { recursive: true });
		const destination = path.join(this.rubies, version); const ruby = path.join(destination, 'bin', process.platform === 'win32' ? 'ruby.exe' : 'ruby');
		const unlock = await this.lock(destination); let owned = false; let temporary: string | undefined;
		try {
			try { await fs.mkdir(destination); owned = true; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
				let partial: { version: string; pid: number } | undefined;
				try { partial = JSON.parse(await fs.readFile(path.join(destination, '.ruby-studio-installing.json'), 'utf8')); } catch { /* Existing SDKs belong to the user. */ }
				if (partial?.version !== version || this.alive(partial.pid)) { return await this.validate(ruby, version, operation); }
				await fs.rm(destination, { recursive: true, force: true }); await fs.mkdir(destination); owned = true;
			}
			await fs.writeFile(path.join(destination, '.ruby-studio-installing.json'), JSON.stringify({ version, pid: process.pid }));
			temporary = await fs.mkdtemp(path.join(this.storage, 'ruby-download-'));
			const archive = path.join(temporary, process.platform === 'win32' ? 'ruby-setup.exe' : 'ruby.tar.gz');
			await this.download(release, archive, operation);
			if (process.platform === 'win32') {
				// Official switches keep installation per-user and leave the system
				// PATH, file associations, global Ruby and MSYS2 selection untouched.
				const log = path.join(temporary, 'ruby-setup.log');
				operation.onOutput(this.localize('Installing Ruby {0} for this user…', version) + '\n');
				try {
					await this.run(archive, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/SP-', '/NORESTART', '/CURRENTUSER', '/NOICONS', `/DIR=${destination}`, '/TASKS=noassocfiles,nomodpath,noridkinstall', `/LOG=${log}`], operation, temporary, 10 * 60 * 1000);
				} catch (error) {
					let details = '';
					try { const bytes = await fs.readFile(log); details = bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? 'utf16le' : 'utf8').slice(-8000); } catch { /* Setup did not create a log. */ }
					if (details) { operation.onOutput(details); }
					throw error;
				}
			} else {
				const tar = await findExecutable('tar', this.env, this.storage);
				if (!tar) { throw new Error(this.localize('Archive extraction tools are unavailable. Install the system tar command.')); }
				validateRubyArchive(await this.run(tar, ['-tf', archive], operation, temporary), release.root, this.localize);
				await this.run(tar, ['-xf', archive, '-C', temporary], operation, temporary);
				const source = path.join(temporary, release.root);
				const make = await findExecutable('make', this.env, this.storage); const compiler = await findExecutable('cc', this.env, this.storage);
				if (!make || !compiler) { throw new Error(this.localize('Install a C compiler and make before building Ruby. On macOS, install Xcode Command Line Tools.')); }
				const configure = [`--prefix=${destination}`, '--disable-install-doc', '--disable-yjit'];
				if (process.platform === 'darwin') {
					for (const [name, option] of [['openssl@3', 'openssl'], ['libyaml', 'libyaml']] as const) {
						for (const prefix of ['/opt/homebrew/opt', '/usr/local/opt']) {
							const directory = path.join(prefix, name);
							try { if ((await fs.stat(directory)).isDirectory()) { configure.push(`--with-${option}-dir=${directory}`); break; } } catch { /* Use compiler defaults. */ }
						}
					}
				}
				operation.onOutput(this.localize('Building Ruby {0}. This may take several minutes.', version) + '\n');
				await this.run(path.join(source, 'configure'), configure, operation, source, 10 * 60 * 1000);
				await this.run(make, [`-j${Math.max(1, Math.min(os.availableParallelism(), 4))}`], operation, source, 90 * 60 * 1000);
				await this.run(make, ['install'], operation, source, 10 * 60 * 1000);
			}
			this.check(operation); const sdk = await this.validate(ruby, version, operation);
			await fs.rm(path.join(destination, '.ruby-studio-installing.json'));
			await fs.writeFile(path.join(destination, '.ruby-studio-sdk.json'), JSON.stringify({ version, platform: process.platform, arch: process.arch, url: release.url, sha256: release.sha256 }) + '\n');
			return sdk;
		} catch (error) {
			if (owned) {
				if (process.platform === 'win32') {
					const uninstaller = path.join(destination, 'unins000.exe');
					try {
						await fs.access(uninstaller);
						await this.run(uninstaller, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { ...operation, signal: AbortSignal.timeout(30000) }, this.storage, 30000);
					} catch { /* Remove only the partial files we created if setup rollback is unavailable. */ }
				}
				await fs.rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
			}
			this.check(operation); throw error;
		} finally { try { if (temporary) { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } } finally { await unlock(); } }
	}

	private async validate(ruby: string, version: string, operation: InstallerOperation): Promise<RuntimeInfo> {
		const sdk = await resolveRuntime({ cwd: this.storage, configuredPath: ruby, env: this.env, trusted: true });
		if (sdk.version.split(' ')[1]?.replace(/p\d+$/, '') !== version) { throw new Error(this.localize('The installed interpreter does not report Ruby {0}.', version)); }
		await this.run(sdk.ruby, ['-ropenssl', '-ryaml', '-rzlib', '-rfiddle', '-rrubygems', '-e', 'puts "Ruby SDK libraries validated"'], operation);
		return sdk;
	}
}
