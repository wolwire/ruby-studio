/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Portable entry point. Linux retains its proven compiler/sysroot environment;
// Windows and macOS use their native toolchains and the same upstream tasks.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { target, readApp } from './lib/ruby-studio-platform.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...options] = process.argv.slice(2);
const allowed = { setup: ['--ci-toolchain'], build: ['--setup', '--ci-toolchain', '--check', '--package', '--package-only'], test: ['--unit-only', '--integration-only'], package: [] };
const has = option => options.includes(option);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();

async function main() {
	if (!command || command === '--help') {
		console.log('Usage: node scripts/ruby-studio.mjs setup|build|test|package [options]\nBuild: --setup --check --package; Linux setup: --ci-toolchain\nTest: --unit-only or --integration-only; archive an existing app: package\nNative hosts: Linux x64, Windows x64, macOS x64/arm64. See BUILDING_RUBY_STUDIO.md.');
		return;
	}
	if (!allowed[command] || options.some(option => !allowed[command].includes(option))) { throw new Error('Invalid command or option. Use --help.'); }
	if (has('--unit-only') && has('--integration-only')) { throw new Error('Choose only one test mode.'); }
	if (has('--package-only') && options.some(option => !['--package-only', '--package'].includes(option))) { throw new Error('--package-only cannot be combined with build/test/setup options.'); }
	if (command === 'build' && has('--ci-toolchain') && !has('--setup')) { throw new Error('--ci-toolchain requires --setup.'); }
	const host = target();
	for (const name of ['VSCODE_ARCH', 'npm_config_arch']) {
		if (process.env[name] && process.env[name] !== host.arch) { throw new Error(`${name} must match the native Node architecture (${host.arch}).`); }
	}
	if (host.platform === 'linux') {
		const scripts = { setup: 'setup', build: 'build', test: 'test', package: 'package' };
		const child = spawn('bash', [path.join(source, `scripts/${scripts[command]}-ruby-studio.sh`), ...options], { stdio: 'inherit', cwd: source });
		await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`Linux ${command} failed (${code}).`))); });
		return;
	}
	if (has('--ci-toolchain')) { throw new Error('--ci-toolchain is Linux-only; macOS uses Xcode and Windows uses Visual Studio 2022.'); }
	const required = fs.readFileSync(path.join(source, '.nvmrc'), 'utf8').trim().split('.').map(Number);
	const actual = process.versions.node.split('.').map(Number);
	if (actual[0] !== required[0] || actual[1] < required[1] || actual[1] === required[1] && actual[2] < required[2]) { throw new Error(`Use Node.js ${required.join('.')} or newer in major ${required[0]}.`); }
	const app = path.resolve(process.env.RUBY_STUDIO_APP_DIR || path.join(source, `../VSCode-${host.id}`));
	if (command === 'build' && !has('--package-only') && app !== path.resolve(source, `../VSCode-${host.id}`)) { throw new Error('RUBY_STUDIO_APP_DIR is only an override for testing/packaging an existing app.'); }
	const log = path.resolve(process.env.RUBY_STUDIO_LOG_DIR || path.join(source, '.build/ruby-studio/logs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`));
	fs.mkdirSync(log, { recursive: true });
	Object.assign(process.env, { RUBY_STUDIO_LOG_DIR: log, VSCODE_ARCH: host.arch, npm_config_arch: host.arch, npm_command: 'ci', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', ELECTRON_SKIP_BINARY_DOWNLOAD: '1' });
	if (host.platform === 'darwin') { process.env.GYP_DEFINES = `${process.env.GYP_DEFINES || ''} kerberos_use_rtld=false`.trim(); }
	console.log(`Ruby Studio ${host.id}; logs: ${log}`);
	fs.writeFileSync(path.join(log, 'environment.txt'), `${process.version}\n${host.id}\n${git(['rev-parse', 'HEAD'])}\n`);
	const npmCandidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
	const npm = npmCandidates.find(file => file && fs.existsSync(file));
	if (!npm) { throw new Error('Cannot locate npm-cli.js beside Node. Use an official Node distribution with npm.'); }
	if (Number(execFileSync(process.execPath, [npm, '--version'], { encoding: 'utf8' }).split('.')[0]) >= 12) { throw new Error('This checkout requires npm below version 12.'); }

	async function run(name, executable, args, cwd = source, timeout = 30 * 60 * 1000) {
		console.log(`\nRuby Studio: ${name}`);
		const output = fs.createWriteStream(path.join(log, `${name}.log`));
		try {
			await new Promise((resolve, reject) => {
				const child = spawn(executable, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
				let expired = false;
				const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
				child.stdout.on('data', chunk => { process.stdout.write(chunk); output.write(chunk); });
				child.stderr.on('data', chunk => { process.stderr.write(chunk); output.write(chunk); });
				child.on('error', error => { clearTimeout(timer); reject(error); });
				child.on('close', code => { clearTimeout(timer); code === 0 && !expired ? resolve() : reject(new Error(`${name} ${expired ? 'timed out' : `failed (${code})`}; see ${log}`)); });
			});
		} finally { await new Promise(resolve => output.end(resolve)); }
	}
	const node = (name, args, cwd, timeout) => run(name, process.execPath, args, cwd, timeout);
	const npmRun = (name, args, cwd) => node(name, [npm, ...args], cwd);
	const artifact = (mode, ...args) => node(`${mode}-artifact`, ['scripts/lib/ruby-studio-artifact.mjs', mode, app, ...args]);
	async function setup() {
		await npmRun('setup-build', ['ci', '--no-audit', '--no-fund'], path.join(source, 'build'));
		// On Windows this must run before root dependency installation: it overlays
		// the custom V8 headers required by Electron's native modules.
		if (host.platform === 'win32') { await node('setup-electron-headers', ['build/npm/preinstall.ts']); }
		process.env.VSCODE_FORCE_INSTALL = '1';
		for (let attempt = 1; attempt <= 3; attempt++) {
			try { await npmRun('setup-workspace', ['ci', '--no-audit', '--no-fund']); break; }
			catch (error) {
				const output = fs.readFileSync(path.join(log, 'setup-workspace.log'), 'utf8');
				// The upstream Windows installer also retries npm. Restrict this to
				// the observed native fast-fail; do not mask dependency/compiler errors.
				if (host.platform !== 'win32' || attempt === 3 || !/Process exited with code:\s*(?:3221226505|-1073740791|0xc0000409)/i.test(output)) { throw error; }
				fs.copyFileSync(path.join(log, 'setup-workspace.log'), path.join(log, `setup-workspace-attempt-${attempt}.log`));
				console.warn(`Windows npm subprocess exited with native error 0xC0000409. Retrying locked installation (${attempt + 1}/3); previous output retained.`);
			}
		}
	}
	async function compile() {
		await npmRun('typecheck-core', ['run', 'compile-check-ts-native']);
		await npmRun('typecheck-build', ['run', 'typecheck'], path.join(source, 'build'));
		await npmRun('compile-extensions', ['run', 'gulp', 'compile-extensions']);
	}
	async function native() {
		if (process.env.CARGO_BUILD_TARGET) { throw new Error('Remove CARGO_BUILD_TARGET: these builds require the native host worker.'); }
		const rustHost = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
		const expected = host.platform === 'win32' ? 'x86_64-pc-windows-msvc' : `${host.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`;
		if (rustHost !== expected) { throw new Error(`Use the matching native Rust toolchain: expected ${expected}, found ${rustHost}.`); }
		await run('build-native', 'cargo', ['build', '--release', '--locked', '--manifest-path', 'extensions/ruby-studio/native/Cargo.toml']);
		const built = path.resolve(source, process.env.CARGO_TARGET_DIR || 'extensions/ruby-studio/native/target', 'release', host.worker);
		if (host.platform === 'darwin') { await run('sign-native', '/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', built]); }
		process.env.RUBY_STUDIO_NATIVE_LEXER = built;
		const destination = path.join(source, 'extensions/ruby-studio/native/bin', host.id, host.worker);
		fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(built, destination); fs.chmodSync(destination, 0o755);
	}
	async function test() {
		const ruby = process.env.RUBY_STUDIO_TEST_RUBY || process.env.RUBY_STUDIO_RUBY || 'ruby';
		const rubyPath = execFileSync(ruby, ['-rrbconfig', '-e', 'print RbConfig.ruby'], { encoding: 'utf8' }).trim();
		Object.assign(process.env, { RUBY_STUDIO_TEST_RUBY: rubyPath, RUBY_STUDIO_RUBY: rubyPath });
		await run('test-ruby-prerequisites', rubyPath, ['-rjson', '-ropenssl', '-rrubygems', '-rminitest', '-rrspec/core', '-e', 'abort "Ruby 3.1 or newer is required" if Gem::Version.new(RUBY_VERSION) < Gem::Version.new("3.1"); puts RUBY_DESCRIPTION']);
		await compile(); await native();
		if (!has('--integration-only')) {
			await run('check-native', 'cargo', ['check', '--locked', '--manifest-path', 'extensions/ruby-studio/native/Cargo.toml']);
			await run('test-native', 'cargo', ['test', '--locked', '--manifest-path', 'extensions/ruby-studio/native/Cargo.toml']);
			const tests = fs.readdirSync(path.join(source, 'extensions/ruby-studio/test')).filter(file => file.endsWith('.test.js')).map(file => `extensions/ruby-studio/test/${file}`);
			await node('test-unit', ['--test', '--test-reporter=tap', ...tests, 'extensions/ruby-studio/native/tests/parity.test.js', ...fs.readdirSync(path.join(source, 'scripts/lib')).filter(file => file.startsWith('ruby-studio-') && file.endsWith('.test.mjs')).map(file => `scripts/lib/${file}`)]);
		}
		if (has('--unit-only')) { return; }
		await artifact('verify');
		const layout = readApp(app);
		const qa = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-studio-check-'));
		const result = path.join(log, 'native-integration-result.json');
		const checkResult = file => { const report = json(file); if (!report.success || !report.checks?.length || report.checks.some(check => check.status !== 'passed')) { throw new Error(`Desktop test did not report success: ${file}`); } };
		try {
			fs.mkdirSync(path.join(qa, 'workspace'));
			fs.rmSync(result, { force: true });
			fs.rmSync(path.join(log, 'settings-window.json'), { force: true });
			process.env.RUBY_STUDIO_INTEGRATION_RESULT = result;
			await run('test-integration', layout.executable, ['--disable-gpu', '--disable-workspace-trust', `--user-data-dir=${path.join(qa, 'profile')}`, `--extensions-dir=${path.join(qa, 'extensions')}`, `--extensionDevelopmentPath=${path.join(layout.resources, 'extensions/ruby-studio')}`, `--extensionTestsPath=${path.join(source, 'extensions/ruby-studio/test/integration.js')}`, path.join(qa, 'workspace')], source, 5 * 60 * 1000);
			checkResult(result);
			Object.assign(process.env, { RUBY_STUDIO_APP: layout.executable, RUBY_STUDIO_SETTINGS_RESULT: path.join(log, 'settings-window.json'), RUBY_STUDIO_SETTINGS_LOG: path.join(log, 'settings-window-electron.log') });
			await node('test-settings-window', ['extensions/ruby-studio/test/settings-window.cjs'], source, 5 * 60 * 1000);
			checkResult(process.env.RUBY_STUDIO_SETTINGS_RESULT);
		} finally {
			const electronLogs = path.join(qa, 'profile/logs');
			if (fs.existsSync(electronLogs)) { fs.cpSync(electronLogs, path.join(log, 'electron-logs'), { recursive: true }); }
			fs.rmSync(qa, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
		}
	}
	async function pack() {
		await artifact('verify');
		const layout = readApp(app);
		const receipt = path.join(app, 'ruby-studio-build.json');
		const revision = fs.existsSync(receipt) ? json(receipt).sourceCommit.slice(0, 12) : 'unverified';
		const version = json(path.join(layout.resources, 'package.json')).version;
		const directory = path.resolve(process.env.RUBY_STUDIO_ARTIFACT_DIR || path.join(source, 'dist/ruby-studio'));
		fs.mkdirSync(directory, { recursive: true });
		const name = `ruby-studio-${host.id}-${version}-${revision}`;
		const archive = path.join(directory, `${name}.zip`);
		const metadata = path.join(directory, `${name}.build-info.json`);
		await artifact('metadata', metadata);
		fs.rmSync(archive, { force: true });
		if (host.platform === 'darwin') {
			await node('verify-macos-signature', ['scripts/sign-ruby-studio-macos.mjs', 'verify', app]);
			// ditto preserves framework symlinks, executable modes and bundle metadata.
			await run('archive', 'ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', layout.bundle, archive]);
			const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-studio-archive-'));
			try {
				await run('extract-archive', 'ditto', ['-x', '-k', archive, extracted]);
				await node('verify-extracted-signature', ['scripts/sign-ruby-studio-macos.mjs', 'verify', extracted]);
				// Run the same real desktop tests against what users extract, with a
				// fresh profile rather than the unarchived build output.
				process.env.RUBY_STUDIO_APP_DIR = extracted;
				process.env.RUBY_STUDIO_LOG_DIR = path.join(log, 'extracted-archive');
				await node('test-extracted-archive', ['scripts/ruby-studio.mjs', 'test', '--integration-only']);
			} finally { fs.rmSync(extracted, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
		} else {
			await run('archive', '7z', ['a', '-tzip', archive, '.'], app);
		}
		const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
		fs.writeFileSync(path.join(directory, 'SHA256SUMS'), [archive, metadata].map(file => `${hash(file)}  ${path.basename(file)}\n`).join(''));
		console.log(`Ruby Studio archive: ${archive}`);
	}
	if (command === 'setup') { await setup(); }
	if (command === 'test') { await test(); }
	if (command === 'build' && !has('--package-only')) {
		if (has('--setup')) { await setup(); }
		await compile(); await native();
		for (const task of ['copy-codicons', 'compile-non-native-extensions-build', 'compile-extension-media-build']) { await npmRun(task, ['run', 'gulp', task]); }
		await node('bundle-desktop', ['build/next/index.ts', 'bundle', '--out', 'out-vscode', '--nls', '--target', 'desktop']);
		await npmRun('package-desktop', ['run', 'gulp', `vscode-${host.id}-ci`]);
		if (host.platform === 'darwin') { await node('sign-macos', ['scripts/sign-ruby-studio-macos.mjs', 'sign', app]); }
		await artifact('verify'); await artifact('record-build');
		if (has('--check')) { await test(); }
	}
	if (command === 'package' || has('--package') || has('--package-only')) { await pack(); }
}
main().catch(error => { console.error(`Ruby Studio: ${error.stack}`); process.exitCode = 1; });
