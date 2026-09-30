// dsh-archived-sessions — Client-half wiring smoke test.
//
// Run: node test/client.test.mjs
//
// The browser half is a module-loader bundle, so it is loaded here through a
// stub window.__ModuleLoader__ plus a stub Cordis context. This pins the WIRE
// contract that a UI edit can silently break:
//   - the entry still injects exactly ["slots","remote","sessions","workspaces"]
//     (the plugin's own namespace must never appear in `inject`),
//   - every Remote method the UI calls is declared in the mounted contribution,
//   - the settings section still registers.
//
// The refresh-after-delete behaviour itself lives in the UI callbacks and is
// verified in the running app; what is checked here is that the entry still
// loads and mounts after the change.

import test from 'node:test';
import assert from 'node:assert/strict';

// Loader + DOM stubs the bundle touches at apply() time.
let loaded = null;
globalThis.window = {
	__ModuleLoader__: {
		load(config) {
			loaded = config;
		}
	}
};
globalThis.document = {
	head: { appendChild() {} },
	contains: () => true,
	createElement: () => ({ setAttribute() {}, appendChild() {} }),
	createTextNode: () => ({})
};

await import('../lib/client.js');

/** The methods the Remote namespace must expose to the UI. */
const EXPECTED_METHODS = [
	'list',
	'preview',
	'restore',
	'deleteSession',
	'planDelete',
	'deleteSessions',
	'scanOrphans',
	'purgeOrphans',
	'purgeStaleRecords'
];

test('the client entry loads, mounts its namespace and registers the section', async () => {
	assert.ok(loaded, 'window.__ModuleLoader__.load must be called');
	assert.equal(loaded.id, 'dsh-archived-sessions');

	const React = { createElement: () => null };
	const mod = loaded.factory((name) => {
		if (name === 'react') return React;
		throw new Error('unexpected require: ' + name);
	});
	assert.equal(typeof mod.apply, 'function');
	assert.deepEqual(mod.inject, ['slots', 'remote', 'sessions', 'workspaces']);

	let mounted = null;
	let registered = null;
	const slots = {
		inject: (_name, callback) => { callback(); return () => {}; },
		register: (options, component) => { registered = { options, component }; return () => {}; }
	};
	const ctx = {
		effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
		remote: { $mount: (contribution) => { mounted = contribution; return () => {}; } },
		sessions: { refresh: async () => {} },
		workspaces: {},
		get(name) {
			return { slots, remote: this.remote, sessions: this.sessions, workspaces: this.workspaces }[name];
		}
	};

	await mod.apply(ctx);

	assert.ok(mounted, 'the remote namespace must be mounted before the UI registers');
	assert.equal(mounted.package, 'dsh-archived-sessions');
	assert.deepEqual(mounted.descriptors.map((descriptor) => descriptor.method).sort(), EXPECTED_METHODS.slice().sort());
	for (const descriptor of mounted.descriptors) {
		assert.equal(descriptor.service, 'archivedSessions');
		assert.equal(descriptor.namespace, 'archivedSessions');
		assert.equal(descriptor.invocation.kind, 'direct');
	}

	assert.ok(registered, 'the settings section must register');
	assert.equal(registered.options.id, 'archived-sessions');
	assert.equal(registered.options.name, 'settings.section');
	assert.equal(typeof registered.component, 'function');
});

test('an entry with no slot registry stays inert instead of throwing', async () => {
	const mod = loaded.factory((name) => (name === 'react' ? { createElement: () => null } : undefined));
	await mod.apply({ get: () => undefined, effect: () => () => {} });
});

// --- Minimal render harness --------------------------------------------------
// The bundle is React-with-hooks, so the scan panel is only reachable through a
// render. A throw inside it costs the whole settings section (the framework's
// slot-level error boundary unmounts the entry and the user just sees it
// disappear), which no syntax check catches. These helpers emulate exactly the
// hook surface the section uses, with an explicit cursor reset per render.

function makeRenderHarness() {
	let cursor = 0;
	const hooks = [];
	const React = {
		Fragment: 'Fragment',
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
		useState: (init) => {
			const at = cursor++;
			if (!(at in hooks)) hooks[at] = typeof init === 'function' ? init() : init;
			return [hooks[at], (next) => { hooks[at] = typeof next === 'function' ? next(hooks[at]) : next; }];
		},
		useRef: (init) => {
			const at = cursor++;
			if (!(at in hooks)) hooks[at] = { current: init };
			return hooks[at];
		},
		useMemo: (fn) => { cursor++; return fn(); },
		useEffect: (fn) => { cursor++; fn(); },
		useSyncExternalStore: (_subscribe, snapshot) => { cursor++; return snapshot(); }
	};
	return {
		React,
		// Render one component body: hooks keep their stored values across calls.
		render: (component, props) => { cursor = 0; return component(props); }
	};
}

