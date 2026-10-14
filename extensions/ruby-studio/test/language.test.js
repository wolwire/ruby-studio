/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { RubyIndex, parseRuby, tokenizeRuby, maskRubyTemplate, rubyWhitespaceEdits, parseRubySyntaxOutput, extractRubyLiteral } = require('../out/languageModel');

function indexed(text, uri = 'file:///project/main.rb', project = 'project') {
	const index = new RubyIndex(); const document = index.update(uri, text, project); return { index, document, uri };
}
function definitions(index, uri, text, value, occurrence = 0) {
	let position = -1; for (let i = 0; i <= occurrence; i++) { position = text.indexOf(value, position + 1); }
	assert.notEqual(position, -1, `fixture location ${value}`);
	return index.resolve(uri, position)?.definitions || [];
}
function rewritten(text, edits) { for (const edit of [...edits].sort((a, b) => b.start - a.start)) { text = text.slice(0, edit.start) + edit.text + text.slice(edit.end); } return text; }

test('nested namespace symbols retain identity, arguments, docs and enclosing ranges', () => {
	const source = '# Billing domain\nmodule Billing\n  class Invoice\n    RATE = 2\n    # Computes a total\n    def total(price, quantity = 1, discount: 0)\n      price * quantity - discount\n    end\n  end\nend\n';
	const model = parseRuby('invoice.rb', source);
	assert.deepEqual(model.symbols.filter(symbol => !['parameter', 'variable'].includes(symbol.kind)).map(symbol => ({ name: symbol.qualifiedName, documentation: symbol.documentation, parameters: symbol.parameters.map(parameter => parameter.label) })), [
		{ name: 'Billing', documentation: 'Billing domain', parameters: [] },
		{ name: 'Billing::Invoice', documentation: '', parameters: [] },
		{ name: 'Billing::Invoice::RATE', documentation: '', parameters: [] },
		{ name: 'Billing::Invoice#total', documentation: 'Computes a total', parameters: ['price', 'quantity = 1', 'discount: 0'] }
	]);
	assert.equal(model.unsafeLocalSyntax, false);
});

test('identical parameter names in separate methods resolve and rename independently', () => {
	const text = 'class Invoice\n  def total(price)\n    price * 2\n  end\n  def tax(price)\n    price / 4\n  end\nend\n';
	const { index, uri } = indexed(text);
	const total = definitions(index, uri, text, 'price *')[0]; const tax = definitions(index, uri, text, 'price /')[0];
	assert.notEqual(total.id, tax.id);
	const rename = index.rename(uri, text.indexOf('price *'), 'amount');
	assert.equal(rewritten(text, rename.edits.get(uri)), text.replace('total(price)', 'total(amount)').replace('price *', 'amount *'));
});

test('block parameters shadow outer locals, and lambda parameters form their own scope', () => {
	const text = 'def calculate(value)\n  [1].each do |value|\n    puts value\n  end\n  callable = ->(value) { value + 1 }\n  value\nend\n';
	const { index, uri, document } = indexed(text);
	const parameters = document.symbols.filter(symbol => symbol.name === 'value');
	assert.equal(new Set(parameters.map(symbol => symbol.scopeId)).size, 3);
	assert.deepEqual([definitions(index, uri, text, 'value\n  end')[0].id, definitions(index, uri, text, 'value +')[0].id, definitions(index, uri, text, 'value\nend')[0].id], [parameters[1].id, parameters[2].id, parameters[0].id]);
});

test('blocks capture an existing parent binding while newly introduced locals do not escape', () => {
	const text = 'def run\n  total = 0\n  [1].each do |item|\n    total += item\n    inside = item\n  end\n  total\n  inside\nend\n';
	const { index, uri } = indexed(text);
	assert.equal(definitions(index, uri, text, 'total +=')[0].id, definitions(index, uri, text, 'total =')[0].id);
	assert.deepEqual(definitions(index, uri, text, 'inside\nend'), []);
});

test('class and nested-method boundaries do not capture locals from their parent', () => {
	const text = 'outside = 3\nclass Sample\n  outside\n  def outer(value)\n    def inner\n      value\n    end\n    value\n  end\nend\n';
	const { index, uri } = indexed(text);
	assert.deepEqual([definitions(index, uri, text, 'outside\n  def'), definitions(index, uri, text, 'value\n    end')], [[], []]);
	assert.equal(definitions(index, uri, text, 'value\n  end')[0].kind, 'parameter');
});

