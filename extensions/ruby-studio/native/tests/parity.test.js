/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tokenizeRuby } = require('../../out/languageModel.js');
const binary = process.env.RUBY_STUDIO_NATIVE_LEXER || path.join(__dirname, '..', 'target', 'release', process.platform === 'win32' ? 'ruby-studio-lexer.exe' : 'ruby-studio-lexer');

function frames(sources) {
	return Buffer.concat(sources.flatMap((source, id) => {
		const bytes = Buffer.from(source, 'utf8');
		return [Buffer.from(`${id} ${bytes.length}\n`, 'ascii'), bytes];
	}));
}
function roundtrip(sources) {
	const result = spawnSync(binary, [], { input: frames(sources), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 30000 });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	assert.equal(result.stderr, '');
	const output = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
	assert.equal(output.length, sources.length);
	return output;
}
function reference(source) { return tokenizeRuby(source).map(token => [token.kind, token.start, token.end, token.line, token.column]); }

const corpus = [
	'', 'class Example < Parent\n  def run(value:, **options)\n    @x = value\n  end\nend\n',
	'# class Fake\nreal # inline\n', '=begin\nclass Hidden\n=end comment\nvisible\n',
	'=begin\r\nignored\r\n=end\r\nx\r\n', '__END__\nclass Data\n', '  __END__\nreal\n', '__END__\r', '__END__\u2028', '__END__\u2029',
	'"é 😀 #{call(\'nested\')} tail"\n@value = "日本語"\n', '😀foo 𝒜bar\n𐐀 x\n',
	'"#{ {a: "#{nested}"} }" after', "'escaped\\\'quote' next", '`echo #{value}`',
	'x = <<~TEXT\n  class NotCode\n  TEXT\nnext_value\n',
	'x = <<-\'A\', <<"B"\n first\n A\nsecond\nB\nafter\n',
	'x = <<END\nunterminated body', 'x = <<END\n',
	'%q{one {two} three} %Q(x) %w[a b] %W<a #{b}> %i[a b] %I[a b] %r{a[b/]c} %x!pwd! %s(symbol)',
	'%!arbitrary! %= 2 %q=word %{} %% %q{escaped\\}brace}',
	':name :@x :@@value :name? :method! :setter= name: symbol: :if if: obj.if obj&.class',
	'/[a/b]c/im x / 2 a/b a /b/ x /= 2 return /x/ when /y/ a =~ /a/\n',
	'0xdead 0b101_0 0o777 12_34 1.2_3e-4r 3i 0x 1e+ 4. 5E+2I',
	'@@class_value @v! @1 @@_value A_B local? defined? BEGIN END nil true false',
	'$value $1 $123 $? $! $$ $-w $😀 $é $ x\n',
	'**= ||= &&= === <=> ... :: &. => == != <= >= =~ !~ << >> ** .. += -= *= /= %= &= |= ^= && || ->',
	'obj.\n# middle\nclass; {class: 1}; return\n/[a]/\n',
	'\u00a0/a/\u2003foo\ufeff%q|value|', '=beginning\nx\n=ending\ny\n',
	'"unterminated\\', 'return /unterminated\nnext_name',
];

test('persistent native lexer matches TypeScript token boundaries and UTF16 positions', () => {
	const responses = roundtrip(corpus);
	responses.forEach((response, id) => {
		assert.equal(response.id, id);
		assert.equal(response.fallback, undefined, JSON.stringify(corpus[id]));
		assert.deepEqual(response.tokens, reference(corpus[id]), `Corpus ${id}: ${JSON.stringify(corpus[id])}`);
	});
});

test('deterministic mixed lexical corpus agrees with reference or explicitly requests malformed-shape fallback', () => {
	let state = 123456789;
	const random = limit => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
	const fragments = ['x', 'Foo', '@v', '1.23', ' ', '\n', '# note\n', '"value"', "'value'", ':sym', '=', '/', '%q{v}', '<<A\na\nA\n', '{', '}', '(', ')', '.', '&.', ':', 'if', 'end', '😀', 'é', '\t', '\r\n', '\\', '%', '!', '?', '|', '=>'];
	const sources = Array.from({ length: 1000 }, () => Array.from({ length: 5 + random(40) }, () => fragments[random(fragments.length)]).join(''));
	for (const response of roundtrip(sources)) {
		const source = sources[response.id];
		if (response.fallback) { assert.ok(source.includes('%') && source.endsWith('\\'), `Unexpected fallback: ${source}`); }
		else { assert.deepEqual(response.tokens, reference(source), `Fuzz source: ${JSON.stringify(source)}`); }
	}
});

