// dsh-archived-sessions — Host-half tests for the delete/archive consistency
// paths, driven through a REAL cordis Context with stub services.
//
// Run: node test/host.test.mjs   (package.json declares "type":"module")
//
// Why these exist. The reported symptoms are "a deleted session reappears in
// the sidebar's 未分组 bucket" and "re-archiving leaves 数据缺失的会话 rows".
// Both are produced by the Host half, never by the UI:
//
//   1. a completed deletion drops the archive entry, so the browser's stale row
//      for that session becomes VISIBLE again (the sidebar hides archived rows
//      and nothing else). The client can only fix that if the Host tells it a
//      deletion actually completed — hence the drained-id ledger reported by
//      `list().drainedIds`, plumbed from the fire-and-forget queue sweep.
//   2. an id can re-enter the archive set with no log behind it (the Host's
//      `archiveSession` accepts a stale row, see README). A fresh listing omits
//      what it cannot read, so `list()` needs `stat()` plus the on-disk artifact
//      to tell "really missing" from "present but unreadable", and
//      `purgeStaleRecords()` may retire ONLY the positively missing entries.
//
// The stubs mirror the real contracts that matter here:
//   - the storage domain's `global.get()` returns the SAME object every call
//     (it is the object the registry caches; a replace would resurrect ids),
//   - `workspaceRegistry.archivedSessionIds` is read live off that object,
//   - `sessionPersistence.list()` is the medium: an unreadable log is simply
//     absent from it,
//   - `sessionPersistence.stat()` returns a snapshot for a stored session,
//     `undefined` for an absent one, and rejects with
//     `SessionFormatUnsupportedError` for a log this build cannot interpret,
//   - `sessions.get()` is the in-memory store (a live session's log can be
//     re-created, so those ids are never retired).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

const PENDING_FILE = 'archived-sessions-pending-delete.json';

