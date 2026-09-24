// dsh-archived-sessions — Host half (persistent).
//
// Registers the `archivedSessions` Remote service for the web Client half.
// The Client calls it through the Typert Gateway (`/api` RPC):
//   1. the TypertRemoteService superclass registers the service via
//      `ctx.reflect.provide` with the wire binding { service, serviceKey,
//      namespace };
//   2. the Remote markers below are applied WITHOUT decorator syntax
//      (Node 24 rejects stage-3 decorators by default) through the manual
//      decorator-context trick, equivalent to `@Remote('name')`.
//
// IMPORTANT: the Gateway derives parameter wires from the method SOURCE
// (parameter names must be simple identifiers — no destructuring, defaults,
// or rest), and the client-side contribution matches them positionally.
//
// Domain knowledge (see the DSH runtime sources):
//   - The archive set lives in the workspace storage domain ("workspace",
//     version 2) global singleton field `archivedSessionIds`, in archive
//     order. Archiving never touches workspace accounting, so restoring a
//     session brings it back to its original workspace slot.
//   - The workspace registry caches the same state object the domain holds;
//     mutations must be performed IN PLACE on that object so the registry
//     cache stays coherent (a replace would resurrect removed ids on the
//     next registry write).
//   - Session logs are per-session JSONL files; deleting a session that is
//     live in the in-memory store is unstable (its write chain re-creates
//     the log), so the delete guard refuses live sessions.
//   - SessionPersistence.list()/stat() observe the medium, so re-listing after a
//     file deletion reliably reports whether the log is really gone.
//   - On-disk layout (dsh-session-persistence-jsonl 0.1.5-rc.2):
//     <root>/<projectKey(cwd)>/<encodeSegment(id)>/session[.vN].jsonl(.zstd).
//     Session format version 3 appends a generation component to the artifact
//     name (v0 kept the bare name). encodeSegment() is the identity for every
//     DSH-minted id (all ids are [A-Za-z0-9._-]) but is NOT publicly exported,
//     so the delete path validates the literal id; see resolveSessionDir.
//   - 0.1.5-rc.2 dropped SessionPersistence.listSnapshots() (the seam is now
//     stat()/list()) and demoted locate() to a private backend method; the
//     public path accessor is JsonlSessionPersistence.resolveCurrentLog(id).
//     See loadSnapshots and resolveSessionDir.

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { dirname, join } from 'node:path'
import {
  BULK_CONFIRM_WORD,
  DEFAULT_CASCADE_MODE,
  classifyChild,
  confirmWordMatches,
  normalizeCascadeMode,
  shouldDeleteChild,
  summarizeResults,
} from './plan.js'

const ARCHIVED_LIMIT = 6
const MAX_TEXT = 240
const CONCURRENCY = 2
// v1.3.1: the session-query fallback has no durable revision token, so every
// listing must mint a UNIQUE revision — a constant would pin the per-session
// count cache forever, and a session that keeps writing would show a stale
// message count. A unique token effectively disables the cache in fallback
// mode (each poll recounts, always fresh) while the in-flight/queue dedup
// (countPending) keeps concurrent repetitive listings safe.
let fallbackEpoch = 0

// Per-session message-count cache keyed by the log revision token.
const countCache = new Map()
const countQueue = []
const countInflight = new Set()
let countRunning = 0

function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[图片]')
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text
}

function toolNamesOf(blocks) {
  if (!Array.isArray(blocks)) return []
  const names = []
  for (const block of blocks) {
    if (block && block.type === 'tool-call' && typeof block.name === 'string') names.push(block.name)
  }
  return names
}

// Mirrors the client's displayTitle chain: durable title → cwd basename → session id.
function workspaceTitleOf(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const clean = cwd.replace(/[\\/]+$/, '')
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return slash >= 0 ? clean.slice(slash + 1) : clean
}

async function readDurableTitle(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (!query) return ''
  const obs = await query.readTitleSnapshot(sessionId)
  const title = obs && obs.title && typeof obs.title.title === 'string' ? obs.title.title : ''
  return title.trim()
}

// Canonical JSONL artifact names across session format generations: v0 kept
// "session.jsonl[.zstd]"; every later generation carries a "session.vN" component.
const GENERATION_FILE_RE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/

function parentOf(filePath) {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return slash >= 0 ? filePath.slice(0, slash) : ''
}

function baseNameOf(filePath) {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return slash >= 0 ? filePath.slice(slash + 1) : filePath
}

// Resolve the on-disk directory that owns an archived session's log.
//
// 0.1.5-rc.2 removed listSnapshots()/locate() from the SessionPersistence seam.
// The current public accessor is the backend's resolveCurrentLog(id); it returns
// nothing while only a historical format generation exists, so we also scan the
// configured root for the session's own directory (the layout is the same in
// every version: <root>/<projectDir>/<encodeSegment(id)>/). The legacy locate()
// stays last for <=0.1.2-rc.1 hosts. Returns null when nothing owns the id.
async function resolveSessionDir(persistence, snap) {
  const sessionId = snap.header.id
  if (typeof persistence.resolveCurrentLog === 'function') {
    try {
      const current = await persistence.resolveCurrentLog(sessionId)
      if (typeof current === 'string' && current !== '') return parentOf(current)
    } catch (error) {
      /* fall through to the root scan */
    }
  }
  const root = persistence.config && typeof persistence.config.root === 'string'
    ? persistence.config.root
    : null
  if (root !== null) {
    try {
      const projects = await readdir(root, { withFileTypes: true })
      for (const project of projects) {
        if (!project.isDirectory()) continue
        const candidate = join(root, project.name, sessionId)
        try {
          if ((await stat(candidate)).isDirectory()) return candidate
        } catch (error) {
          /* not this project directory */
        }
      }
    } catch (error) {
      /* root unreadable; fall through */
    }
  }
  if (typeof persistence.locate === 'function') {
    try {
      const location = persistence.locate(snap.header)
      if (location && typeof location.path === 'string' && location.path !== '') {
        return parentOf(location.path)
      }
    } catch (error) {
      /* not locatable */
    }
  }
  return null
}