test('a bare name before its first assignment is not incorrectly bound to a future local', () => {
	const text = 'def value\n  9\nend\ndef run\n  value\n  value = 1\n  value\nend\n';
	const { index, uri } = indexed(text);
	assert.deepEqual([definitions(index, uri, text, 'value\n  value =')[0].kind, definitions(index, uri, text, 'value\nend')[0].kind], ['method', 'variable']);
});

test('comments, quoted strings, regexps, percent literals, heredocs and DATA are not references', () => {
	const text = 'value = 1\n# value\nputs "value"\nputs /value/\nputs %q{value}\nputs <<~TEXT\n  value\nTEXT\nvalue\n__END__\nvalue\n';
	const { index, uri } = indexed(text);
	const symbol = definitions(index, uri, text, 'value =')[0];
	assert.deepEqual(index.references(symbol).map(reference => reference.start), [0, text.indexOf('value\n__END__')]);
	const rename = index.rename(uri, 0, 'amount'); assert.equal(rename.failure, undefined); assert.equal(rename.edits.get(uri).length, 2);
});

test('literal interpolation and eval cause rename to refuse hidden binding references', () => {
	for (const suffix of ['puts "#{value}"', 'eval("value")', 'binding.local_variable_get(:value)', 'local_variables']) {
		const { index, uri } = indexed(`value = 1\n${suffix}\n`);
		assert.ok(['interpolation', 'reflection'].includes(index.rename(uri, 0, 'amount').failure));
	}
});

test('global and class variables cannot be mistaken for ordinary lexical bindings', () => {
	const { index, uri, document } = indexed('$value = 1\n@@value = 2\nputs $value\n');
	assert.deepEqual(document.symbols.filter(symbol => symbol.name === 'value'), []);
	assert.equal(index.rename(uri, 1, 'amount').failure, 'noSymbol');
});

test('self and known constant receivers resolve while arbitrary receiver types remain unknown', () => {
	const text = 'class Invoice\n  def total\n    1\n  end\n  def self.build\n    2\n  end\n  def run(object)\n    self.total\n    object.total\n    total\n  end\nend\nInvoice.build\n';
	const { index, uri } = indexed(text);
	assert.deepEqual([definitions(index, uri, text, 'total\n    object')[0].qualifiedName, definitions(index, uri, text, 'total\n    total'), definitions(index, uri, text, 'build\n', 1)[0].qualifiedName], ['Invoice#total', [], 'Invoice.build']);
	assert.equal(index.rename(uri, text.indexOf('def total') + 4, 'sum').failure, 'dynamicMethod');
});

test('explicit known superclass methods are followed across files, preserving nearest overrides', () => {
	const index = new RubyIndex();
	index.update('base.rb', 'module Billing\n  class Base\n    def total(value)\n      value\n    end\n    def self.build\n      1\n    end\n  end\nend\n', 'project');
	const text = 'module Billing\n  class Invoice < Base\n    def run\n      total(2)\n    end\n  end\nend\nBilling::Invoice.build\n'; index.update('child.rb', text, 'project');
	assert.deepEqual([definitions(index, 'child.rb', text, 'total(2)')[0].qualifiedName, definitions(index, 'child.rb', text, 'build\n')[0].qualifiedName], ['Billing::Base#total', 'Billing::Base.build']);
	index.update('child.rb', text.replace('def run', 'def total(value)\n      value\n    end\n    def run'), 'project');
	assert.equal(index.resolve('child.rb', text.indexOf('total(2)') + 'def total(value)\n      value\n    end\n    '.length)?.definitions[0]?.qualifiedName, 'Billing::Invoice#total');
});

test('mixins and inheritance cycles do not invent an inherited definition', () => {
	const index = new RubyIndex(); index.update('base.rb', 'class Base\n  def total\n    1\n  end\nend\n', 'project');
	const text = 'class Invoice < Base\n  include Pricing\n  def run\n    total\n  end\nend\n'; index.update('child.rb', text, 'project');
	assert.deepEqual(definitions(index, 'child.rb', text, 'total\n'), []);
	index.update('cycle.rb', 'class A < B\nend\nclass B < A\n  def run\n    unknown\n  end\nend\n', 'project');
	assert.deepEqual(index.resolve('cycle.rb', index.documents.get('cycle.rb').text.indexOf('unknown')).definitions, []);
});