/** Build one stub Host world. Every array is a live view for assertions. */
function makeWorld(options = {}) {
	const {
		archived = [],
		snapshots = [],
		live = [],
		workspaces = [],
		listThrows = false,
		queryThrows = false,
		stat = null,
		archiveThrows = false,
		unarchiveThrows = false
	} = options;

	// The domain's global state object: identity-stable, exactly like the object
	// the real workspace registry caches across plugin writes.
	let current = {
		initialized: true,
		workspaceIds: workspaces.map((workspace) => workspace.id),
		archivedSessionIds: archived.slice(),
		pinnedSessionIds: []
	};

	const entities = workspaces.map((workspace) => ({
		id: workspace.id,
		path: workspace.path ?? workspace.id,
		title: workspace.title ?? workspace.id,
		sessionIds: (workspace.sessionIds ?? []).slice(),
		detached: [],
		async detachSession(sessionId) {
			const at = this.sessionIds.indexOf(sessionId);
			if (at >= 0) this.sessionIds.splice(at, 1);
			this.detached.push(sessionId);
		}
	}));

	// `formatStatus` belongs to the listing record, not to the stored header.
	const records = snapshots.map((snapshot) => {
		const { formatStatus, ...headerFields } = snapshot;
		return {
			header: { cwd: 'D:\\stub', ...headerFields },
			revision: 'rev-' + headerFields.id,
			...(formatStatus === undefined ? {} : { formatStatus })
		};
	});
	const liveById = new Map(live.map((id) => [id, { id, header: { id } }]));
	const registryCalls = [];

	const world = {
		get state() {
			return current;
		},
		workspaces: entities,
		registryCalls,
		storageDomain: {
			get: (name) => (name === 'workspace'
				? { global: { get: () => current, set: async (next) => { current = next; } } }
				: undefined)
		},
		registry: {
			get archivedSessionIds() {
				return current.archivedSessionIds;
			},
			list: () => entities,
			// Mirror the real seam's decisive early return: an already archived id
			// resolves WITHOUT writing or dispatching the stop, so a test can prove
			// the stop path actually reached the seam.
			archiveSession: async (sessionId, callOptions) => {
				const already = current.archivedSessionIds.includes(sessionId);
				registryCalls.push(['archiveSession', sessionId, callOptions, already]);
				if (archiveThrows) throw new Error('archive seam unavailable');
				if (already) return;
				current = {
					...current,
					archivedSessionIds: [...current.archivedSessionIds, sessionId]
				};
			},
			unarchiveSession: async (sessionId) => {
				registryCalls.push(['unarchiveSession', sessionId]);
				if (unarchiveThrows) throw new Error('unarchive seam unavailable');
				current = {
					...current,
					archivedSessionIds: current.archivedSessionIds.filter((id) => id !== sessionId)
				};
			}
		},
		sessions: {
			get: (id) => liveById.get(id),
			list: () => [...liveById.values()]
		},
		persistence: {
			config: { root: 'D:\\stub-root' },
			list: async () => {
				if (listThrows) throw new Error('session medium unavailable');
				return records.map((record) => ({
					header: record.header,
					revision: record.revision,
					...(record.formatStatus === undefined ? {} : { formatStatus: record.formatStatus })
				}));
			},
			// The real stat(): a snapshot for a stored session, `undefined` for an
			// absent one, and a rejection for a log this build cannot interpret.
			stat: stat ?? (async (id) => {
				const record = records.find((entry) => entry.header.id === id);
				if (record === undefined) return undefined;
				return {
					header: record.header,
					revision: record.revision,
					...(record.formatStatus === undefined ? {} : { formatStatus: record.formatStatus })
				};
			}),
			resolveCurrentLog: async (id) => (records.some((record) => record.header.id === id)
				? 'D:\\stub-root\\proj\\' + id + '\\session.jsonl'
				: undefined)
		},
		query: {
			listSessions: async () => {
				if (queryThrows) throw new Error('session query unavailable');
				return records.map((record) => ({
					header: record.header,
					revision: record.revision,
					...(record.formatStatus === undefined ? {} : { formatStatus: record.formatStatus })
				}));
			},
			readSession: async () => ({ events: [], inheritedEventCount: 0 }),
			readTitleSnapshot: async () => ({ title: { title: 'stub title' } }),
			readSurface: async () => ({ events: [] })
		}
	};
	return world;
}

/** Isolate $DSH_HOME (the pending-queue file) for one test. */
async function withHome(t) {
	const home = await mkdtemp(join(tmpdir(), 'dsh-archived-sessions-'));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	t.after(async () => {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
		await rm(home, { recursive: true, force: true });
	});
	return home;
}

/** Register the stub services on a real Context and load the Host half. */
function boot(world) {
	const ctx = new Context();
	ctx.provide('storageDomain', world.storageDomain);
	ctx.provide('workspaceRegistry', world.registry);
	ctx.provide('sessions', world.sessions);
	ctx.provide('sessionPersistence', world.persistence);
	ctx.provide('sessionQuery', world.query);
	apply(ctx);
	const service = ctx.get('archivedSessions');
	assert.ok(service, 'the Host half must register the archivedSessions service');
	return service;
}

test('list() marks an archive entry whose log is gone as missing', async (t) => {
	await withHome(t);
	const world = makeWorld({
		archived: ['session-dead', 'session-alive'],
		snapshots: [{ id: 'session-alive' }]
	});
	const service = boot(world);
	const result = await service.list();
	assert.deepEqual(
		result.items.map((item) => [item.sessionId, item.missing]),
		[['session-dead', true], ['session-alive', false]]
	);
	// Nothing was queued, so no completed sweep is reported.
	assert.deepEqual(result.drainedIds, []);
});