// Descendants of one session (children, then their children), with any branch
// rooted at a LIVE session pruned: a live session keeps writing its log, so
// deleting it would be undone by its own write chain — and its subtree is left
// alone for the same reason. Returns the snapshots safe to delete and the ids
// skipped because something on their path is still live.
function subtreeOf(snapshots, rootId, isLive) {
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

// Delete one session's own log directory after re-verifying the derived path.
// Shared by the target session and, in cascade mode, every descendant. Durable
// records are the caller's job; verification is a single pass at the end.
async function removeLogDirectory(persistence, shell, snap) {
  const sessionId = snap.header.id
  if (!shell) throw new Error('文件删除服务不可用，已取消删除')
  if (!persistence) throw new Error('会话存储服务不可用，已取消删除')
  const dir = await resolveSessionDir(persistence, snap)
  if (dir === null || dir === '') throw new Error('无法定位会话日志文件，已取消删除：' + sessionId)
  // `dirName === sessionId` holds because encodeSegment is the identity for
  // every DSH-minted id; an id containing `~` or another unsafe unit would appear
  // as ~XXXX here and is REFUSED by design (encodeSegment is not exported).
  if (baseNameOf(dir) !== sessionId) throw new Error('日志文件路径校验失败，已取消删除：' + sessionId)
  // Accept every canonical generation filename (`session.jsonl[.zstd]`,
  // `session.vN.jsonl[.zstd]`) and require one to exist before shelling out.
  let artifactNames = []
  try {
    artifactNames = await readdir(dir)
  } catch (error) {
    artifactNames = []
  }
  if (!artifactNames.some((name) => GENERATION_FILE_RE.test(name))) {
    throw new Error('日志文件路径校验失败，已取消删除：' + sessionId)
  }
  // Platform-appropriate removal command (Windows PowerShell / POSIX rm).
  let command
  if (process.platform === 'win32') {
    command = "Remove-Item -LiteralPath '" + dir.replace(/'/g, "''") + "' -Recurse -Force"
  } else {
    command = "rm -rf -- '" + dir.replace(/'/g, "'\\''") + "'"
  }
  let spec
  try {
    spec = shell.resolve({ command, sandboxPolicy: { mode: 'danger-full-access' } })
  } catch (error) {
    throw new Error('无法发起文件删除命令：' + String((error && error.message) || error))
  }
  try {
    // `shell.execute(spec)` is the ONLY name this seam has had across
    // 0.1.5-rc.2 → 0.1.7-rc.1: verified against the packed 0.1.7-alpha.2 and the
    // installed 0.1.7-rc.1 trees, the abstract ShellExecutor and all four
    // executors expose `execute` and never `run`. There is also no `foreground`
    // flag on ShellExecSpec — "foreground" means AWAITING the returned
    // ShellExecution's `result()` METHOD, which resolves (rather than rejects)
    // on timeout/abort with exitCode null. The `run` branch below is therefore
    // unreachable defensive code kept as cheap insurance, not a version split.
    let result
    if (typeof shell.execute === 'function') {
      const execution = await shell.execute(spec)
      result = await execution.result()
    } else if (typeof shell.run === 'function') {
      result = await shell.run(spec)
    } else {
      throw new Error('当前 dsh 版本的 shell 服务既没有 execute() 也没有 run()')
    }
    if (result && result.exitCode !== 0 && result.exitCode !== null) {
      throw new Error('删除日志文件失败（退出码 ' + result.exitCode + '）')
    }
    // A timed-out or aborted run RESOLVES with exitCode null (only infrastructure
    // failures reject), so the check above cannot see it — report it instead of
    // treating a delete that never ran as successful.
    if (result && (result.timedOut === true || result.aborted === true)) {
      throw new Error(
        '删除日志文件超时或被中断（timedOut=' + String(result.timedOut) +
        '，aborted=' + String(result.aborted) + '）'
      )
    }
  } catch (error) {
    throw new Error('删除日志文件失败：' + String((error && error.message) || error))
  }
  return dir
}

// Session metadata listing with a resilience fallback: list() first
// (cheap headers + revision tokens); only a THROW falls back to the
// session-query corpus. The fallback has no durable revision token, so it
// mints a unique revision per listing (see the fallbackEpoch note) — the count
// cache must never treat a fallback listing as "already counted". An empty
// listing is a valid result (fresh corpus, or archived ids whose logs are
// all gone) — treating it as failure would turn a zombie-only archive into
// a hard page error instead of "数据缺失" rows.
async function loadSnapshots(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence) {
    try {
      // 0.1.5-rc.2 exposes list() (snapshots {header, revision}); listSnapshots()
      // existed only on <=0.1.2-rc.1. Try the current seam first so the revision
      // token is durable and the per-session count cache can actually hit.
      const snapshots = typeof persistence.list === 'function'
        ? await persistence.list()
        : await persistence.listSnapshots()
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
        })),
        ok: true,
      }
    } catch {
      /* fall through */
    }
  }
  return { snapshots: [], ok: false }
}