/** Depth-first search of the element tree built by the harness. */
function findNodes(node, predicate, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out;
	if (Array.isArray(node)) {
		for (const child of node) findNodes(child, predicate, out);
		return out;
	}
	if (predicate(node)) out.push(node);
	findNodes(node.children, predicate, out);
	return out;
}

function textOf(node) {
	if (typeof node === 'string') return node;
	if (node === null || node === undefined || typeof node !== 'object') return '';
	if (Array.isArray(node)) return node.map(textOf).join('');
	return (node.children ?? []).map(textOf).join('');
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the orphan scan panel renders, groups the three kinds and never throws', async () => {
	const harness = makeRenderHarness();
	const mod = loaded.factory((name) => {
		if (name === 'react') return harness.React;
		throw new Error('unexpected require: ' + name);
	});

	const scan = {
		ok: true,
		scanned: 6,
		items: [
			{ sessionId: 'user-2', kind: 'suspect', readable: false, eventCount: null, live: false, createdAt: 1700000000000, cwd: 'D:\\proj', parentSession: null, parentAccounted: null },
			{ sessionId: 'child-1', kind: 'subagent', readable: true, eventCount: 42, live: false, createdAt: 1700000001000, cwd: 'D:\\proj', parentSession: 'user-1', parentAccounted: true },
			{ sessionId: 'user-3', kind: 'unaccounted', readable: true, eventCount: 7, live: true, createdAt: 1700000002000, cwd: 'D:\\other', parentSession: null, parentAccounted: null }
		],
		counts: { suspect: 1, subagent: 1, unaccounted: 1 },
		kinds: ['suspect', 'subagent', 'unaccounted'],
		confirmWord: '删除'
	};
	const namespace = {
		list: async () => ({ ok: true, value: { items: [], pendingIds: [], drainedIds: [] } }),
		scanOrphans: async () => ({ ok: true, value: scan })
	};
	const store = (snapshot) => ({ subscribe: () => () => {}, getSnapshot: () => snapshot });
	let registered = null;
	const slots = {
		inject: (_name, callback) => { callback(); return () => {}; },
		register: (options, component) => { registered = { options, component }; return () => {}; }
	};
	const ctx = {
		effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
		remote: { $mount: () => () => {} },
		sessions: { list: store({ byId: {} }), refresh: async () => {} },
		workspaces: { list: store({ archivedSessionIds: [] }) },
		get(name) {
			return {
				slots,
				remote: this.remote,
				sessions: this.sessions,
				workspaces: this.workspaces,
				'remote.archivedSessions': typeof namespace === 'object' ? namespace : undefined
			}[name];
		}
	};
	await mod.apply(ctx);
	assert.ok(registered, 'the section must register');

	// The wrapper builds the section's props; render the BODY with those props.
	const renderSection = () => {
		const element = registered.component({ close() {} });
		return harness.render(element.type, element.props);
	};

	// Render 1: the list request starts inside the mount effect.
	let tree = renderSection();
	assert.ok(tree, 'the section must render');
	await tick();

	// Render 2: the scan button exists; pressing it runs the Host call.
	tree = renderSection();
	const button = findNodes(tree, (node) => node.type === 'button' && textOf(node).includes('扫描孤儿会话'))[0];
	assert.ok(button, 'the scan button must render');
	button.props.onClick();
	await tick();

	// Render 3: the panel shows the three groups with their own explanations.
	tree = renderSection();
	const text = textOf(tree);
	for (const label of ['可疑残留（1）', '子代理子会话（1）', '未分组的普通会话（1）']) {
		assert.ok(text.includes(label), 'missing section header: ' + label);
	}
	assert.ok(text.includes('候选 3 个：可疑残留 1 · 子代理子会话 1 · 未分组的普通会话 1'), 'summary counts must be rendered');
	assert.ok(text.includes('父会话 user-1（父会话仍在）'), 'a delegation child must name its live parent');
	assert.ok(text.includes('不可读 / 数据缺失'), 'the readable evidence must survive');
	assert.ok(text.includes('仍在内存'), 'the live evidence must survive');
	// The confirmation gate stays closed until the word is typed.
	const confirm = findNodes(tree, (node) => node.type === 'button' && textOf(node).includes('清理所选'))[0];
	assert.ok(confirm, 'the cleanup button must render');
	assert.equal(confirm.props.disabled, true, 'the word gate must stay closed');
});