test('unambiguous constants rename across project files without touching sibling namespaces', () => {
	const index = new RubyIndex();
	index.update('invoice.rb', 'module Billing\n  class Invoice\n  end\nend\nmodule Shipping\n  class Invoice\n  end\nend\n', 'project');
	const text = 'Billing::Invoice.new\nShipping::Invoice.new\n'; index.update('main.rb', text, 'project');
	const result = index.rename('main.rb', text.indexOf('Invoice'), 'Receipt');
	assert.equal(result.failure, undefined);
	assert.deepEqual(result.edits.get('main.rb').map(edit => ({ start: edit.start, text: edit.text })), [{ start: 9, text: 'Receipt' }]);
	assert.equal(result.edits.get('invoice.rb').length, 1);
});

test('workspace folders are isolated and a partial or multiply declared constant cannot be renamed', () => {
	const index = new RubyIndex(); index.update('a.rb', 'class Invoice\nend\nInvoice.new\n', 'one'); index.update('b.rb', 'class Invoice\nend\n', 'two');
	assert.equal(index.references(index.documents.get('a.rb').symbols[0]).length, 2);
	index.complete = false; assert.equal(index.rename('a.rb', 6, 'Receipt').failure, 'incompleteIndex');
	index.complete = true; index.update('reopened.rb', 'class Invoice\nend\n', 'one'); assert.equal(index.rename('a.rb', 6, 'Receipt').failure, 'ambiguousConstant');
});

test('local rename refuses capture by nested parameters or bare method calls but permits unrelated methods', () => {
	const { index, uri } = indexed('def first(value)\n  [1].each do |amount|\n    value\n  end\n  other\nend\ndef second(elsewhere)\n  elsewhere\nend\n');
	assert.deepEqual(['amount', 'other', 'elsewhere'].map(name => index.rename(uri, 10, name).failure), ['collision', 'collision', undefined]);
});

test('keyword shorthand preserves its external key while ordinary hash labels are not references', () => {
	const text = 'def run(value)\n  consume(value:)\n  options = {value: 1}\nend\n';
	const { index, uri } = indexed(text); const rename = index.rename(uri, text.indexOf('value'), 'amount');
	assert.equal(rewritten(text, rename.edits.get(uri)), 'def run(amount)\n  consume(value: amount)\n  options = {value: 1}\nend\n');
	const keyword = indexed('def run(value:)\n  value\nend\n'); assert.equal(keyword.index.rename(keyword.uri, 8, 'amount').failure, 'keywordParameter');
});

test('keyword values without a separating space resolve as values, not symbol literals', () => {
	const text = 'def run(value)\n  consume(key:value)\nend\n'; const { index, uri } = indexed(text);
	assert.equal(definitions(index, uri, text, 'value)\nend')[0].kind, 'parameter');
});

test('numbered Ruby block parameters are local to each block and cannot be renamed', () => {
	const text = '[1].map { _1 + 2 }\n[3].map { _1 + 4 }\n'; const { index, uri, document } = indexed(text);
	const numbered = document.symbols.filter(symbol => symbol.name === '_1'); assert.equal(numbered.length, 2); assert.notEqual(numbered[0].scopeId, numbered[1].scopeId);
	assert.equal(index.rename(uri, text.indexOf('_1'), 'item').failure, 'unsupportedVariable');
});

test('endless methods and modifier conditionals preserve following method scopes', () => {
	const text = 'class Invoice\n  def twice(value) = value * 2\n  def total(value)\n    value if value > 0\n  end\n  def tax(value)\n    value / 4\n  end\nend\n';
	const { document } = indexed(text);
	assert.deepEqual(document.symbols.filter(symbol => symbol.kind === 'method').map(symbol => symbol.qualifiedName), ['Invoice#twice', 'Invoice#total', 'Invoice#tax']);
	assert.equal(document.unsafeLocalSyntax, false);
});

