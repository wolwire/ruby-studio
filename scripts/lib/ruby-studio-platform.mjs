/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';

export function target(platform = process.platform, arch = process.arch) {
	if (!['linux-x64', 'win32-x64', 'darwin-x64', 'darwin-arm64'].includes(`${platform}-${arch}`)) {
		throw new Error(`Unsupported native build target: ${platform}-${arch}. Build on a matching host; cross-compilation is not supported.`);
	}
	return { platform, arch, id: `${platform}-${arch}`, worker: `ruby-studio-lexer${platform === 'win32' ? '.exe' : ''}` };
}

export function appLayout(app, product, platform = process.platform) {
	if (platform === 'darwin') {
		const bundle = app.endsWith('.app') ? app : path.join(app, `${product.nameLong}.app`);
		return { bundle, resources: path.join(bundle, 'Contents/Resources/app'), executable: path.join(bundle, 'Contents/MacOS', product.nameShort) };
	}
	return { bundle: app, resources: path.join(app, 'resources/app'), executable: path.join(app, platform === 'win32' ? `${product.nameShort}.exe` : product.applicationName) };
}

export function readApp(app, platform = process.platform) {
	// Read the name from the checkout only to locate the macOS bundle; verify the
	// packaged product below rather than attributing the checkout to an older app.
	const candidates = platform === 'darwin'
		? (app.endsWith('.app') ? [app] : fs.readdirSync(app).filter(name => name.endsWith('.app')).map(name => path.join(app, name)))
		: [app];
	if (candidates.length !== 1) { throw new Error(`Expected exactly one application in ${app}`); }
	const resources = platform === 'darwin' ? path.join(candidates[0], 'Contents/Resources/app') : path.join(app, 'resources/app');
	const product = JSON.parse(fs.readFileSync(path.join(resources, 'product.json'), 'utf8'));
	return { product, ...appLayout(platform === 'darwin' ? candidates[0] : app, product, platform) };
}
