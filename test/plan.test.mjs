// dsh-archived-sessions — unit tests for the pure deletion-planning helpers.
//
// Run: node test/plan.test.mjs   (package.json declares "type":"module")
//
// The destructive paths (batch delete, the pending queue) are exercised against
// a stub Host in the migration/verification harness; this file pins the POLICY
// itself: how a descendant is classified, which kinds a cascade mode removes,
// the confirmation gate, and how per-session results aggregate.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	BULK_CONFIRM_WORD,
	DEFAULT_CASCADE_MODE,
	classifyChild,
	confirmWordMatches,
	isInternalChild,
	normalizeCascadeMode,
	shouldDeleteChild,
	summarizeResults
} from '../lib/plan.js';

test('classifyChild separates subagent children, forks and spawn children', () => {
	// Not a descendant at all.
	assert.equal(classifyChild(null), null);
	assert.equal(classifyChild({}), null);
	assert.equal(classifyChild({ id: 's1' }), null);
	assert.equal(classifyChild({ parentSession: '' }), null);
	assert.equal(classifyChild({ parentSession: 42 }), null);

	// A subagent child is stamped by the product classification.
	assert.equal(classifyChild({ parentSession: 'p', origin: 'subagent' }), 'subagent');
	assert.equal(classifyChild({ parentSession: 'p', origin: 'subagent', isSeeded: false }), 'subagent');

	// A fork carries the inherited event prefix.
	assert.equal(classifyChild({ parentSession: 'p', isSeeded: true }), 'fork');

	// A spawn child has a parent link but no inherited prefix.
	assert.equal(classifyChild({ parentSession: 'p', isSeeded: false }), 'spawn');
	assert.equal(classifyChild({ parentSession: 'p' }), 'spawn');
});

test('isInternalChild covers exactly the kinds the default cascade removes', () => {
	assert.equal(isInternalChild('subagent'), true);
	assert.equal(isInternalChild('spawn'), true);
	assert.equal(isInternalChild('fork'), false);
	assert.equal(isInternalChild(null), false);
});

test('shouldDeleteChild: classified keeps forks, all removes them, keep removes none', () => {
	assert.equal(shouldDeleteChild('subagent', 'classified'), true);
	assert.equal(shouldDeleteChild('spawn', 'classified'), true);
	assert.equal(shouldDeleteChild('fork', 'classified'), false, 'the user\'s own fork must survive the default');

	assert.equal(shouldDeleteChild('subagent', 'all'), true);
	assert.equal(shouldDeleteChild('spawn', 'all'), true);
	assert.equal(shouldDeleteChild('fork', 'all'), true);

	assert.equal(shouldDeleteChild('subagent', 'keep'), false);
	assert.equal(shouldDeleteChild('spawn', 'keep'), false);
	assert.equal(shouldDeleteChild('fork', 'keep'), false);
});

test('normalizeCascadeMode falls back to the confirmed default', () => {
	assert.equal(DEFAULT_CASCADE_MODE, 'classified');
	for (const mode of ['keep', 'classified', 'all']) assert.equal(normalizeCascadeMode(mode), mode);
	assert.equal(normalizeCascadeMode(undefined), 'classified');
	assert.equal(normalizeCascadeMode(null), 'classified');
	assert.equal(normalizeCascadeMode(''), 'classified');
	assert.equal(normalizeCascadeMode('nope'), 'classified');
	assert.equal(normalizeCascadeMode(7), 'classified');
});

test('confirmWordMatches is the batch gate and rejects look-alikes', () => {
	assert.equal(BULK_CONFIRM_WORD, '删除');
	assert.equal(confirmWordMatches('删除'), true);
	assert.equal(confirmWordMatches('  删除  '), true, 'surrounding whitespace is tolerated');
	assert.equal(confirmWordMatches('刪除'), false, 'traditional form must not pass');
	assert.equal(confirmWordMatches('删除！'), false);
	assert.equal(confirmWordMatches('delete'), false);
	assert.equal(confirmWordMatches(''), false);
	assert.equal(confirmWordMatches(null), false);
	assert.equal(confirmWordMatches(undefined), false);
	assert.equal(confirmWordMatches(7), false);
});

test('summarizeResults aggregates every status and counts removed children', () => {
	const summary = summarizeResults([
		{ status: 'deleted', deletedChildren: ['a', 'b'] },
		{ status: 'deleted', deletedChildren: [] },
		{ status: 'pending', deletedChildren: [] },
		{ status: 'skipped', deletedChildren: [] },
		{ status: 'failed', deletedChildren: [] },
		{ status: 'failed', deletedChildren: [] }
	]);
	assert.deepEqual(summary, { requested: 6, deleted: 2, pending: 1, skipped: 1, failed: 2, deletedChildren: 2 });

	// Degenerate inputs never throw: an empty batch and a missing result list.
	assert.deepEqual(summarizeResults([]), { requested: 0, deleted: 0, pending: 0, skipped: 0, failed: 0, deletedChildren: 0 });
	assert.deepEqual(summarizeResults(null).requested, 0);
	// An unknown status counts as a failure rather than silently disappearing.
	assert.equal(summarizeResults([{ status: 'weird' }]).failed, 1);
	// Non-object rows are ignored, and a malformed deletedChildren is not counted.
	const tolerant = summarizeResults([null, { status: 'deleted' }, { status: 'deleted', deletedChildren: 'x' }]);
	assert.deepEqual(tolerant, { requested: 3, deleted: 2, pending: 0, skipped: 0, failed: 0, deletedChildren: 0 });
});