test('purgeStaleRecords() retires logless entries, skips live ones and detaches every owner', async (t) => {
	const home = await withHome(t);
	const world = makeWorld({
		archived: ['session-dead', 'session-live', 'session-alive'],
		snapshots: [{ id: 'session-alive' }],
		live: ['session-live'],
		workspaces: [
			{ id: 'w1', sessionIds: ['session-dead', 'session-alive'] },
			// A second accounting slot must not survive: it would re-surface the
			// session in the sidebar's ungrouped bucket.
			{ id: 'w2', sessionIds: ['session-dead'] }
		]
	});
	const service = boot(world);

	const result = await service.purgeStaleRecords();
	assert.deepEqual(result.removed, ['session-dead']);
	assert.deepEqual(result.skippedLive, ['session-live']);
	assert.deepEqual(world.state.archivedSessionIds, ['session-live', 'session-alive']);
	assert.deepEqual(world.workspaces[0].sessionIds, ['session-alive']);
	assert.deepEqual(world.workspaces[1].sessionIds, []);
	assert.deepEqual(world.workspaces[0].detached, ['session-dead']);
	assert.deepEqual(world.workspaces[1].detached, ['session-dead']);

	// The retired id is remembered like any other purge, so a log that somehow
	// reappears for it is swept again instead of lingering as a ghost.
	const pending = JSON.parse(await readFile(join(home, PENDING_FILE), 'utf8'));
	assert.ok(pending.recentlyDeleted.some((entry) => entry.id === 'session-dead'));
	assert.deepEqual(pending.sessionIds, []);
});

test('purgeStaleRecords() refuses to act when the session listing is unavailable', async (t) => {
	await withHome(t);
	const world = makeWorld({ archived: ['session-dead'], listThrows: true, queryThrows: true });
	const service = boot(world);
	// An unreadable listing must never read as "every log is gone".
	await assert.rejects(() => service.purgeStaleRecords(), /无法读取会话列表/);
	assert.deepEqual(world.state.archivedSessionIds, ['session-dead']);
});

test('list() reports the ids a fire-and-forget queue sweep completed', async (t) => {
	const home = await withHome(t);
	const world = makeWorld({ archived: ['session-queued'], snapshots: [] });
	await writeFile(
		join(home, PENDING_FILE),
		JSON.stringify({ sessionIds: ['session-queued'], recentlyDeleted: [], updatedAt: Date.now() }),
		'utf8'
	);
	const service = boot(world);

	// The sweep is fired without awaiting: the listing that starts it reports
	// nothing, and the NEXT listing reports what it completed.
	const first = await service.list();
	assert.deepEqual(first.drainedIds, []);

	let queued = ['session-queued'];
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const pending = JSON.parse(await readFile(join(home, PENDING_FILE), 'utf8'));
		queued = pending.sessionIds;
		if (queued.length === 0) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.deepEqual(queued, [], 'the sweep must dequeue the completed id');
	await new Promise((resolve) => setTimeout(resolve, 20));

	assert.deepEqual(world.state.archivedSessionIds, [], 'the sweep must drop the archive entry');
	const second = await service.list();
	assert.deepEqual(second.drainedIds, ['session-queued']);
});

test('scanOrphans splits suspects, subagent children and ungrouped sessions', async (t) => {
	await withHome(t);
	const world = makeWorld({
		archived: ['archived-1'],
		snapshots: [
			// A delegated child: its cwd names the Workspace, but DSH never gives a
			// subagent child a slot, so the missing slot says nothing about debris.
			{ id: 'child-1', cwd: 'D:\\proj', origin: 'subagent', parentSession: 'user-1' },
			// The parent, accounted.
			{ id: 'user-1', cwd: 'D:\\proj' },
			// An ordinary session in the Workspace's own directory with no slot:
			// the delete-residue signature.
			{ id: 'user-2', cwd: 'D:\\proj' },
			// An ordinary session elsewhere: legitimately ungrouped.
			{ id: 'user-3', cwd: 'D:\\other' },
			// Archived and accounted sessions never reach the candidate list.
			{ id: 'archived-1', cwd: 'D:\\proj' },
			{ id: 'member-1', cwd: 'D:\\proj' }
		],
		workspaces: [{ id: 'w1', path: 'D:\\proj', sessionIds: ['user-1', 'member-1'] }]
	});
	const service = boot(world);

	const result = await service.scanOrphans();
	const byId = new Map(result.items.map((item) => [item.sessionId, item]));
	assert.deepEqual([...byId.keys()].sort(), ['child-1', 'user-2', 'user-3']);
	assert.equal(byId.get('child-1').kind, 'subagent');
	assert.equal(byId.get('child-1').parentSession, 'user-1');
	assert.equal(byId.get('child-1').parentAccounted, true, 'the delegation history survives its parent');
	assert.equal(byId.get('user-2').kind, 'suspect');
	assert.equal(byId.get('user-3').kind, 'unaccounted');
	assert.equal(byId.get('user-3').parentSession, null);
	assert.deepEqual(result.counts, { suspect: 1, subagent: 1, unaccounted: 1 });
	assert.deepEqual(result.kinds, ['suspect', 'subagent', 'unaccounted']);
	assert.equal(result.scanned, 6);
});

