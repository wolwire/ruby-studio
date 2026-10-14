/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Pure parsers live beside extension registrations. The API stub only permits loading
// those modules; these tests neither activate the extension nor launch project code.
function load(name) {
	const filename = path.join(__dirname, '..', 'out', `${name}.js`);
	const exports = {};
	vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
		exports, module: { exports }, require: id => id === 'vscode' ? { TreeItem: class { } } : createRequire(filename)(id),
	}, { filename });
	return exports;
}
const { parseRailsRoutes, parseRailsGeneratorArguments } = load('rails');
const { parseGemfileLock } = load('dependencies');
const plain = value => JSON.parse(JSON.stringify(value));

test('expanded Rails routes preserve endpoint identity and source locations', () => {
	assert.deepEqual(plain(parseRailsRoutes(`--[ Route 1 ]---------------------------
Prefix            | users
Verb              | GET
URI               | /users(.:format)
Controller#Action | users#index
Source Location   | /project/config/routes.rb:12
--[ Route 2 ]---------------------------
Prefix            | admin
Verb              |
URI               | /admin
Controller#Action | Admin::Engine
`)), [
		{ label: 'GET /users(.:format)', description: 'users', detail: 'users#index', controller: 'users', action: 'index', source: '/project/config/routes.rb', line: 11 },
		{ label: 'ANY /admin', description: 'admin', detail: 'Admin::Engine', controller: 'Admin::Engine', line: 0 }
	]);
});

test('empty, failed or conventional routes output does not invent expanded routes', () => {
	assert.deepEqual([parseRailsRoutes(''), parseRailsRoutes('rails aborted!'), parseRailsRoutes('Prefix Verb URI Pattern Controller#Action')].map(plain), [[], [], []]);
});

test('Rails generators distinguish actions from fields and reject shell syntax', () => {
	assert.deepEqual(plain(parseRailsGeneratorArguments('controller', 'index show')), ['index', 'show']);
	assert.deepEqual(plain(parseRailsGeneratorArguments('mailer', 'welcome')), ['welcome']);
	assert.deepEqual(plain(parseRailsGeneratorArguments('model', 'name:string price:decimal{10,2} customer:references')), ['name:string', 'price:decimal{10,2}', 'customer:references']);
	assert.deepEqual(plain(parseRailsGeneratorArguments('job', '')), []);
	for (const [generator, args] of [['controller', 'name:string'], ['model', 'index'], ['model', '--force'], ['controller', 'index;rm'], ['mailer', '$(id)'], ['job', 'unexpected'], ['unknown', '']]) {
		assert.equal(parseRailsGeneratorArguments(generator, args), undefined, `${generator}: ${args}`);
	}
});

test('lockfile reader separates resolved gems from requirements and Bundler metadata', () => {
	const fixture = `GIT
  remote: https://example.invalid/library.git
  revision: abc
  specs:
    local_library (1.0.0)
      rack (>= 2)

GEM
  remote: https://rubygems.org/
  specs:
    rack (3.1.2)
    puma (6.4.2-x86_64-linux)
      nio4r (~> 2.0)
    nio4r (2.7.3)

PLATFORMS
  x86_64-linux

DEPENDENCIES
  local_library!
  puma (~> 6)

BUNDLED WITH
   2.5.9
`;
	assert.deepEqual(plain(parseGemfileLock(fixture)).map(({ name, version, dependencies }) => ({ name, version, dependencies })), [
		{ name: 'local_library', version: '1.0.0', dependencies: ['rack'] },
		{ name: 'nio4r', version: '2.7.3', dependencies: [] },
		{ name: 'puma', version: '6.4.2-x86_64-linux', dependencies: ['nio4r'] },
		{ name: 'rack', version: '3.1.2', dependencies: [] }
	]);
});

test('lockfile source navigation uses actual source lines and supports CRLF', () => {
	assert.deepEqual(plain(parseGemfileLock('GEM\r\n  specs:\r\n    minitest (5.25.1)\r\n\r\nDEPENDENCIES\r\n  minitest\r\n')), [{ name: 'minitest', version: '5.25.1', line: 2, dependencies: [] }]);
});
