// dsh-archived-sessions — Host log/medium helpers (pure, no service state).
//
// WHY A SEPARATE MODULE
// lib/index.js owns the Remote surface, the pending-delete queue and the
// archive-set writes. Everything here only OBSERVES the session medium: how a
// stored session's log is located, how the listing is loaded, how one
// descendant subtree is walked. None of it depends on a live plugin instance,
// so it lives outside the service class instead of buried in it.
//
// The DSH 0.2.x seam facts that shape these helpers (why read them before
// touching the delete/cleanup paths):
//   - `SessionPersistence.list()` returns `{ header, revision, formatStatus? }`
//     and SILENTLY OMITS a stored log it cannot interpret (unsupported format
//     version or a corrupt header). Absence from `list()` is therefore NOT
//     evidence that the log is gone.
//   - `stat(id)` resolves `undefined` for a session that is absent AND for one
//     whose header cannot be parsed, while a stored log the build refuses to
//     interpret rejects with `SessionFormatUnsupportedError`. Only a negative
//     on-disk probe turns "not listed" into "really missing".
//   - `formatStatus === 'migration-required'` marks a readable historical
//     generation: the backend migrates it on the first read, so such an entry is
//     a normal listing row and must never be cleaned as stale.
//   - The seam has no deletion API (and `ctx.fs` has no delete), so deletion
//     keeps shelling out after re-deriving and validating the path. The on-disk
//     layout is still part of the contract:
//     `<root>/<projectKey(cwd)>/<encodeSegment(id)>/session[.vN].jsonl[.zstd]`.
//     `resolveCurrentLog(id)` covers the current generation; the root scan covers
//     a session that currently owns only a historical generation.

import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

// Canonical JSONL artifact names across session format generations: v0 kept
// "session.jsonl[.zstd]"; every later generation carries a "session.vN" component.
const GENERATION_FILE_RE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/

/** Whether one directory entry is a canonical session log artifact. */
export function isGenerationFile(name) {
  return GENERATION_FILE_RE.test(name)
}

/**
 * The configured persistence root, or null.
 *
 * The JSONL backend exposes the resolved absolute path as `root`; `config.root`
 * is the raw configuration spelling (possibly relative). Prefer the resolved
 * one, keep the raw field as the fallback for third-party backends.
 */
function persistenceRootOf(persistence) {
  if (!persistence || typeof persistence !== 'object') return null
  if (typeof persistence.root === 'string' && persistence.root !== '') return persistence.root
  const configured = persistence.config ? persistence.config.root : undefined
  return typeof configured === 'string' && configured !== '' ? configured : null
}

/** The display title of a workspace path: its last segment (basename). */
export function workspaceTitleOf(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  return basename(cwd)
}

/**
 * Resolve the on-disk directory that owns one session's log, or null.
 *
 * `resolveCurrentLog(id)` is the backend's current-generation accessor and
 * returns nothing while only a historical generation exists, so the root is
 * also scanned for the session's own directory (one level below the root:
 * `<root>/<projectDir>/<id>/`).
 */
export async function resolveSessionDir(persistence, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (persistence && typeof persistence.resolveCurrentLog === 'function') {
    try {
      const current = await persistence.resolveCurrentLog(sessionId)
      if (typeof current === 'string' && current !== '') return dirname(current)
    } catch {
      /* fall through to the root scan */
    }
  }
  const root = persistenceRootOf(persistence)
  if (root !== null) {
    let indeterminate = false
    let projects
    try {
      projects = await readdir(root, { withFileTypes: true })
    } catch (error) {
      // A missing root means "no stored sessions here"; any other failure means
      // the medium cannot be inspected. Callers must not read that as absence
      // (probeLogState turns the propagated fault into `unreadable`).
      if (error && error.code !== 'ENOENT') throw error
      return null
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const candidate = join(root, project.name, sessionId)
      try {
        if ((await stat(candidate)).isDirectory()) return candidate
      } catch (error) {
        // ENOENT/ENOTDIR = this project directory does not own the id. Another
        // code (EACCES/EPERM/...) means we could not check it: remember that and
        // fail closed after the sweep instead of reporting "not found".
        if (error && error.code !== 'ENOENT' && error.code !== 'ENOTDIR') indeterminate = true
      }
    }
    if (indeterminate) throw new Error('无法检查会话目录：读取根目录下的项目目录失败')
  }
  return null
}

/**
 * The session's own directory when it still holds a canonical log artifact.
 *
 * Used only as corroborating evidence for a session that a fresh listing
 * omitted: an empty/foreign directory is not a session log. A directory that
 * exists but cannot be listed propagates the fault, so the caller never treats
 * an unreadable medium as a missing log.
 */
export async function findLogArtifact(persistence, sessionId) {
  const dir = await resolveSessionDir(persistence, sessionId)
  if (dir === null || dir === '') return null
  const entries = await readdir(dir)
  return entries.some(isGenerationFile) ? dir : null
}

