/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Real native-window test. Run after building, inside Xvfb when no desktop display exists.
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const source = path.resolve(__dirname, '../../..');
const app = process.env.RUBY_STUDIO_APP || path.resolve(source, '../VSCode-linux-x64/ruby-studio');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, milliseconds = 20000) { const end = Date.now() + milliseconds; while (Date.now() < end) { const result = await fn(); if (result) { return result; } await wait(50); } throw new Error(label + ' timed out'); }
(async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ruby-studio-settings-'));
	const workspace = path.join(directory, 'project'); await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'main.rb'), 'puts "native settings"\n');
	const settingsFile = path.join(workspace, '.vscode/settings.json'); const runFile = path.join(workspace, '.ruby-studio/run-configurations.json');
	const reports = { suite: 'Native Settings and Interpreter Windows', checks: [], startedAt: new Date().toISOString() };
	const portServer = net.createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve)); const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
	const environment = { ...process.env };
	try { if (!environment.CHROME_DEVEL_SANDBOX && (await fs.readFile(path.join(path.dirname(app), 'chrome-sandbox'))).equals(await fs.readFile('/usr/share/code/chrome-sandbox'))) { environment.CHROME_DEVEL_SANDBOX = '/usr/share/code/chrome-sandbox'; } } catch { /* Use the configured host sandbox. */ }
	const args = [ '--disable-gpu', '--disable-workspace-trust', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(directory, 'profile')}`, `--extensions-dir=${path.join(directory, 'extensions')}`, workspace, path.join(workspace, 'main.rb')];
	if (process.platform === 'linux') { args.unshift('--ozone-platform=x11'); }
	if (process.env.RUBY_STUDIO_TEST_NO_SANDBOX === '1') { args.unshift('--no-sandbox'); }
	if (process.env.RUBY_STUDIO_SETTINGS_DEV) { args.unshift(`--extensionDevelopmentPath=${path.join(source, 'extensions/ruby-studio')}`); }
	const child = spawn(app, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] }); let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; }); let browser;
	const check = async (name, fn) => { const start = Date.now(); await fn(); reports.checks.push({ name, status: 'passed', durationMs: Date.now() - start }); };
	try {
		await until(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return browser; } catch { return false; } }, 'Native startup');
		const context = browser.contexts()[0]; const main = await until(() => context.pages().find(page => page.url().includes('workbench.html')), 'Main workbench');
		const frameFor = async page => until(async () => { for (const frame of page.frames()) { if (await frame.locator('#app footer').count()) { return frame; } } }, 'Settings webview');
		const popup = async () => until(() => context.pages().find(page => page !== main && !page.isClosed()), 'Dedicated native window');
		const readSettings = async () => { try { return JSON.parse(await fs.readFile(settingsFile, 'utf8')); } catch (error) { if (error.code === 'ENOENT') { return {}; } throw error; } };
		const openSdk = async () => { await main.bringToFront(); await main.locator('[data-command="rubyStudio.selectInterpreter"]').click(); const page = await popup(); return { page, frame: await frameFor(page) }; };
		const openRuns = async () => {
			await main.bringToFront();
			if (await main.locator('[data-command="rubyStudio.editRunConfigurations"]').count()) { await main.locator('[data-command="rubyStudio.editRunConfigurations"]').click(); }
			else { await main.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P'); await main.locator('.quick-input-widget input').fill('Ruby Studio: Edit Run/Debug Configurations'); await main.locator('.quick-input-widget .monaco-list-row').filter({ hasText: 'Edit Run/Debug Configurations' }).first().waitFor(); await main.keyboard.press('Enter'); }
			const page = await popup(); return { page, frame: await frameFor(page) };
		};
		let page, frame;
		await check('Interpreter opens a separate native window and preserves the source editor', async () => {
			({ page, frame } = await openSdk()); assert.equal(context.pages().length, 2); await frame.getByLabel('Ruby Executable', { exact: true }).waitFor(); assert.ok((await main.locator('body').innerText()).includes('main.rb'));
		});
		await check('Failed SDK validation keeps the window open and configuration unchanged', async () => {
			await frame.getByLabel('Ruby Executable', { exact: true }).fill('/missing/ruby-studio-interpreter'); await frame.getByRole('button', { name: 'Apply', exact: true }).click(); await frame.locator('#status.error').waitFor(); assert.deepEqual(await readSettings(), {}); assert.equal(page.isClosed(), false);
		});
		await check('Validate and Refresh Gems inspect the real selected Ruby', async () => {
			await frame.getByLabel('Ruby Executable', { exact: true }).fill(process.env.RUBY_STUDIO_RUBY || process.env.RUBY_STUDIO_TEST_RUBY || 'ruby'); await frame.getByRole('button', { name: 'Validate', exact: true }).click(); await frame.locator('#runtime').filter({ hasText: /ruby \d/ }).waitFor(); await frame.getByRole('button', { name: 'Refresh Gems', exact: true }).click(); await frame.locator('.gem').first().waitFor();
		});
		await check('Apply persists without closing; Cancel discards only later changes', async () => {
			await frame.getByRole('button', { name: 'Apply', exact: true }).click(); await until(async () => (await readSettings())['rubyStudio.interpreterPath'], 'SDK apply'); assert.equal(page.isClosed(), false);
			const applied = (await readSettings())['rubyStudio.interpreterPath']; await frame.getByLabel('Ruby Executable', { exact: true }).fill('/cancelled/value'); await frame.getByRole('button', { name: 'Cancel', exact: true }).click(); await until(() => page.isClosed(), 'Cancel closes window'); assert.equal((await readSettings())['rubyStudio.interpreterPath'], applied);
		});
		await check('Reopening an existing dialog focuses it without duplicating windows', async () => {
			({ page, frame } = await openSdk()); await main.bringToFront(); await main.locator('[data-command="rubyStudio.selectInterpreter"]').click(); await wait(300); assert.equal(context.pages().length, 2); assert.equal(page.isClosed(), false); assert.ok(await frame.locator('#app').count());
		});
		await check('Settings search, Ruby indentation, project Apply and OK', async () => {
			await frame.getByRole('button', { name: 'Editor', exact: true }).click(); await frame.getByLabel('Ruby Indent Size', { exact: true }).fill('3'); await frame.getByRole('button', { name: 'Apply', exact: true }).click(); await until(async () => (await readSettings())['[ruby]']?.['editor.tabSize'] === 3, 'Ruby indentation scope');
			await frame.getByRole('searchbox').fill('font size'); await frame.getByLabel('Font Size', { exact: true }).fill('18'); await frame.getByRole('button', { name: 'OK', exact: true }).click(); await until(() => page.isClosed(), 'OK closes'); assert.equal((await readSettings())['editor.fontSize'], 18);
		});
		await check('User and project scopes display and persist their own values', async () => {
			({ page, frame } = await openSdk()); await frame.getByRole('button', { name: 'Editor', exact: true }).click(); await frame.locator('#scope').selectOption('user'); await until(async () => await frame.locator('#scope').inputValue() === 'user' && await frame.getByLabel('Font Size', { exact: true }).inputValue() !== '18', 'User scope values');
			await frame.getByLabel('Font Size', { exact: true }).fill('17'); await frame.getByRole('button', { name: 'Apply', exact: true }).click(); await until(async () => { try { return JSON.parse(await fs.readFile(path.join(directory, 'profile/User/settings.json'), 'utf8'))['editor.fontSize'] === 17; } catch (error) { if (error.code === 'ENOENT') { return false; } throw error; } }, 'User settings apply'); assert.equal((await readSettings())['editor.fontSize'], 18);
			await frame.locator('#scope').selectOption('project'); await until(async () => await frame.getByLabel('Font Size', { exact: true }).inputValue() === '18', 'Project scope values');
			if (process.env.RUBY_STUDIO_SETTINGS_SCREENSHOT) { await page.screenshot({ path: process.env.RUBY_STUDIO_SETTINGS_SCREENSHOT }); }
			await frame.getByRole('button', { name: 'Cancel', exact: true }).click(); await until(() => page.isClosed(), 'Scope window close');
		});
		await check('Run configuration window validates and saves executable argument arrays', async () => {
			({ page, frame } = await openRuns()); await frame.getByRole('button', { name: 'Add', exact: true }).click();
			await frame.getByLabel('Name', { exact: true }).fill('Native Run'); await frame.getByLabel('Arguments (JSON Array)', { exact: true }).fill('["argument with spaces", "literal$"]'); await frame.getByLabel('Environment (JSON Object)', { exact: true }).fill('{"MARKER":"settings"}'); await frame.getByRole('button', { name: 'Apply', exact: true }).click();
			await until(async () => { try { return JSON.parse(await fs.readFile(runFile, 'utf8')).configurations.length === 1; } catch { return false; } }, 'Run configuration save'); const saved = JSON.parse(await fs.readFile(runFile, 'utf8')).configurations[0]; assert.deepEqual(saved.args, ['argument with spaces', 'literal$']); assert.equal(saved.env.MARKER, 'settings'); await until(async () => (await readSettings())['rubyStudio.runConfiguration'] === 'Native Run', 'Selected run configuration');
			await frame.getByLabel('Arguments (JSON Array)', { exact: true }).fill('not json'); await frame.getByRole('button', { name: 'OK', exact: true }).click(); await frame.locator('#status.error').waitFor(); assert.equal(page.isClosed(), false); assert.deepEqual(JSON.parse(await fs.readFile(runFile, 'utf8')).configurations[0].args, saved.args); await frame.getByRole('button', { name: 'Cancel', exact: true }).click(); await until(() => page.isClosed(), 'Run window cancel');
		});
		await check('Repeated interpreter and run-window transfers keep their webviews loaded', async () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				for (const open of [openSdk, openRuns]) {
					({ page, frame } = await open()); assert.equal(context.pages().length, 2);
					await frame.getByRole('button', { name: 'Cancel', exact: true }).click(); await until(() => page.isClosed(), 'Repeated dialog close');
				}
			}
		});
		reports.success = true;
	} catch (error) {
		reports.success = false; reports.error = error.stack; console.error(error); process.exitCode = 1;
		if (browser) {
			reports.windows = await Promise.all(browser.contexts()[0].pages().map(async page => ({ url: page.url(), frames: await Promise.all(page.frames().map(async frame => ({ url: frame.url(), html: await frame.content().catch(error => String(error)) }))) })));
		}
	}
	finally {
		reports.finishedAt = new Date().toISOString(); if (browser) { await browser.close(); }
		if (process.platform === 'win32' && child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* Already exited. */ } }
		else { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(3000)]); if (child.exitCode === null) { child.kill('SIGKILL'); } }
		const destination = process.env.RUBY_STUDIO_SETTINGS_RESULT || path.join(os.tmpdir(), 'ruby-studio-settings-result.json'); await fs.writeFile(destination, JSON.stringify(reports, null, 2) + '\n'); if (process.env.RUBY_STUDIO_SETTINGS_LOG) { await fs.writeFile(process.env.RUBY_STUDIO_SETTINGS_LOG, logs); await fs.cp(path.join(directory, 'profile/logs'), path.join(path.dirname(destination), 'settings-electron-logs'), { recursive: true }).catch(() => {}); } await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); console.log(JSON.stringify({ ...reports, windows: undefined }));
	}
})();