function buildById(snapshots) {
  const bySnap = new Map()
  for (const snap of snapshots) bySnap.set(snap.header.id, snap)
  return bySnap
}

// Message count for one session from its raw log. `readSession` costs one
// corpus observation — the same as listEvents — and additionally returns the
// exact fork-inherited cut: the snapshot `header` carries only `isSeeded`,
// never the cut length, so the inherited prefix can only be excluded via
// `inheritedEventCount` (seqs below it belong to the fork parent).
async function computeCount(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  // Never null/undefined per the SessionQueryEngine contract (a failure
  // throws and is swallowed by the counting job's catch).
  const inspection = await query.readSession(sessionId)
  const cut = inspection.inheritedEventCount
  let count = 0
  for (const event of inspection.events) {
    if (event.seq >= cut && (event.type === 'user/message' || event.type === 'assistant/message')) {
      count += 1
    }
  }
  return count
}

function countPending(sessionId) {
  return countInflight.has(sessionId) || countQueue.some((job) => job.sessionId === sessionId)
}

// Enqueue exactly one counting job per session per revision: skip when the
// cache already matches, when a job is in flight, or when one is queued.
// enqueueCount/pumpCounts are fully synchronous up to the job's first await,
// so two concurrent list() calls cannot push duplicate jobs for one session.
function enqueueCount(ctx, sessionId, revision) {
  if (!ctx.get('sessionQuery') || countInflight.has(sessionId)) return
  const cached = countCache.get(sessionId)
  if (cached && cached.revision === revision) return
  if (countQueue.some((job) => job.sessionId === sessionId)) return
  countQueue.push({ sessionId, revision })
  pumpCounts(ctx)
}

function pumpCounts(ctx) {
  while (countRunning < CONCURRENCY && countQueue.length > 0) {
    const job = countQueue.shift()
    countRunning += 1
    countInflight.add(job.sessionId)
    ;(async () => {
      try {
        const messageCount = await computeCount(ctx, job.sessionId)
        countCache.set(job.sessionId, { revision: job.revision, messageCount })
      } catch {
        /* leave uncached; the next poll retries */
      } finally {
        countRunning -= 1
        countInflight.delete(job.sessionId)
        pumpCounts(ctx)
      }
    })()
  }
}

// Remove one id from the archive set. The state object is mutated in place
// so the registry's cached copy stays coherent; a failed durable write
// rolls the in-memory mutation back.
async function unarchive(ctx, sessionId) {
  const storageDomain = ctx.get('storageDomain')
  const domain = storageDomain ? storageDomain.get('workspace') : undefined
  if (!domain) throw new Error('workspace 存储域不可用')
  const state = domain.global.get()
  const archived = state && Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : []
  if (!archived.includes(sessionId)) return
  const original = state.archivedSessionIds
  state.archivedSessionIds = archived.filter((id) => id !== sessionId)
  try {
    await domain.global.set(state)
  } catch (error) {
    state.archivedSessionIds = original
    throw error
  }
}

// --- Pending-delete queue ----------------------------------------------------
//
// A session that is still live in the in-memory store cannot be deleted
// reliably: its persistence write chain re-creates the log on the next append,
// and on Windows the artifact the host holds open refuses removal outright. The
// policy (confirmed with the plugin owner) is therefore:
//   1. ask the OFFICIAL archive seam to stop the session's running work;
//   2. try the delete immediately;
//   3. when the log survives, record the intent here so it completes as soon as
//      the session leaves memory — at the latest on the next Host boot, where
//      nothing is live.
//
// Storage: a plugin-owned JSON file under $DSH_HOME. The storage-domain seam
// requires a zod schema (spec.d.ts: DomainGlobalSpec.schema is a ZodType) and
// this plugin ships zero dependencies; zod is not resolvable from the plugin's
// real path under pnpm's isolated layout, so a small atomically-replaced file is
// the honest choice. Nothing else is ever written there.
const PENDING_FILE = 'archived-sessions-pending-delete.json'
// How long a purged id stays remembered for resurrection detection, and how many
// ids that memory keeps (newest win).
const RECENT_TTL_MS = 24 * 60 * 60 * 1000
const RECENT_MAX = 200

function isSessionId(value) {
  return typeof value === 'string' && value !== ''
}

function pendingFilePath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(os.homedir(), '.dsh')
  return join(home, PENDING_FILE)
}

async function readPendingState() {
  try {
    const parsed = JSON.parse(await readFile(pendingFilePath(), 'utf8'))
    return {
      sessionIds: Array.isArray(parsed && parsed.sessionIds)
        ? parsed.sessionIds.filter(isSessionId)
        : [],
      recentlyDeleted: Array.isArray(parsed && parsed.recentlyDeleted)
        ? parsed.recentlyDeleted.filter((entry) => entry && isSessionId(entry.id) && typeof entry.at === 'number')
        : [],
    }
  } catch {
    // Absent or unreadable: an empty state is the safe default.
    return { sessionIds: [], recentlyDeleted: [] }
  }
}

async function writePendingState(state) {
  const file = pendingFilePath()
  const tmp = file + '.tmp'
  await mkdir(dirname(file), { recursive: true })
  await writeFile(tmp, JSON.stringify({
    sessionIds: state.sessionIds,
    recentlyDeleted: state.recentlyDeleted,
    updatedAt: Date.now(),
  }, null, 2), 'utf8')
  await rename(tmp, file) // atomic replace: a crash never truncates the queue
}

