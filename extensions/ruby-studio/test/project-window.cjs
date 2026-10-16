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
async function until(fn, label, limit = 40000) { const end = Date.now() + limit; while (Date.now() < end) { const value = await fn(); if (value) { return value; } await delay(100); } throw new Error(`${label} timed out`); }
(async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruby-project-native-')); const app = process.env.RUBY_STUDIO_APP; const ruby = process.env.RUBY_STUDIO_RUBY;
	assert.ok(app && ruby, 'RUBY_STUDIO_APP and RUBY_STUDIO_RUBY are required');
	const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve));
	const report = { suite: 'Native Project Welcome and Creation', checks: [], success: false };
	const alternate = path.join(root, 'alternate-sdk/bin'); await fs.mkdir(alternate, { recursive: true });
	await fs.writeFile(path.join(alternate, 'ruby'), `#!/bin/sh\nexec '${ruby.replace(/'/g, "'\\''")}' \"$@\"\n`, { mode: 0o755 });
	const args = ['--no-sandbox', '--ozone-platform=x11', '--disable-gpu', '--disable-workspace-trust', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, 'profile')}`, `--extensions-dir=${path.join(root, 'extensions')}`, `--shared-data-dir=${path.join(root, 'shared')}`];
	const child = spawn(app, args, { env: { ...process.env, PATH: alternate + path.delimiter + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }); let logs = ''; child.stdout.on('data', chunk => logs += chunk); child.stderr.on('data', chunk => logs += chunk); let browser;
	const check = async (name, fn) => { await fn(); report.checks.push({ name, status: 'passed' }); };
	try {
		await until(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return browser; } catch { return false; } }, 'Desktop startup');
		const context = browser.contexts()[0]; let main = await until(() => context.pages().find(page => page.url().includes('workbench.html')), 'Workbench');
		await check('First launch displays native welcome and project actions', async () => { await main.locator('.ruby-studio-welcome-dialog').waitFor(); assert.equal(await main.getByRole('button', { name: 'New Project', exact: true }).count(), 1); });
		await main.getByRole('button', { name: 'New Project', exact: true }).click(); await main.locator('.ruby-project-form').waitFor();
		await check('Empty project form validates name and keeps cancellation free of files', async () => {
			await main.locator('.ruby-project-row input').nth(0).fill('../escape'); await until(() => main.getByRole('button', { name: 'Create', exact: true }).isDisabled(), 'Disabled invalid create');
			await main.locator('.ruby-project-row input').nth(0).fill('Cancelled Project'); await main.locator('.ruby-project-row input').nth(1).fill(root);
			await main.getByRole('button', { name: 'Cancel', exact: true }).click(); await main.locator('.ruby-studio-welcome-dialog').waitFor(); await assert.rejects(fs.access(path.join(root, 'Cancelled Project')), { code: 'ENOENT' });
		});
		await main.getByRole('button', { name: 'New Project', exact: true }).click(); await main.locator('.ruby-project-form').waitFor();
		await main.locator('.ruby-project-row input').nth(0).fill('Invoice Tools-1'); await main.locator('.ruby-project-row input').nth(1).fill(root); const choices = await main.locator('.ruby-project-row select option').evaluateAll(options => options.map(option => option.value));
		const chosenRuby = choices.find(value => value && value !== ruby); assert.ok(chosenRuby, 'The native fixture requires a second installed SDK');
		await main.locator('.ruby-project-row select').selectOption(chosenRuby);
		await until(async () => !await main.getByRole('button', { name: 'Create', exact: true }).isDisabled(), 'Validated create');
		if (process.env.RUBY_STUDIO_PROJECT_SCREENSHOT) { await main.screenshot({ path: process.env.RUBY_STUDIO_PROJECT_SCREENSHOT }); }
		await main.getByRole('button', { name: 'Create', exact: true }).click();
		const destination = path.join(root, 'Invoice Tools-1');
		await check('Creation persists the selected SDK and test-root metadata without a skeleton', async () => {
			const settings = await until(async () => { try { return JSON.parse(await fs.readFile(path.join(destination, '.vscode/settings.json'), 'utf8')); } catch { return false; } }, 'Persisted settings');
			assert.deepEqual({ sdk: settings['rubyStudio.interpreterPath'], roots: settings['rubyStudio.testRoots'], files: await fs.readdir(destination) }, { sdk: chosenRuby, roots: ['features', 'spec', 'test'], files: ['.vscode'] });
		});
		await check('New project opens and initializes its own environment', async () => {
			main = await until(async () => { for (const page of context.pages()) { if (!page.isClosed() && page.url().includes('workbench.html') && await page.getByText('Project: ready', { exact: false }).count()) { return page; } } }, 'Initialized project', 90000);
			assert.ok(await main.getByText('Invoice Tools-1', { exact: false }).count());
			assert.equal(await main.locator('.ruby-studio-welcome-dialog').count(), 0);
		});
		report.success = true;
	} catch (error) { report.error = error.stack; if (browser) { const page = browser.contexts()[0].pages().find(page => !page.isClosed()); if (page) { await page.screenshot({ path: '/tmp/ruby-project-native-failure.png' }).catch(() => {}); } } throw error; }
	finally { if (process.env.RUBY_STUDIO_PROJECT_RESULT) { await fs.writeFile(process.env.RUBY_STUDIO_PROJECT_RESULT, JSON.stringify(report, null, 2)); } await fs.writeFile('/tmp/ruby-project-native.log', logs); if (browser) { await browser.close(); } child.kill('SIGTERM'); await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
