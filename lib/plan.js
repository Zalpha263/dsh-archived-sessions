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
 * The three populations the orphan scan reports, in the order the UI lists them.
 *
 * The scan's candidate rule is mechanical by design — a log exists, no
 * Workspace accounts for the session, and the archive set does not name it — so
 * it catches three very different things:
 *
 * - `suspect`: an ORDINARY session whose cwd belongs to a registered Workspace
 *   yet carries no accounting slot. A slot is only ever written by session
 *   creation inside a Workspace, by a fork, or by the one-time boot migration,
 *   so an ordinary session missing from its own Workspace means the slot was
 *   REMOVED — the signature of a delete that left (or rebuilt) the log.
 * - `subagent`: a delegated child session (`origin: 'subagent'`). DSH creates
 *   one per delegation and never gives it a slot (`dsh-subagent`'s
 *   childSessionMeta records cwd/parentSession/origin and nothing attaches it),
 *   and the sidebar hides these rows outright. They are history, not debris.
 * - `unaccounted`: an ORDINARY session whose cwd has no registered Workspace —
 *   legitimately ungrouped, shown by the sidebar under 未分组.
 */
export const ORPHAN_KINDS = ['suspect', 'subagent', 'unaccounted']

/**
 * Path spelling used to compare a session cwd against a Workspace path.
 * Windows compares case-insensitively and both spellings may carry a trailing
 * separator; POSIX compares exactly.
 * @param value - raw path, or anything else (→ '').
 * @param caseInsensitive - platform policy; defaults to the host platform.
 * @returns the comparable spelling, or '' when there is nothing to compare.
 */
export function normalizeComparablePath(value, caseInsensitive = process.platform === 'win32') {
  if (typeof value !== 'string') return ''
  const trimmed = value.replace(/[\\/]+$/, '')
  if (trimmed === '') return ''
  return caseInsensitive ? trimmed.toLowerCase() : trimmed
}

/**
 * Normalize the registry's Workspace paths ONCE for repeated `classifyOrphan`
 * calls (the scan runs over every stored session).
 * @param paths - Workspace paths.
 * @param caseInsensitive - platform policy; defaults to the host platform.
 * @returns the comparable path set.
 */
export function comparableWorkspacePaths(paths, caseInsensitive = process.platform === 'win32') {
  const set = new Set()
  for (const path of Array.isArray(paths) ? paths : []) {
    const normalized = normalizeComparablePath(path, caseInsensitive)
    if (normalized !== '') set.add(normalized)
  }
  return set
}

/**
 * Classify one unaccounted, unarchived session for the orphan report.
 * @param header - the session's stored header (cwd, origin).
 * @param comparablePaths - `comparableWorkspacePaths(registry paths)`.
 * @param caseInsensitive - platform policy; must match `comparablePaths`.
 * @returns {'suspect'|'subagent'|'unaccounted'} one of {@link ORPHAN_KINDS}.
 */
export function classifyOrphan(header, comparablePaths, caseInsensitive = process.platform === 'win32') {
  if (header === null || typeof header !== 'object') return 'unaccounted'
  if (header.origin === 'subagent') return 'subagent'
  const cwd = normalizeComparablePath(header.cwd, caseInsensitive)
  if (cwd === '') return 'unaccounted'
  return comparablePaths instanceof Set && comparablePaths.has(cwd) ? 'suspect' : 'unaccounted'
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
