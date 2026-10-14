/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
(() => {
	const api = acquireVsCodeApi();
	let state, draft = {}, runs = [], selected = '', index = 0, section = '', dirty = false, busy = false;
	let search = '';
	const app = document.getElementById('app');
	const t = value => state.labels[value] || value;
	const node = (tag, text, className) => { const element = document.createElement(tag); if (text) { element.textContent = text; } if (className) { element.className = className; } return element; };
	const send = (command, data = {}) => { busy = true; controls(); api.postMessage({ command, ...data }); };
	const changed = () => { dirty = true; status(t('Unsaved Changes')); persist(); controls(); };
	const persist = () => api.setState({ revision: state.revision, draft, runs, selected, index, section, dirty });
	const status = (text, error = false) => { const target = document.getElementById('status'); if (target) { target.textContent = text; target.classList.toggle('error', error); } };
	const controls = () => {
		for (const control of document.querySelectorAll('button,input,select,textarea')) { control.disabled = busy; }
		const apply = document.getElementById('apply'); if (apply) { apply.disabled = busy || !dirty; }
		const scope = document.getElementById('scope'); if (scope) { scope.disabled = busy || dirty; }
		if (dirty && !busy && !document.getElementById('status')?.classList.contains('error')) { status(t('Unsaved Changes')); }
	};
	const button = (label, action, className) => { const element = node('button', t(label), className); element.type = 'button'; element.addEventListener('click', action); return element; };
	const save = close => {
		if (state.mode === 'runs') {
			try {
				const configurations = runs.map(run => ({ ...run, args: JSON.parse(run.argumentsText || '[]'), env: JSON.parse(run.environmentText || '{}'), argumentsText: undefined, environmentText: undefined }));
				send('apply', { configurations, selected, close });
			} catch (error) { status(error.message, true); }
		} else { send('apply', { draft, close }); }
	};
	const render = () => {
		app.replaceChildren();
		const heading = node('header'); heading.append(node('strong', state.mode === 'runs' ? t('Run/Debug Configurations') : t('Settings')), node('span', state.project || t('No Project Open'), 'project')); app.append(heading);
		const body = node('div', '', 'body'); const sidebar = node('aside');
		const filter = node('input'); filter.type = 'search'; filter.placeholder = t('Search Settings'); filter.setAttribute('aria-label', t('Search Settings')); filter.value = search; filter.addEventListener('input', () => { search = filter.value; renderContent(); }); sidebar.append(filter);
		const sections = state.mode === 'runs' ? [['runs', 'Run/Debug Configurations']] : [['appearance', 'Appearance'], ['editor', 'Editor'], ['sdk', 'Ruby SDK and Gems'], ['language', 'Ruby Language']];
		for (const [id, label] of sections) { const item = button(label, () => { section = id; persist(); render(); }, section === id ? 'category selected' : 'category'); sidebar.append(item); }
		if (state.mode !== 'runs') { sidebar.append(button('Run/Debug Configurations', () => send('runConfigurations')), button('All Editor Settings', () => send('allSettings'))); }
		body.append(sidebar, node('main')); app.append(body);
		const footer = node('footer'); const message = node('span', '', 'status'); message.id = 'status'; message.setAttribute('role', 'status'); footer.append(message);
		footer.append(button('Cancel', () => send('cancel')), button('Apply', () => save(false)), button('OK', () => save(true), 'primary')); footer.children[2].id = 'apply'; app.append(footer); renderContent(); controls();
	};
	const renderContent = () => {
		const main = app.querySelector('main'); main.replaceChildren();
		if (state.mode === 'runs') { renderRuns(main); return; }
		const toolbar = node('div', '', 'scope'); const scope = node('select'); scope.id = 'scope'; scope.setAttribute('aria-label', 'Settings Scope');
		for (const value of state.scopes) { const option = node('option', t(value[0].toUpperCase() + value.slice(1))); option.value = value; option.selected = value === state.scope; scope.append(option); }
		scope.addEventListener('change', () => send('scope', { scope: scope.value })); toolbar.append(scope); main.append(toolbar);
		const query = search.trim().toLowerCase();
		const fields = state.fields.filter(field => query ? (field.label + ' ' + field.key).toLowerCase().includes(query) : field.section === section);
		for (const field of fields) {
			const row = node('div', '', 'field'); const label = node('label', field.label); label.htmlFor = field.key; row.append(label);
			const input = node(field.options ? 'select' : 'input'); input.id = field.key;
			const value = field.key in draft ? draft[field.key] ?? state.inherited[field.key] : state.values[field.key];
			if (field.options) { for (const option of field.options) { const element = node('option', option); element.value = option; element.selected = option === value; input.append(element); } }
			else { input.type = field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'number' : 'text'; if (input.type === 'checkbox') { input.checked = !!value; } else { input.value = value; } if (field.min !== undefined) { input.min = field.min; input.max = field.max; } }
			if (field.key === 'rubyStudio.interpreterPath') { input.placeholder = t('Automatic Detection'); input.setAttribute('list', 'interpreters'); const list = node('datalist'); list.id = 'interpreters'; for (const candidate of state.candidates) { const option = node('option'); option.value = candidate; list.append(option); } row.append(list); }
			input.addEventListener('input', () => { draft[field.key] = field.type === 'boolean' ? input.checked : field.type === 'number' ? Number(input.value) : input.value; changed(); }); row.append(input);
			row.append(button('Use Inherited Value', () => { draft[field.key] = null; changed(); renderContent(); }, 'reset')); main.append(row);
		}
		if (section === 'sdk' && !query) {
			main.append(node('h2', t('Interpreter Version and Gems')));
			const tools = node('div', '', 'tools'); const interpreter = () => String(draft['rubyStudio.interpreterPath'] ?? state.values['rubyStudio.interpreterPath'] ?? '');
			tools.append(button('Browse', () => send('browse')), button('Validate', () => send('validate', { interpreter: interpreter() })), button('Refresh Gems', () => send('gems', { interpreter: interpreter() }))); main.append(tools); const detail = node('pre'); detail.id = 'runtime'; main.append(detail); const gems = node('div'); gems.id = 'gems'; main.append(gems);
		}
		controls();
	};
	const renderRuns = main => {
		const toolbar = node('div', '', 'tools'); const pick = node('select'); pick.setAttribute('aria-label', t('Select Configuration'));
		for (const [i, run] of runs.entries()) { const option = node('option', run.name || '(unnamed)'); option.value = i; option.selected = i === index; pick.append(option); }
		pick.addEventListener('change', () => { index = Number(pick.value); selected = runs[index].name; changed(); renderContent(); }); toolbar.append(pick);
		const unique = base => { let value = base; let i = 2; while (runs.some(run => run.name === value)) { value = `${base} ${i++}`; } return value; };
		toolbar.append(button('Add', () => { const name = unique('Ruby'); runs.push({ name, type: 'ruby', script: 'main.rb', cwd: '${workspaceFolder}', argumentsText: '[]', environmentText: '{}', bundle: false }); index = runs.length - 1; selected = name; changed(); renderContent(); }), button('Duplicate', () => { if (!runs[index]) { return; } const run = { ...runs[index], name: unique(runs[index].name + ' Copy') }; runs.push(run); index = runs.length - 1; selected = run.name; changed(); renderContent(); }), button('Remove', () => { runs.splice(index, 1); index = Math.min(index, runs.length - 1); selected = runs[index]?.name || ''; changed(); renderContent(); })); main.append(toolbar);
		const run = runs[index]; if (!run) { return; }
		for (const [key, label] of [['name', 'Name'], ['type', 'Type'], ['script', 'Script'], ['argumentsText', 'Arguments (JSON Array)'], ['environmentText', 'Environment (JSON Object)'], ['cwd', 'Working Directory'], ['bundle', 'Use Bundler']]) {
			const row = node('div', '', 'field'); const title = node('label', t(label)); title.htmlFor = key; row.append(title);
			const input = node(key === 'type' ? 'select' : key.endsWith('Text') ? 'textarea' : 'input'); input.id = key;
			if (key === 'type') { for (const type of ['ruby', 'rails', 'rake', 'rspec']) { const option = node('option', type); option.value = type; option.selected = type === run.type; input.append(option); } }
			else if (key === 'bundle') { input.type = 'checkbox'; input.checked = !!run.bundle; } else { input.value = run[key] || ''; }
			input.addEventListener('input', () => { const old = run.name; run[key] = key === 'bundle' ? input.checked : input.value; if (key === 'name' && selected === old) { selected = run.name; } changed(); }); row.append(input); main.append(row);
		}
	};
	window.addEventListener('message', event => {
		const message = event.data;
		if (message.command === 'state') { const saved = api.getState(); state = message; if (saved?.revision === state.revision) { ({ draft, runs, selected, index, section, dirty } = saved); } else { draft = {}; runs = state.configurations.map(run => ({ ...run, argumentsText: JSON.stringify(run.args || [], null, 2), environmentText: JSON.stringify(run.env || {}, null, 2) })); selected = state.selected; index = Math.max(0, runs.findIndex(run => run.name === selected)); section = section || state.section; dirty = false; } render(); persist(); }
		else if (message.command === 'section') { section = message.section; render(); persist(); }
		else if (message.command === 'interpreter') { draft['rubyStudio.interpreterPath'] = message.value; dirty = true; renderContent(); persist(); }
		else if (message.command === 'validated') { const detail = document.getElementById('runtime'); if (detail) { detail.textContent = `${message.version}\n${message.ruby}\n${message.manager}`; } const gems = document.getElementById('gems'); if (gems && message.gems) { gems.replaceChildren(...message.gems.map(gem => node('div', `${gem.name}  ${gem.version}`, 'gem'))); } status(message.version); }
		else if (message.command === 'error') { status(message.message, true); }
		else if (message.command === 'saved') { dirty = false; persist(); status(t('Saved')); }
		else if (message.command === 'idle') { busy = false; controls(); }
	});
	document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); if (search) { search = ''; render(); } else if (!busy) { send('cancel'); } } if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!busy) { save(true); } } });
	api.postMessage({ command: 'ready' });
})();