async function readPendingIds() {
  return (await readPendingState()).sessionIds
}

async function enqueuePending(ids) {
  const wanted = (Array.isArray(ids) ? ids : [ids]).filter(isSessionId)
  if (wanted.length === 0) return []
  const state = await readPendingState()
  const merged = state.sessionIds.slice()
  for (const id of wanted) if (!merged.includes(id)) merged.push(id)
  if (merged.length !== state.sessionIds.length) {
    await writePendingState({ sessionIds: merged, recentlyDeleted: state.recentlyDeleted })
  }
  return merged
}

async function dequeuePending(ids) {
  const done = new Set((Array.isArray(ids) ? ids : [ids]).filter(isSessionId))
  if (done.size === 0) return []
  const state = await readPendingState()
  const kept = state.sessionIds.filter((id) => !done.has(id))
  if (kept.length !== state.sessionIds.length) {
    await writePendingState({ sessionIds: kept, recentlyDeleted: state.recentlyDeleted })
  }
  return kept
}

// Remember what was purged. A session that resumes in the same breath as its
// deletion can re-create the very log we removed; because its workspace
// accounting is already gone, that log shows up in the sidebar as an ungrouped,
// data-missing row. Recording the ids lets the drain notice the resurrection and
// re-queue it (the drain still waits for the session to leave memory, so this
// cannot loop against a live writer).
async function markRecentlyDeleted(ids) {
  const wanted = (Array.isArray(ids) ? ids : [ids]).filter(isSessionId)
  if (wanted.length === 0) return
  const state = await readPendingState()
  const now = Date.now()
  const cutoff = now - RECENT_TTL_MS
  const kept = state.recentlyDeleted.filter((entry) => entry.at >= cutoff)
  for (const id of wanted) if (!kept.some((entry) => entry.id === id)) kept.push({ id, at: now })
  await writePendingState({ sessionIds: state.sessionIds, recentlyDeleted: kept.slice(-RECENT_MAX) })
}

// Ask the OFFICIAL archive seam to stop a session's running work (its turn,
// subagent descendants, owned background jobs, active schedules) instead of the
// seam refusing the archive as `workspace/session-active`. The seam requests the
// stops without awaiting them. A failure is RETURNED (not thrown): the delete
// that follows may fail for a reason the user needs to see, and a version
// without the seam must still report why the stop could not be requested.
async function requestStopActivity(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry || typeof registry.archiveSession !== 'function') {
    return '当前 dsh 版本没有 archiveSession(stopActivity) 接缝，无法请求停止其运行中的工作'
  }
  try {
    await registry.archiveSession(sessionId, { stopActivity: true })
    return null
  } catch (error) {
    return String((error && error.message) || error)
  }
}

// Split one session's descendant tree by product classification. Live branches
// are reported separately: they are skipped in every mode (their log would be
// re-created, or is locked while the host holds it).
function splitDescendants(snapshots, rootId, isLive) {
  const tree = subtreeOf(snapshots, rootId, isLive)
  const internal = []
  const forks = []
  for (const snap of tree.deletable) {
    if (classifyChild(snap.header) === 'fork') forks.push(snap)
    else internal.push(snap)
  }
  return { internal, forks, live: tree.blocked }
}

// Remove the log directories of the given snapshots (leaf-first order is the
// caller's job) and verify with a fresh listing that every one is really gone.
// Throws before any durable record is touched, so a session can never resurface
// as an ungrouped phantom.
async function purgeLogs(ctx, snaps) {
  const persistence = ctx.get('sessionPersistence')
  const shell = ctx.get('shell')
  for (const snap of snaps) await removeLogDirectory(persistence, shell, snap)
  if (snaps.length === 0) return []
  const after = await loadSnapshots(ctx)
  if (!after.ok) throw new Error('无法确认日志文件是否已删除，已中止删除')
  const ids = snaps.map((snap) => snap.header.id)
  const survivors = ids.filter((id) => after.snapshots.some((entry) => entry.header.id === id))
  if (survivors.length > 0) {
    throw new Error('日志文件删除后仍存在，已中止：' + survivors.join('、'))
  }
  return ids
}

// Drop workspace accounting and the archive-set entry for ids whose logs are
// already gone, then clear their cached counts.
async function purgeRecords(ctx, ids) {
  const registry = ctx.get('workspaceRegistry')
  for (const id of ids) {
    const owner = registry.list().find((workspace) =>
      Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(id))
    if (!owner) continue
    await owner.detachSession(id)
  }
  for (const id of ids) await unarchive(ctx, id)
  for (const id of ids) {
    countCache.delete(id)
    countInflight.delete(id)
  }
}

