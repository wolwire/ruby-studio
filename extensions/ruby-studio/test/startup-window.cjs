/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root.
 *--------------------------------------------------------------------------------------------*/
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, limit = 45000) { const end = Date.now() + limit; while (Date.now() < end) { const value = await fn(); if (value) { return value; } await delay(100); } throw new Error(`${label} timed out`); }
(async () => {
	const app = process.env.RUBY_STUDIO_APP; assert.ok(app);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rs-startup-'));
	const project = path.join(root, 'Restored Ruby Project'); await fs.mkdir(project);
	await fs.writeFile(path.join(project, 'main.rb'), 'class StartupFixture\nend\n');
	const profile = path.join(root, 'profile'); await fs.mkdir(path.join(profile, 'User'), { recursive: true });
	await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'window.restoreWindows': 'all', 'window.confirmBeforeClose': 'never', 'rubyStudio.interpreterPath': process.env.RUBY_STUDIO_RUBY || '' }));
	await fs.writeFile(path.join(profile, 'User/keybindings.json'), JSON.stringify([{ key: 'ctrl+alt+shift+q', command: 'workbench.action.quit' }, { key: 'ctrl+alt+shift+r', command: 'workbench.action.reloadWindow' }]));
	const report = { suite: 'Native Ruby Studio Default Startup', success: false, checks: [] }; let child; let browser; let main; let exited; let logs = '';
	const check = async (name, fn) => { await fn(); report.checks.push({ name, status: 'passed' }); };
	const launch = async extras => {
		const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve));
		const flags = ['--disable-gpu', '--disable-workspace-trust', '--skip-release-notes', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--extensions-dir=${path.join(root, 'extensions')}`, `--shared-data-dir=${path.join(root, 'shared')}`, ...extras];
		if (process.platform === 'linux') { flags.unshift('--no-sandbox', '--ozone-platform=x11'); }
		child = spawn(app, flags, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); exited = new Promise(resolve => child.once('exit', resolve));
		child.stdout.on('data', chunk => logs += chunk); child.stderr.on('data', chunk => logs += chunk);
		await until(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return browser; } catch { return false; } }, 'Application startup');
		main = await until(() => browser.contexts()[0]?.pages().find(page => page.url().includes('workbench.html')), 'Workbench');
		await main.locator('.monaco-workbench').waitFor();
	};
	const quit = async () => {
		await main.keyboard.press('Control+Alt+Shift+Q');
		await Promise.race([exited, delay(15000).then(() => { throw new Error('Clean quit timed out'); })]);
		await browser.close(); browser = undefined; child = undefined;
	};
	try {
		await launch([project, path.join(project, 'main.rb')]);
		await check('Normal app startup shows project entry actions even with a project open', async () => { await main.locator('.ruby-studio-welcome-dialog').waitFor(); assert.equal(await main.getByRole('button', { name: 'New Project', exact: true }).count(), 1); });
		await main.getByRole('button', { name: 'Close', exact: true }).click();
		await check('Reloading the editor does not display the startup dialog again', async () => {
			await Promise.all([main.waitForEvent('load'), main.keyboard.press('Control+Alt+Shift+R')]);
			await main.locator('.monaco-workbench').waitFor();
			await until(async () => await main.getByText('Project: ready', { exact: false }).count(), 'Restored project environment');
			assert.equal(await main.locator('.ruby-studio-welcome-dialog').count(), 0);
		});
		await quit(); await launch([]);
		await check('Relaunching without arguments shows welcome over the restored project and opens the new-project form', async () => {
			await main.locator('.ruby-studio-welcome-dialog').waitFor();
			assert.ok(await main.getByText('Restored Ruby Project', { exact: false }).count());
			assert.ok(await main.locator('button.recent-project').count());
			if (process.env.RUBY_STUDIO_STARTUP_SCREENSHOT) { await main.screenshot({ path: process.env.RUBY_STUDIO_STARTUP_SCREENSHOT }); }
			await main.getByRole('button', { name: 'New Project', exact: true }).click(); await main.locator('.ruby-project-form').waitFor();
			await main.getByRole('button', { name: 'Cancel', exact: true }).click();
		});
		await quit(); await launch(['--skip-welcome']);
		await check('Explicit skip-welcome launches directly into the restored project', async () => { await until(async () => await main.getByText('Project: ready', { exact: false }).count(), 'Direct project launch'); assert.equal(await main.locator('.ruby-studio-welcome-dialog').count(), 0); });
		await quit(); report.success = true;
	} catch (error) { report.error = error.stack; throw error; }
	finally {
		await fs.writeFile(process.env.RUBY_STUDIO_STARTUP_RESULT || path.join(os.tmpdir(), 'ruby-startup-result.json'), JSON.stringify(report, null, 2));
		await fs.writeFile(process.env.RUBY_STUDIO_STARTUP_LOG || path.join(os.tmpdir(), 'ruby-startup.log'), logs);
		if (browser) { await browser.close().catch(() => {}); } if (child) { child.kill('SIGTERM'); await exited; }
		await fs.rm(root, { recursive: true, force: true });
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