test('command assignments and hash rockets do not create phantom local definitions', () => {
	const model = parseRuby('main.rb', 'puts value = 1\noptions = {name: other, "name" => value}\n');
	assert.deepEqual(model.symbols.filter(symbol => symbol.kind === 'variable').map(symbol => symbol.name), ['value', 'options']);
});

test('signature help counts only top-level arguments of a statically resolved call', () => {
	const text = 'def total(price, count, options = {})\n  price * count\nend\ntotal([1, 2], 3, {tax: 2'; const { index, uri } = indexed(text);
	const signature = index.signature(uri, text.length); assert.equal(signature.symbols[0].name, 'total'); assert.equal(signature.activeParameter, 2);
});

test('completion offers indexed methods for self and explicit constants, without guessing object types', () => {
	const text = 'class Invoice\n  def total\n    1\n  end\n  def run(object)\n    self.\n    object.\n  end\nend\n'; const { index, uri } = indexed(text);
	assert.ok(index.completions(uri, text.indexOf('self.') + 5).some(symbol => symbol.name === 'total'));
	assert.deepEqual(index.completions(uri, text.indexOf('object.') + 7), []);
});

test('ERB masks markup and comment/escaped tags while preserving UTF-16 offsets and Ruby block scopes', () => {
	const text = '<h1>class Fake 😀</h1>\r\n<% values = [1] %>\n<% values.each do |value| %><p><%= value %></p><% end %>\n<%# class Hidden %><%% class Escaped %>';
	const masked = maskRubyTemplate(text); assert.equal(masked.length, text.length); assert.equal(masked.split('\n').length, text.split('\n').length);
	const index = new RubyIndex(); const document = index.update('page.erb', text, 'project', true);
	assert.deepEqual(document.symbols.map(symbol => symbol.name), ['values', 'value']);
	assert.equal(index.resolve('page.erb', text.indexOf('value %>')).definitions[0].name, 'value');
	assert.equal(document.unsafeLocalSyntax, false);
});

test('pattern-matching bindings and unfinished scopes refuse destructive rename', () => {
	for (const text of ['value = 1\ncase data\nin {name:}\n  value\nend\n', 'def run(value)\n  value\n']) {
		const { index, uri } = indexed(text); assert.equal(index.rename(uri, text.indexOf('value'), 'amount').failure, 'unsupportedSyntax');
	}
});

test('whitespace formatting preserves heredoc, multiline string, DATA and CRLF bytes', () => {
	const text = 'value = 1  \r\ntext = "first  \r\nlast  "  \r\nputs <<~TEXT\r\n  literal  \r\nTEXT\r\n# comment  \r\n__END__\r\ndata  \r\n';
	assert.equal(rewritten(text, rubyWhitespaceEdits(text)), 'value = 1\r\ntext = "first  \r\nlast  "\r\nputs <<~TEXT\r\n  literal  \r\nTEXT\r\n# comment\r\n__END__\r\ndata  \r\n');
});

test('literal extraction inserts immediately before its assignment and changes one selected occurrence', () => {
	const text = 'def total\n  count = 12\n  other = 12\n  count + other\nend\n'; const model = parseRuby('main.rb', text); const start = text.indexOf('12');
	assert.equal(rewritten(text, extractRubyLiteral(model, start, start + 2, 'amount')), 'def total\n  amount = 12\n  count = amount\n  other = 12\n  count + other\nend\n');
	assert.equal(extractRubyLiteral(model, start, start + 2, 'other'), undefined);
});

test('literal extraction refuses calls, arithmetic, short-circuit expressions and flow-changing contexts', () => {
	for (const expression of ['fetch()', '2 + 3', 'condition && 12', '"#{value}"']) {
		const text = `def total\n  count = ${expression}\nend\n`; const start = text.indexOf(expression); assert.equal(extractRubyLiteral(parseRuby('main.rb', text), start, start + expression.length, 'amount'), undefined);
	}
});

test('syntax diagnostics retain actual Ruby line and warning identity', () => {
	assert.deepEqual(parseRubySyntaxOutput('-:3: syntax error, unexpected end-of-input\n-:1: warning: assigned but unused variable - item\nSyntax OK\n'), [
		{ line: 2, message: 'syntax error, unexpected end-of-input', warning: false },
		{ line: 0, message: 'warning: assigned but unused variable - item', warning: true }
	]);
});