// Try to finish queued deletions. Safe to call at any time: every entry is
// re-validated (the session must have left the in-memory store) before anything
// is removed, so a session the user resumed is simply left queued. Never throws;
// one drain runs at a time.
let drainRunning = false
async function drainPending(ctx) {
  if (drainRunning) return { drained: [], remaining: [] }
  drainRunning = true
  try {
    const state = await readPendingState()
    const loaded = await loadSnapshots(ctx)
    const bySnap = buildById(loaded.ok ? loaded.snapshots : [])
    // Self-heal: a log we already purged — and whose workspace accounting we
    // already removed — that exists AGAIN means its session wrote after the
    // removal. Re-queue it instead of leaving it as an ungrouped, data-missing
    // row. The drain still waits for the session to leave memory, so this can
    // never fight a live writer.
    const resurrected = state.recentlyDeleted
      .map((entry) => entry.id)
      .filter((id) => bySnap.has(id) && !state.sessionIds.includes(id))
    const ids = resurrected.length > 0 ? await enqueuePending(resurrected) : state.sessionIds
    if (ids.length === 0) return { drained: [], remaining: [] }
    const sessions = ctx.get('sessions')
    const drained = []
    const remaining = []
    for (const id of ids) {
      if (sessions && sessions.get(id) !== undefined) {
        remaining.push(id)
        continue
      }
      try {
        const snap = bySnap.get(id)
        if (snap) await purgeLogs(ctx, [snap])
        await purgeRecords(ctx, [id])
        await markRecentlyDeleted([id])
        drained.push(id)
      } catch {
        remaining.push(id) // still locked or re-listed: retry on the next sweep
      }
    }
    if (drained.length > 0) await dequeuePending(drained)
    return { drained, remaining }
  } catch {
    return { drained: [], remaining: [] }
  } finally {
    drainRunning = false
  }
}

/** Children removed for one cascade mode, per the shared policy function. */
function cascadeChildrenOf(split, mode) {
  return split.internal
    .concat(split.forks)
    .filter((snap) => shouldDeleteChild(classifyChild(snap.header), mode))
}