/**
 * Decide what backs one archived id that a fresh listing omitted.
 *
 * @returns {Promise<
 *   | { state: 'present', snap: object }
 *   | { state: 'unreadable', reason: string }
 *   | { state: 'missing' }>}
 *
 * `present` is reported only when `stat()` handed back a snapshot (the medium
 * knows the id after all). `missing` requires POSITIVE evidence of absence:
 * `stat()` resolved `undefined` AND no artifact directory survives. Everything
 * else — a `stat()` rejection (unsupported format, corruption, storage fault) or
 * an artifact whose header cannot be parsed — is `unreadable`: removing that
 * session's workspace accounting or archive entry could orphan real content, so
 * the destructive paths must not treat it as "gone".
 */
export async function probeLogState(persistence, sessionId) {
  if (!persistence) return { state: 'unreadable', reason: '会话存储服务不可用' }
  if (typeof persistence.stat === 'function') {
    let snapshot
    try {
      snapshot = await persistence.stat(sessionId)
    } catch (error) {
      return { state: 'unreadable', reason: errorText(error) }
    }
    if (snapshot !== undefined && snapshot !== null) return { state: 'present', snap: snapshot }
  } else if (persistenceRootOf(persistence) === null) {
    // A provider without `stat()` and without a readable root leaves no way to
    // prove absence; refusing to clean is the only safe answer.
    return { state: 'unreadable', reason: '该存储后端没有 stat()，也没有可扫描的 root，无法确认日志是否存在' }
  }
  let artifact
  try {
    artifact = await findLogArtifact(persistence, sessionId)
  } catch (error) {
    // The medium could not be inspected (permission/storage fault): that is not
    // proof of absence, so fail closed.
    return { state: 'unreadable', reason: '无法检查日志文件是否存在：' + errorText(error) }
  }
  if (artifact === null) return { state: 'missing' }
  return {
    state: 'unreadable',
    reason: '日志文件存在，但当前 DSH 版本无法解析它的头部（可能已损坏或格式不受支持）',
  }
}

function errorText(error) {
  return String((error && error.message) || error)
}

// Session metadata listing with a resilience fallback: `list()` first (cheap
// headers + durable revision tokens); only a THROW falls back to the
// session-query corpus. The fallback has no durable revision token, so it mints
// a UNIQUE revision per listing — a constant would pin the per-session count
// cache forever, and a session that keeps writing would show a stale message
// count. An empty listing is a valid result (fresh corpus, or archived ids whose
// logs are all gone); treating it as failure would turn a zombie-only archive
// into a hard page error instead of "数据缺失" rows.
let fallbackEpoch = 0

export async function loadSnapshots(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence) {
    try {
      // `formatStatus` is passed through untouched: 'migration-required' is a
      // readable historical log, while an omitted status means the provider had
      // nothing to say (e.g. a not-yet-materialized session).
      const snapshots = await persistence.list()
      return { snapshots, ok: true }
    } catch {
      /* fall through to the query fallback */
    }
  }
  const query = ctx.get('sessionQuery')
  if (query) {
    try {
      const records = await query.listSessions()
      fallbackEpoch += 1
      const revision = 'list-fallback-' + fallbackEpoch
      return {
        snapshots: records.map((record) => ({
          header: record.header,
          revision,
          // The 0.2.1 session-query records carry the medium's format status;
          // keep it so a migration-required session is not mistaken for a
          // plain one in the fallback path.
          ...(typeof record.formatStatus === 'string' ? { formatStatus: record.formatStatus } : {}),
        })),
        ok: true,
      }
    } catch {
      /* fall through */
    }
  }
  return { snapshots: [], ok: false }
}

/** Index a listing by session id (last snapshot wins, as in the service). */
export function buildById(snapshots) {
  const bySnap = new Map()
  for (const snap of snapshots) bySnap.set(snap.header.id, snap)
  return bySnap
}

// Descendants of one session (children, then their children), with any branch
// rooted at a LIVE session pruned: a live session keeps writing its log, so
// deleting it would be undone by its own write chain — and its subtree is left
// alone for the same reason. Returns the snapshots safe to delete and the ids
// skipped because something on their path is still live.
export function subtreeOf(snapshots, rootId, isLive) {
  const byParent = new Map()
  for (const snap of snapshots) {
    const parent = snap.header.parentSession
    if (parent === undefined || parent === null) continue
    const list = byParent.get(parent)
    if (list === undefined) byParent.set(parent, [snap])
    else list.push(snap)
  }
  const deletable = []
  const blocked = []
  const seen = new Set([rootId])
  const walk = (parentId, underBlocked) => {
    for (const snap of byParent.get(parentId) || []) {
      const id = snap.header.id
      if (seen.has(id)) continue
      seen.add(id)
      const blockedHere = underBlocked || isLive(id)
      if (blockedHere) blocked.push(id)
      else deletable.push(snap)
      walk(id, blockedHere)
    }
  }
  walk(rootId, false)
  return { deletable, blocked }
}