test('pretokenized worker input produces the same scoped model without mutating the token cache', () => {
	const text = 'class Invoice\n  def total(value)\n    value\n  end\nend\n'; const tokens = tokenizeRuby(text); const expected = parseRuby('main.rb', text); const actual = parseRuby('main.rb', text, '', false, tokens);
	assert.deepEqual(actual, expected); assert.ok(tokens.every(token => token.scopeId === 0 && !token.definitionId));
});

test('multiline endless method headers retain their parameter scope and operator declarations keep their names', () => {
	const text = 'class Values\n  def twice(\n    value\n  ) = value * 2\n  def [](index)\n    index\n  end\n  def []=(index, value)\n    value\n  end\n  def +@\n    self\n  end\nend\n'; const { index, uri, document } = indexed(text);
	assert.deepEqual(document.symbols.filter(symbol => symbol.kind === 'method').map(symbol => symbol.name), ['twice', '[]', '[]=', '+@']);
	assert.equal(definitions(index, uri, text, 'value *')[0].name, 'value'); assert.equal(document.unsafeLocalSyntax, false);
	assert.equal(rubyWhitespaceEdits('value = 1  \n', tokenizeRuby('value = 1  \n')).length, 1);
});

test('a newline before an endless body is bounded rather than permitting a partial rename', () => {
	const text = 'def twice(value) =\n  value * 2\n'; const { index, uri } = indexed(text); assert.equal(index.rename(uri, text.indexOf('value'), 'amount').failure, 'unsupportedSyntax');
});

test('ordinary constructor navigation and signature help use the nearest explicit initialize', () => {
	const index = new RubyIndex();
	index.update('base.rb', 'module Billing\n  class Base\n    def initialize(amount, tax: 0)\n      @amount = amount\n    end\n  end\nend\n', 'project');
	const text = 'module Billing\n  class Invoice < Base\n  end\nend\nBilling::Invoice.new(12, tax: 2)\n'; index.update('main.rb', text, 'project');
	assert.deepEqual(definitions(index, 'main.rb', text, 'new(12,').map(symbol => symbol.qualifiedName), ['Billing::Base#initialize']);
	const help = index.signature('main.rb', text.indexOf('tax: 2') + 5);
	assert.deepEqual({ name: help.symbols[0].qualifiedName, parameters: help.symbols[0].parameters.map(parameter => parameter.label), active: help.activeParameter }, { name: 'Billing::Base#initialize', parameters: ['amount', 'tax: 0'], active: 1 });
});

test('constructor navigation preserves custom new, including an explicit inherited singleton new', () => {
	for (const inherited of [false, true]) {
		const text = `class Base\n  def self.new(value)\n    value\n  end\n  def initialize(other)\n    @other = other\n  end\nend\n${inherited ? 'class Invoice < Base\nend\nInvoice' : 'Base'}.new(3)\n`;
		const { index, uri } = indexed(text);
		assert.deepEqual(definitions(index, uri, text, 'new(3)').map(symbol => symbol.qualifiedName), ['Base.new']);
	}
});

test('a single straight-line qualified constructor assignment resolves an instance method', () => {
	const index = new RubyIndex();
	index.update('invoice.rb', 'module Billing\n  class Invoice\n    def initialize(amount)\n      @amount = amount\n    end\n    def total(tax: 0)\n      @amount + tax\n    end\n  end\nend\n', 'project');
	const text = 'def run\n  invoice = Billing::Invoice.new(12)\n  invoice.total(tax: 2)\nend\n'; index.update('main.rb', text, 'project');
	assert.deepEqual(definitions(index, 'main.rb', text, 'total(tax').map(symbol => symbol.qualifiedName), ['Billing::Invoice#total']);
	assert.deepEqual(index.signature('main.rb', text.indexOf('tax: 2') + 5).symbols[0].parameters.map(parameter => parameter.label), ['tax: 0']);
	assert.ok(index.completions('main.rb', text.indexOf('invoice.total') + 'invoice.'.length).some(symbol => symbol.qualifiedName === 'Billing::Invoice#total'));
});