// --- P1-a: a stop request must actually reach the archive seam --------------
//
// `archiveSession(id, { stopActivity: true })` early-returns for an id that is
// already in the archive set, and every session this plugin deletes is
// archived. The stub mirrors that early return (see makeWorld), so these tests
// fail if the Host ever calls the seam directly again.

test('P1-a: requesting a stop unarchives first, so the seam really dispatches it', async (t) => {
	await withHome(t);
	const world = makeWorld({
		archived: ['session-live'],
		snapshots: [{ id: 'session-live', cwd: 'D:\\proj' }],
		live: ['session-live']
	});
	const service = boot(world);

	const result = await service.deleteSession('session-live', 'stub title', 'title', false, false);

	assert.equal(result.pending, true, 'a live session is queued, never deleted in place');
	assert.equal(result.stopError, null, 'the stop request must not report a failure');
	assert.deepEqual(world.registryCalls, [
		['unarchiveSession', 'session-live'],
		// The final `false` is the stub's "already archived" flag: false proves the
		// call got past the early return and a stop was really dispatched.
		['archiveSession', 'session-live', { stopActivity: true }, false]
	]);
	assert.deepEqual(world.state.archivedSessionIds, ['session-live'], 'the session stays archived while queued');
});

test('P1-a: a failed re-archive restores the archive entry and is reported', async (t) => {
	await withHome(t);
	const world = makeWorld({
		archived: ['session-live'],
		snapshots: [{ id: 'session-live', cwd: 'D:\\proj' }],
		live: ['session-live'],
		archiveThrows: true
	});
	const service = boot(world);

	const result = await service.deleteSession('session-live', 'stub title', 'title', false, false);

	assert.equal(result.pending, true);
	assert.match(result.stopError, /archive seam unavailable/);
	assert.deepEqual(world.state.archivedSessionIds, ['session-live'], 'the compensating write must restore the entry');
});

// --- P1-b: missing / unreadable / present are three different states -------

/** The shape of the real refusal for a stored log this build cannot interpret. */
function unsupportedFormatError(sessionId) {
	const error = new Error('session "' + sessionId + '" uses log format v9, but this harness reads only v4');
	error.name = 'SessionFormatUnsupportedError';
	return error;
}

test('P1-b: an unreadable log is not a stale record — cleanup keeps its ownership', async (t) => {
	await withHome(t);
	const world = makeWorld({
		archived: ['session-legacy', 'session-gone'],
		workspaces: [{ id: 'w1', sessionIds: ['session-legacy', 'session-gone'] }],
		stat: async (id) => {
			if (id === 'session-legacy') throw unsupportedFormatError(id);
			return undefined;
		}
	});
	const service = boot(world);

	// list() must report the log as unreadable, not as "日志已不存在".
	const listed = await service.list();
	const legacy = listed.items.find((item) => item.sessionId === 'session-legacy');
	assert.equal(legacy.missing, false);
	assert.equal(legacy.unreadable, true);
	assert.match(legacy.unreadableReason, /format v9/);
	assert.equal(listed.staleLabel, '日志已不存在（归档记录失效）');

	const result = await service.purgeStaleRecords();
	assert.deepEqual(result.removed, ['session-gone'], 'only the positively missing record is retired');
	assert.deepEqual(result.skippedUnreadable, ['session-legacy']);
	assert.deepEqual(result.skippedLive, []);
	assert.deepEqual(world.state.archivedSessionIds, ['session-legacy'], 'the unreadable archive entry survives');
	assert.deepEqual(world.workspaces[0].sessionIds, ['session-legacy'], 'its workspace accounting survives');
	assert.deepEqual(world.workspaces[0].detached, ['session-gone']);
});