class ArchivedSessionsService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'archivedSessions')
    this.ctx = ctx
  }

  /** One settings-page load: archive ids + cheap metadata, no log parsing. */
  async list() {
    const ctx = this.ctx
    // Opportunistic sweep: a queued deletion may have become possible since the
    // last poll (its session left the in-memory store). Fire-and-forget — the
    // listing must never wait on queue I/O.
    drainPending(ctx).catch(() => {})
    const registry = ctx.get('workspaceRegistry')
    const sessions = ctx.get('sessions')
    if (!registry) return { items: [], error: 'workspace 服务不可用' }
    const ids = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds.slice() : []
    const pendingIds = await readPendingIds()
    if (ids.length === 0) return { items: [], pendingIds }

    const { snapshots, ok } = await loadSnapshots(ctx)
    if (!ok) return { items: [], error: '无法读取会话列表' }
    const bySnap = buildById(snapshots)

    const wsBySession = new Map()
    for (const workspace of registry.list()) {
      const members = workspace.sessionIds
      if (!Array.isArray(members)) continue
      for (const sessionId of members) {
        if (!wsBySession.has(sessionId)) {
          wsBySession.set(sessionId, { id: workspace.id, title: workspace.title })
        }
      }
    }

    const items = ids.map((sessionId) => {
      const snap = bySnap.get(sessionId)
      const workspace = wsBySession.get(sessionId) || null
      const live = sessions ? sessions.get(sessionId) !== undefined : false
      if (!snap) {
        return { sessionId, missing: true, live, workspace, messageCount: null, statsPending: false }
      }
      const cached = countCache.get(sessionId)
      let messageCount = null
      let statsPending = false
      if (cached && cached.revision === snap.revision) {
        messageCount = cached.messageCount
      } else {
        enqueueCount(ctx, sessionId, snap.revision)
        statsPending = countPending(sessionId)
      }
      return { sessionId, missing: false, live, workspace, messageCount, statsPending }
    })
    return { items, pendingIds }
  }

  /** Read-only preview of the first few conversation messages. */
  async preview(sessionId) {
    const ctx = this.ctx
    const query = ctx.get('sessionQuery')
    if (!query || typeof sessionId !== 'string') return { messages: [] }
    let surface
    try {
      surface = await query.readSurface(sessionId)
    } catch (error) {
      return { error: '读取会话内容失败：' + String((error && error.message) || error) }
    }
    const messages = []
    const events = surface && Array.isArray(surface.events) ? surface.events : []
    for (const event of events) {
      if (messages.length >= ARCHIVED_LIMIT) break
      if (event.type === 'user/message') {
        messages.push({ role: 'user', text: textOf(event.data && event.data.content), tools: [] })
      } else if (event.type === 'assistant/message') {
        const message = event.data && event.data.message
        messages.push({
          role: 'assistant',
          text: textOf(message && message.content),
          tools: toolNamesOf(message && message.content),
        })
      }
    }
    return { messages }
  }

  /** Remove one id from the archive set; the session returns to its workspace slot. */
  async restore(sessionId) {
    const ctx = this.ctx
    const registry = ctx.get('workspaceRegistry')
    if (!registry || typeof sessionId !== 'string') throw new Error('workspace 服务不可用')
    const storageDomain = ctx.get('storageDomain')
    const domain = storageDomain ? storageDomain.get('workspace') : undefined
    if (!domain) throw new Error('workspace 服务不可用')
    const state = domain.global.get()
    const archived = state && Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : []
    if (!archived.includes(sessionId)) return { ok: true, already: true, workspaceTitle: null }
    await unarchive(ctx, sessionId)
    let workspaceTitle = null
    for (const workspace of registry.list()) {
      if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
        workspaceTitle = workspace.title
        break
      }
    }
    return { ok: true, already: false, workspaceTitle }
  }

  /**
   * Permanently delete an archived session: log directory + workspace
   * accounting + archive entry. Live (in-memory) sessions are refused
   * because their write chain would re-create the log and resurrect the
   * session; the client explains that the user should restart DSH first.
   *
   * The confirmation gate accepts any of: the durable title, the cwd
   * basename, the session id, or the exact string the UI displayed
   * (`displayedTitle`) — see the candidate block below.
   *
   * A session with child sessions is not refused: without `allowChildren` the
   * call returns `{ needsChildrenAck, childCount, childIds }` so the UI can
   * warn and confirm; with it the parent is deleted and the children stay
   * (unparented).
   *
   * NOTE: the wire name must not collide with the client-side
   * RemoteNamespaceService's own methods (e.g. `remove` is taken).
   */
  async deleteSession(sessionId, titleConfirm, displayedTitle, allowChildren, cascadeChildren) {
    const ctx = this.ctx
    const registry = ctx.get('workspaceRegistry')
    const query = ctx.get('sessionQuery')
    const sessions = ctx.get('sessions')
    const persistence = ctx.get('sessionPersistence')
    const shell = ctx.get('shell')
    const storageDomain = ctx.get('storageDomain')
    const domain = storageDomain ? storageDomain.get('workspace') : undefined
    if (!registry || !query || !domain || typeof sessionId !== 'string') {
      throw new Error('workspace 服务不可用')
    }
    if (typeof titleConfirm !== 'string') titleConfirm = ''
    if (typeof displayedTitle !== 'string') displayedTitle = ''

    const state = domain.global.get()
    const archived = state && Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : []
    if (!archived.includes(sessionId)) throw new Error('该会话不在归档列表中')

    // A session that is still live in the in-memory store is NO LONGER refused.
    // A freshly archived session always is (archiving hides it, it does not stop
    // it), which used to make the most obvious delete impossible until a restart.
    // Ask the official seam to stop its running work, then try the delete; a log
    // that survives goes to the pending queue and completes as soon as the
    // session leaves memory (see the queue helpers above).
    const session = sessions ? sessions.get(sessionId) : undefined
    const wasLive = session !== undefined
    const stopError = wasLive ? await requestStopActivity(ctx, sessionId) : null

    const { snapshots, ok } = await loadSnapshots(ctx)
    if (!ok) throw new Error('无法读取会话列表，已取消删除')
    const bySnap = buildById(snapshots)
    const isLiveDescendant = (id) => (sessions ? sessions.get(id) !== undefined : false)
    const tree = subtreeOf(snapshots, sessionId, isLiveDescendant)
    const descendantIds = tree.deletable.map((entry) => entry.header.id).concat(tree.blocked)
    if (descendantIds.length > 0 && allowChildren !== true && cascadeChildren !== true) {
      /* v1.3.4/v1.3.5: do NOT refuse outright. A child session lives in its own
         artifact — a spawn child (isSeeded=false) has no inherited prefix at
         all, and a seeded fork carries its own copy of the inherited events —
         so deleting the parent leaves every child readable; it only removes the
         parent link. A hard refusal is a dead end here: this page can only see
         ARCHIVED sessions, while children are normally unarchived and DSH has
         no session-deletion path of its own. Return the facts instead and let
         the UI offer "parent only" or "parent + subtree". */
      return {
        ok: true,
        needsChildrenAck: true,
        childCount: descendantIds.length,
        deletableCount: tree.deletable.length,
        liveCount: tree.blocked.length,
        childIds: descendantIds.slice(0, 20),
      }
    }

    const snap = bySnap.get(sessionId)

    // Confirmation candidates. The durable title is read through the host's
    // live-preferred cold read, which loads and validates the stored artifact;
    // a legacy artifact this build refuses to migrate makes that read reject
    // (SessionFormatUnsupportedError). The title is only a confirmation
    // affordance, so an unreadable one MUST degrade to the remaining
    // candidates: hard-failing here is a dead end, because retrying can never
    // succeed. `displayedTitle` is the exact string the UI showed, so
    // "copy the title" always matches.
    let durableTitle = ''
    if (snap) {
      try {
        durableTitle = await readDurableTitle(ctx, sessionId)
      } catch (error) {
        durableTitle = ''
      }
    }
    const candidates = []
    const addCandidate = (value) => {
      if (typeof value !== 'string') return
      const trimmed = value.trim()
      if (trimmed !== '' && !candidates.includes(trimmed)) candidates.push(trimmed)
    }
    if (snap) {
      addCandidate(durableTitle)
      addCandidate(workspaceTitleOf(snap.header.cwd))
      addCandidate(sessionId)
    } else {
      addCandidate('数据缺失的会话')
    }
    addCandidate(displayedTitle)
    if (!candidates.includes(titleConfirm.trim())) {
      /* v1.2.1/v1.3.3: return every accepted value so the UI can show exactly
         what to type instead of a dead-end mismatch. */
      throw new Error('输入的标题与「' + candidates[0] + '」不一致，已取消删除。可输入：' + candidates.join(' 或 '))
    }

    // A session that is still live is NEVER deleted in place. Removing its log
    // only deletes a file its write chain re-creates moments later — after the
    // workspace accounting is already gone — which is exactly how a purged
    // session came back as an ungrouped, data-missing sidebar row. The stop
    // request above helps it leave memory sooner; the log goes once it has.
    if (wasLive) {
      const pendingIds = await enqueuePending([sessionId])
      return {
        ok: true,
        pending: true,
        pendingIds,
        reason: '该会话仍在内存中（已请求停止其运行中工作）。为避免日志被写回后变成无归属的孤儿，已加入待删除队列。',
        stopError,
        deletedChildren: [],
        skippedChildren: tree.blocked,
      }
    }

    // Cold session: the original contract — every failure throws before durable
    // records are touched, so a session can never resurface as a phantom.
    const ordered = (cascadeChildren === true ? tree.deletable.slice().reverse() : [])
      .concat(snap ? [snap] : [])
    const deletedLogIds = await purgeLogs(ctx, ordered)
    const deletedChildren = deletedLogIds.filter((id) => id !== sessionId)
    const accountingIds = [sessionId].concat(deletedChildren)
    await purgeRecords(ctx, accountingIds)
    await markRecentlyDeleted(accountingIds)
    await dequeuePending(accountingIds)
    return { ok: true, deletedChildren, skippedChildren: tree.blocked }
  }

  /**
   * Read-only orphan scan. A candidate is a session whose log EXISTS but that
   *   - no workspace accounts for (the sidebar shows it as ungrouped), and
   *   - is absent from the archive set (so this page cannot show it).
   * That is exactly the state a log rebuilt after a delete produces. The scan
   * never removes anything: it reports the evidence per candidate (whether the
   * log is READABLE, how many events it holds, whether it is live) so the user
   * decides. A normal ungrouped session stays readable and is therefore
   * identifiable at a glance.
   */
  async scanOrphans() {
    const ctx = this.ctx
    const registry = ctx.get('workspaceRegistry')
    const sessions = ctx.get('sessions')
    const query = ctx.get('sessionQuery')
    if (!registry) return { ok: false, items: [], error: 'workspace 服务不可用' }
    const { snapshots, ok } = await loadSnapshots(ctx)
    if (!ok) return { ok: false, items: [], error: '无法读取会话列表' }
    const archived = new Set(Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : [])
    const accounted = new Set()
    for (const workspace of registry.list()) {
      if (!Array.isArray(workspace.sessionIds)) continue
      for (const id of workspace.sessionIds) accounted.add(id)
    }
    const items = []
    for (const snap of snapshots) {
      const sessionId = snap.header.id
      if (archived.has(sessionId) || accounted.has(sessionId)) continue
      let readable = false
      let eventCount = null
      if (query) {
        try {
          const inspection = await query.readSession(sessionId)
          readable = true
          eventCount = Array.isArray(inspection.events) ? inspection.events.length : null
        } catch {
          readable = false // the file is there but cannot be read/validated
        }
      }
      items.push({
        sessionId,
        createdAt: typeof snap.header.createdAt === 'number' ? snap.header.createdAt : null,
        cwd: typeof snap.header.cwd === 'string' ? snap.header.cwd : null,
        live: sessions ? sessions.get(sessionId) !== undefined : false,
        readable,
        eventCount,
      })
      if (items.length >= 200) break // bounded: the page must stay responsive
    }
    return { ok: true, items, confirmWord: BULK_CONFIRM_WORD, scanned: snapshots.length }
  }

  /**
   * Remove the selected orphans. Same delete policy as everywhere else in this
   * plugin: a live session is QUEUED (its log is never deleted in place), a cold
   * one is purged now and its id remembered so a rebuilt log gets swept again.
   */
  async purgeOrphans(sessionIds, confirmWord) {
    const ctx = this.ctx
    if (!Array.isArray(sessionIds)) throw new Error('参数无效')
    if (!confirmWordMatches(confirmWord)) {
      throw new Error('请输入「' + BULK_CONFIRM_WORD + '」以确认清理')
    }
    const sessions = ctx.get('sessions')
    const { snapshots, ok } = await loadSnapshots(ctx)
    if (!ok) throw new Error('无法读取会话列表，已取消清理')
    const bySnap = buildById(snapshots)
    const results = []
    for (const sessionId of sessionIds) {
      if (typeof sessionId !== 'string' || sessionId === '') continue
      const snap = bySnap.get(sessionId)
      if (snap === undefined) {
        results.push({ sessionId, status: 'skipped', reason: '日志已不存在', deletedChildren: [], skippedChildren: [] })
        continue
      }
      if (sessions && sessions.get(sessionId) !== undefined) {
        await enqueuePending([sessionId])
        results.push({ sessionId, status: 'pending', reason: '该会话仍在内存中，已加入待删除队列', deletedChildren: [], skippedChildren: [] })
        continue
      }
      try {
        await purgeLogs(ctx, [snap])
        await purgeRecords(ctx, [sessionId])
        await markRecentlyDeleted([sessionId])
        await dequeuePending([sessionId])
        results.push({ sessionId, status: 'deleted', deletedChildren: [], skippedChildren: [] })
      } catch (error) {
        results.push({
          sessionId,
          status: 'failed',
          reason: String((error && error.message) || error),
          deletedChildren: [],
          skippedChildren: [],
        })
      }
    }
    return { ok: true, results, summary: summarizeResults(results), pendingIds: await readPendingIds() }
  }

  /**
   * Bulk-delete planning for the confirmation dialog: per selected session it
   * reports the title, whether it is live, and how its descendants split into
   * internal children (subagent-created: removed by the default cascade), forked
   * children (the user's own: kept unless the full cascade is chosen) and live
   * branches (always skipped). Read-only.
   */
  async planDelete(sessionIds) {
    const ctx = this.ctx
    const registry = ctx.get('workspaceRegistry')
    const sessions = ctx.get('sessions')
    if (!registry || !Array.isArray(sessionIds)) return { ok: false, items: [], error: 'workspace 服务不可用' }
    const { snapshots, ok } = await loadSnapshots(ctx)
    if (!ok) return { ok: false, items: [], error: '无法读取会话列表' }
    const bySnap = buildById(snapshots)
    const isLive = (id) => (sessions ? sessions.get(id) !== undefined : false)
    const items = []
    for (const sessionId of sessionIds) {
      if (typeof sessionId !== 'string' || sessionId === '') continue
      const snap = bySnap.get(sessionId)
      const split = splitDescendants(snapshots, sessionId, isLive)
      let title = sessionId
      if (snap) {
        // Same candidate chain the single-delete confirmation uses; an
        // unreadable durable title must degrade, never fail the dialog.
        try {
          title = (await readDurableTitle(ctx, sessionId)) || workspaceTitleOf(snap.header.cwd) || sessionId
        } catch {
          title = workspaceTitleOf(snap.header.cwd) || sessionId
        }
      }
      items.push({
        sessionId,
        title,
        live: isLive(sessionId),
        missing: snap === undefined,
        internalCount: split.internal.length,
        forkCount: split.forks.length,
        liveChildCount: split.live.length,
      })
    }
    return { ok: true, items, confirmWord: BULK_CONFIRM_WORD, defaultMode: DEFAULT_CASCADE_MODE }
  }

  /**
   * Bulk delete. The typed confirm word is enforced HERE (not only in the UI):
   * the client cannot bypass it by calling the Remote method directly.
   * `cascadeMode` is 'keep' | 'classified' (default) | 'all'.
   * Every session gets its own result row; one failure never aborts the batch.
   */
  async deleteSessions(sessionIds, cascadeMode, confirmWord) {
    const ctx = this.ctx
    const registry = ctx.get('workspaceRegistry')
    const sessions = ctx.get('sessions')
    if (!registry || !Array.isArray(sessionIds)) throw new Error('workspace 服务不可用')
    if (!confirmWordMatches(confirmWord)) {
      throw new Error('请输入「' + BULK_CONFIRM_WORD + '」以确认批量删除')
    }
    const mode = normalizeCascadeMode(cascadeMode)
    // This page owns the ARCHIVE set: an id that has left it (restored, or deleted
    // from another surface) is skipped rather than deleted behind the user's back —
    // the single-delete path enforces the same contract.
    const archivedSet = new Set(Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : [])
    const { snapshots, ok } = await loadSnapshots(ctx)
    if (!ok) throw new Error('无法读取会话列表，已取消删除')
    const bySnap = buildById(snapshots)
    const isLive = (id) => (sessions ? sessions.get(id) !== undefined : false)
    const results = []
    for (const sessionId of sessionIds) {
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (!archivedSet.has(sessionId)) {
        results.push({
          sessionId,
          status: 'skipped',
          reason: '该会话已不在归档列表中（可能已被恢复或删除）',
          deletedChildren: [],
          skippedChildren: [],
        })
        continue
      }
      const snap = bySnap.get(sessionId)
      const wasLive = isLive(sessionId)
      const stopError = wasLive ? await requestStopActivity(ctx, sessionId) : null
      const split = splitDescendants(snapshots, sessionId, isLive)
      const childSnaps = cascadeChildrenOf(split, mode)
      // Live sessions are queued, never deleted in place (see deleteSession).
      if (wasLive) {
        await enqueuePending([sessionId])
        results.push({
          sessionId,
          status: 'pending',
          reason: '该会话仍在内存中（已请求停止其运行中工作）。为避免日志被写回后变成无归属的孤儿，已加入待删除队列。',
          stopError,
          deletedChildren: [],
          skippedChildren: split.live,
        })
        continue
      }
      try {
        const ordered = childSnaps.slice().reverse().concat(snap ? [snap] : [])
        const deletedLogIds = await purgeLogs(ctx, ordered)
        const deletedChildren = deletedLogIds.filter((id) => id !== sessionId)
        const accountingIds = [sessionId].concat(deletedChildren)
        await purgeRecords(ctx, accountingIds)
        await markRecentlyDeleted(accountingIds)
        await dequeuePending(accountingIds)
        results.push({ sessionId, status: 'deleted', deletedChildren, skippedChildren: split.live, stopError })
      } catch (error) {
        results.push({
          sessionId,
          status: 'failed',
          reason: String((error && error.message) || error),
          deletedChildren: [],
          skippedChildren: split.live,
        })
      }
    }
    return { ok: true, mode, results, summary: summarizeResults(results), pendingIds: await readPendingIds() }
  }
}

// --- Manual Remote markers (decorator-syntax-free) ---
const proto = ArchivedSessionsService.prototype
function markRemote(method) {
  const context = {
    private: false,
    static: false,
    name: method,
    addInitializer(cb) { this.cb = cb }
  }
  // Equivalent to `@Remote(method)` on the class method.
  Remote(method)(undefined, context)
  context.cb.call(Object.create(proto))
}
markRemote('list')
markRemote('preview')
markRemote('restore')
markRemote('deleteSession')
markRemote('planDelete')
markRemote('deleteSessions')
markRemote('scanOrphans')
markRemote('purgeOrphans')

export function apply(ctx) {
  // TypertRemoteService registers `archivedSessions` in ctx.reflect.props and
  // sets `service.typertRemote`; the Gateway's source-mode discovery consumes
  // both.
  new ArchivedSessionsService(ctx)
  // Boot sweep: nothing is live in a freshly booted host, so every queued
  // deletion from a previous run can complete now. Delayed past service startup
  // and unref'd so it can never hold the process open.
  const timer = setTimeout(() => { drainPending(ctx).catch(() => {}) }, 1500)
  if (timer && typeof timer.unref === 'function') timer.unref()
}
