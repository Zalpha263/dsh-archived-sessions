// dsh-archived-sessions — pure deletion-planning helpers (ESM, no side effects).
//
// WHY A SEPARATE MODULE
// The delete policy has three decisions that must be provable without a live
// host: how a descendant session is classified, which descendants a chosen
// cascade mode removes, and how per-session results aggregate into a batch
// report. This module is imported by lib/index.js (the Host half) and by
// test/plan.test.mjs only — the Web Client half CANNOT import it (the DSH client
// module loader resolves neither relative paths nor bare specifiers for a
// hand-written bundle), so no policy may live here that the UI needs verbatim:
// the UI renders whatever the Host reports.

/** Cascade choices accepted from the client; anything else falls back to the default. */
export const CASCADE_MODES = ['keep', 'classified', 'all']

/**
 * Default cascade for batch delete, confirmed with the plugin owner:
 * descendants created as subagent children are internal sessions the user can
 * neither see nor delete anywhere else, so they go with the parent; a descendant
 * the user forked carries its own conversation and is KEPT unless the user
 * explicitly asks for the full tree.
 */
export const DEFAULT_CASCADE_MODE = 'classified'

/** The literal the user must type to confirm a batch delete. */
export const BULK_CONFIRM_WORD = '删除'

/**
 * Classify one session header as a descendant.
 *
 * `parentSession` is the durable lineage link; `origin: 'subagent'` is the
 * product classification DSH stamps on subagent children; `isSeeded` marks the
 * fork-inherited event prefix (a fork carries one, a spawn child has none).
 *
 * @returns {'subagent'|'fork'|'spawn'|null} null when the header is not a descendant.
 */
export function classifyChild(header) {
  if (header === null || typeof header !== 'object') return null
  if (typeof header.parentSession !== 'string' || header.parentSession === '') return null
  if (header.origin === 'subagent') return 'subagent'
  if (header.isSeeded === true) return 'fork'
  return 'spawn'
}

/** True for the descendant kinds the default cascade removes (internal sessions). */
export function isInternalChild(kind) {
  return kind === 'subagent' || kind === 'spawn'
}

/** Normalize a client-supplied cascade mode onto the accepted set. */
export function normalizeCascadeMode(mode) {
  return CASCADE_MODES.includes(mode) ? mode : DEFAULT_CASCADE_MODE
}

/** Whether one descendant kind is removed under a cascade mode. */
export function shouldDeleteChild(kind, mode) {
  const normalized = normalizeCascadeMode(mode)
  if (normalized === 'all') return true
  if (normalized === 'classified') return isInternalChild(kind)
  return false
}

/** The batch confirmation gate: the typed word must match exactly (trimmed). */
export function confirmWordMatches(input, word = BULK_CONFIRM_WORD) {
  return typeof input === 'string' && input.trim() === word
}

/**
 * Aggregate per-session results into the batch summary the UI reports.
 * Every result carries `status`; `deletedChildren` counts descendants removed
 * alongside their parent.
 */
export function summarizeResults(results) {
  const summary = {
    requested: Array.isArray(results) ? results.length : 0,
    deleted: 0,
    pending: 0,
    skipped: 0,
    failed: 0,
    deletedChildren: 0,
  }
  if (!Array.isArray(results)) return summary
  for (const result of results) {
    if (result === null || typeof result !== 'object') continue
    if (result.status === 'deleted') summary.deleted += 1
    else if (result.status === 'pending') summary.pending += 1
    else if (result.status === 'skipped') summary.skipped += 1
    else summary.failed += 1
    if (Array.isArray(result.deletedChildren)) summary.deletedChildren += result.deletedChildren.length
  }
  return summary
}