test('unsupported malformed percent escape uses explicit fallback and later frames survive', () => {
	const responses = roundtrip(['%q{\\', 'value = 1\n']);
	assert.deepEqual(responses[0], { id: 0, fallback: true, tokens: [] });
	assert.deepEqual(responses[1].tokens, reference('value = 1\n'));
});

test('worker rejects oversized and malformed frame headers before allocating payload', () => {
	for (const input of ['1 16777217\n', 'invalid\n', '1 1\u00a0\n', '1 20\nshort', `${'1'.repeat(130)}\n`]) {
		const result = spawnSync(binary, [], { input, encoding: 'utf8', timeout: 3000 });
		assert.equal(result.status, 1);
		assert.equal(result.stdout, '');
		assert.match(result.stderr, /Ruby Studio native lexer:/);
	}
});

test('request bytes use UTF8 lengths while response locations use UTF16', () => {
	assert.ok(fs.statSync(binary).isFile());
	const [response] = roundtrip(['x = "😀é"\ny\n']);
	assert.deepEqual(response.tokens, reference('x = "😀é"\ny\n'));
});


test('invalid UTF8 payload requests fallback without corrupting following frames', () => {
	const result = spawnSync(binary, [], { input: Buffer.concat([Buffer.from('7 1\n'), Buffer.from([255]), Buffer.from('8 1\nx')]), encoding: 'utf8', timeout: 3000 });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line)), [{ id: 7, fallback: true, tokens: [] }, { id: 8, tokens: reference('x') }]);
});

function binaryRoundtrip(sources) {
	const result = spawnSync(binary, ['--binary'], { input: frames(sources), maxBuffer: 128 * 1024 * 1024, timeout: 30000 });
	assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
	assert.equal(result.stderr.length, 0);
	const kinds = [undefined, 'identifier', 'constant', 'keyword', 'instanceVariable', 'number', 'literal', 'symbol', 'operator', 'newline', 'comment', 'globalVariable'];
	const responses = [];
	let offset = 0;
	while (offset < result.stdout.length) {
		const newline = result.stdout.indexOf(10, offset);
		assert.ok(newline >= 0, 'Complete binary response header');
		const header = result.stdout.subarray(offset, newline).toString('ascii');
		assert.match(header, /^\d+ \d+ [01]$/);
		const [id, count, fallback] = header.split(' ').map(Number);
		offset = newline + 1;
		assert.ok(count <= 1000000);
		assert.ok(offset + count * 17 <= result.stdout.length, 'Complete fixed-width response');
		const tokens = [];
		for (let index = 0; index < count; index++, offset += 17) {
			const kind = kinds[result.stdout[offset]];
			assert.ok(kind, 'Known token kind ID');
			tokens.push([kind, result.stdout.readUInt32LE(offset + 1), result.stdout.readUInt32LE(offset + 5), result.stdout.readUInt32LE(offset + 9), result.stdout.readUInt32LE(offset + 13)]);
		}
		responses.push({ id, tokens, fallback: !!fallback });
	}
	assert.equal(responses.length, sources.length);
	return responses;
}

test('binary mode preserves all token kinds, UTF16 fields and consecutive frame boundaries', () => {
	const responses = binaryRoundtrip(corpus);
	responses.forEach((response, id) => {
		assert.equal(response.id, id);
		assert.equal(response.fallback, false);
		assert.deepEqual(response.tokens, reference(corpus[id]), `Binary corpus ${id}: ${JSON.stringify(corpus[id])}`);
	});
});

test('binary mode encodes fallback without a body and keeps the following frame aligned', () => {
	assert.deepEqual(binaryRoundtrip(['%q{\\', 'value = 1\n']), [
		{ id: 0, fallback: true, tokens: [] },
		{ id: 1, fallback: false, tokens: reference('value = 1\n') }
	]);
});