test('P1-b: stat() undefined plus no artifact is a real missing record — cleanup may retire it', async (t) => {
	await withHome(t);
	const world = makeWorld({
		archived: ['session-gone'],
		workspaces: [{ id: 'w1', sessionIds: ['session-gone'] }],
		stat: async () => undefined
	});
	const service = boot(world);

	const result = await service.purgeStaleRecords();
	assert.deepEqual(result.removed, ['session-gone']);
	assert.deepEqual(result.skippedUnreadable, []);
	assert.deepEqual(world.state.archivedSessionIds, []);
	assert.deepEqual(world.workspaces[0].sessionIds, []);
});

test('P1-b: deleteSession refuses an unreadable log instead of orphaning it', async (t) => {
	await withHome(t);
	const world = makeWorld({
		archived: ['session-legacy'],
		workspaces: [{ id: 'w1', sessionIds: ['session-legacy'] }],
		stat: async (id) => { throw unsupportedFormatError(id); }
	});
	const service = boot(world);

	await assert.rejects(
		() => service.deleteSession('session-legacy', 'anything', '日志已不存在（归档记录失效）', false, false),
		/无法读取/
	);
	assert.deepEqual(world.state.archivedSessionIds, ['session-legacy']);
	assert.deepEqual(world.workspaces[0].sessionIds, ['session-legacy']);
	assert.deepEqual(world.workspaces[0].detached, []);
});

test('P1-b: list() passes formatStatus through for a migration-required log', async (t) => {
	await withHome(t);
	const world = makeWorld({
		archived: ['session-v3'],
		snapshots: [{ id: 'session-v3', formatStatus: 'migration-required' }]
	});
	const service = boot(world);

	const result = await service.list();
	const item = result.items[0];
	assert.equal(item.missing, false);
	assert.equal(item.unreadable, false);
	assert.equal(item.formatStatus, 'migration-required');
	assert.equal(result.staleLabel, '日志已不存在（归档记录失效）', 'the Host owns the stale-row wording');
});

test('P1-b: the queue sweep never retires records for an unreadable log', async (t) => {
	const home = await withHome(t);
	let statCalls = 0;
	const world = makeWorld({
		archived: ['session-legacy'],
		workspaces: [{ id: 'w1', sessionIds: ['session-legacy'] }],
		stat: async (id) => {
			statCalls += 1;
			throw unsupportedFormatError(id);
		}
	});
	await writeFile(
		join(home, PENDING_FILE),
		JSON.stringify({ sessionIds: ['session-legacy'], recentlyDeleted: [], updatedAt: Date.now() }),
		'utf8'
	);
	const service = boot(world);

	// list() fires the sweep without awaiting. The archived id is also probed by
	// the listing itself, so wait for both probes to have happened.
	await service.list();
	for (let attempt = 0; attempt < 100 && statCalls < 2; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(statCalls >= 2, 'the sweep must probe the queued id');
	await new Promise((resolve) => setTimeout(resolve, 20));

	const pending = JSON.parse(await readFile(join(home, PENDING_FILE), 'utf8'));
	assert.deepEqual(pending.sessionIds, ['session-legacy'], 'the unreadable id stays queued');
	assert.deepEqual(world.state.archivedSessionIds, ['session-legacy']);
	assert.deepEqual(world.workspaces[0].sessionIds, ['session-legacy']);
	assert.deepEqual(world.workspaces[0].detached, []);
});