test('a straight-line local receiver follows indexed inheritance and prefers instance overrides', () => {
	const { index, uri } = indexed('class Base\n  def total\n    1\n  end\nend\nclass Invoice < Base\nend\ninvoice = Invoice.new\ninvoice.total\n');
	let text = index.documents.get(uri).text;
	assert.equal(definitions(index, uri, text, 'total\n', 1)[0].qualifiedName, 'Base#total');
	text = text.replace('class Invoice < Base\nend', 'class Invoice < Base\n  def total\n    2\n  end\nend'); index.update(uri, text, 'project');
	assert.equal(index.resolve(uri, text.indexOf('invoice.total') + 'invoice.'.length).definitions[0].qualifiedName, 'Invoice#total');
});

test('receiver inference is refused after any reassignment or compound assignment', () => {
	for (const reassignment of ['invoice = Other.new', 'invoice = unknown', 'invoice ||= Invoice.new', 'invoice += 1']) {
		const text = `class Invoice\n  def total\n    1\n  end\nend\ninvoice = Invoice.new\n${reassignment}\ninvoice.total\n`;
		const { index, uri } = indexed(text);
		assert.deepEqual(index.resolve(uri, text.indexOf('invoice.total') + 'invoice.'.length).definitions, []);
		assert.equal(index.documents.get(uri).localAssignments.filter(assignment => assignment.symbolId === index.documents.get(uri).symbols.find(symbol => symbol.kind === 'variable' && symbol.name === 'invoice').id).length, 2);
	}
});

test('conditional, loop, short-circuit and block assignments do not infer a receiver class', () => {
	for (const body of [
		'if condition\n  invoice = Invoice.new\nend\ninvoice.total',
		'invoice = Invoice.new if condition\ninvoice.total',
		'invoice = condition && Invoice.new\ninvoice.total',
		'invoice = Invoice.new\ncondition && invoice.total',
		'invoice = Invoice.new\n[1].each do |item|\n  invoice.total\nend',
		'while condition\n  invoice = Invoice.new\nend\ninvoice.total'
	]) {
		const text = `class Invoice\n  def total\n    1\n  end\nend\n${body}\n`; const { index, uri } = indexed(text);
		assert.deepEqual(index.resolve(uri, text.indexOf('invoice.total') + 'invoice.'.length).definitions, []);
	}
});

test('unknown factories, parameter receivers, chained results and custom new do not receive guessed instance types', () => {
	for (const assignment of ['invoice = build_invoice', 'invoice = Unknown.new', 'invoice = Invoice.new.decorate', 'invoice = Invoice.new(1).decorate', 'invoice = Invoice.new || fallback']) {
		const text = `class Invoice\n  def total\n    1\n  end\nend\n${assignment}\ninvoice.total\n`; const { index, uri } = indexed(text);
		assert.deepEqual(index.resolve(uri, text.indexOf('invoice.total') + 'invoice.'.length).definitions, []);
	}
	const text = 'class Invoice\n  def self.new\n    "not an invoice"\n  end\n  def total\n    1\n  end\nend\ninvoice = Invoice.new\ninvoice.total\n'; const { index, uri } = indexed(text);
	assert.deepEqual(index.resolve(uri, text.indexOf('invoice.total') + 'invoice.'.length).definitions, []);
});

test('receiver inference refuses reflection, mixins, unknown parents, reopened classes and partial indexes', () => {
	for (const declaration of [
		'class Invoice\n  include Pricing',
		'class Invoice\n  prepend Pricing',
		'class Invoice < Unknown',
		'class Invoice\nend\nclass Invoice'
	]) {
		const text = `${declaration}\n  def total\n    1\n  end\nend\ninvoice = Invoice.new\ninvoice.total\n`; const { index, uri } = indexed(text);
		assert.deepEqual(index.resolve(uri, text.indexOf('invoice.total') + 'invoice.'.length).definitions, []);
	}
	for (const reflection of ['eval("invoice = unknown")', 'binding', 'Invoice.define_singleton_method(:new) { unknown }']) {
		const text = `class Invoice\n  def total\n    1\n  end\nend\ninvoice = Invoice.new\n${reflection}\ninvoice.total\n`; const { index, uri } = indexed(text);
		assert.deepEqual(index.resolve(uri, text.indexOf('invoice.total') + 'invoice.'.length).definitions, []);
	}
	const text = 'class Invoice\n  def total\n    1\n  end\nend\ninvoice = Invoice.new\ninvoice.total\n'; const { index, uri } = indexed(text); index.complete = false;
	assert.deepEqual(index.resolve(uri, text.indexOf('invoice.total') + 'invoice.'.length).definitions, []);
});

test('identical local names in different hard scopes do not share inferred receiver types', () => {
	const text = 'class Invoice\n  def total\n    1\n  end\nend\ndef first\n  invoice = Invoice.new\n  invoice.total\nend\ndef second(invoice)\n  invoice.total\nend\n'; const { index, uri } = indexed(text);
	assert.deepEqual([index.resolve(uri, text.indexOf('invoice.total') + 8).definitions.map(symbol => symbol.qualifiedName), index.resolve(uri, text.lastIndexOf('invoice.total') + 8).definitions], [['Invoice#total'], []]);
});

test('receiver evidence is invalidated when an indexed document is edited', () => {
	const text = 'class Invoice\n  def total\n    1\n  end\nend\ninvoice = Invoice.new\ninvoice.total\n'; const { index, uri } = indexed(text); const offset = text.indexOf('invoice.total') + 8;
	assert.equal(index.resolve(uri, offset).definitions[0].qualifiedName, 'Invoice#total');
	index.update(uri, text.replace('Invoice.new\ninvoice.total', 'unknown\ninvoice.total'), 'project');
	assert.deepEqual(index.resolve(uri, index.documents.get(uri).text.indexOf('invoice.total') + 8).definitions, []);
});

test('super resolves the enclosing instance or singleton method through explicit hierarchy', () => {
	const text = 'class Base\n  def total(value)\n    value\n  end\n  def self.build(name)\n    name\n  end\nend\nclass Invoice < Base\n  def total(value)\n    super(value)\n  end\n  def self.build(name)\n    super(name)\n  end\nend\n'; const { index, uri } = indexed(text);
	assert.deepEqual([definitions(index, uri, text, 'super(value)')[0].qualifiedName, definitions(index, uri, text, 'super(name)')[0].qualifiedName], ['Base#total', 'Base.build']);
	assert.equal(index.signature(uri, text.indexOf('super(value)') + 'super(value'.length).symbols[0].qualifiedName, 'Base#total');
});

test('super does not fabricate a target outside a method, with unknown parents or behind a mixin', () => {
	for (const source of ['super\n', 'class Invoice < Unknown\n  def total\n    super\n  end\nend\n', 'class Base\n  def total\n    1\n  end\nend\nclass Invoice < Base\n  prepend Pricing\n  def total\n    super\n  end\nend\n']) {
		const { index, uri } = indexed(source); assert.deepEqual(definitions(index, uri, source, 'super\n'), []);
	}
});

const ruby = process.env.RUBY_STUDIO_TEST_RUBY || 'ruby';
const hasRuby = spawnSync(ruby, ['--version'], { encoding: 'utf8' }).status === 0;
test('scope-safe local rename preserves actual Ruby output', { skip: !hasRuby }, () => {
	const text = 'def calculate(value)\n  total = value * 2\n  [3].each do |value|\n    total += value\n  end\n  total\nend\nputs calculate(4)\n'; const { index, uri } = indexed(text); const renamed = index.rename(uri, text.indexOf('value'), 'price');
	const before = spawnSync(ruby, ['-'], { input: text, encoding: 'utf8' }); const after = spawnSync(ruby, ['-'], { input: rewritten(text, renamed.edits.get(uri)), encoding: 'utf8' });
	assert.deepEqual([before.status, before.stdout, after.status, after.stdout], [0, '11\n', 0, '11\n']);
});
test('keyword shorthand rename preserves actual Ruby keyword arguments', { skip: !hasRuby }, () => {
	const text = 'def consume(value:)\n  value\nend\ndef run(value)\n  consume(value:)\nend\nputs run(7)\n'; const { index, uri } = indexed(text); const renamed = index.rename(uri, text.indexOf('run(value)') + 4, 'amount');
	const result = spawnSync(ruby, ['-'], { input: rewritten(text, renamed.edits.get(uri)), encoding: 'utf8' }); assert.deepEqual([result.status, result.stdout], [0, '7\n']);
});
