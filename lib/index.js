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
// Why the code looks like this (seam facts, not history):
//   - The archive set lives in the workspace storage domain ("workspace",
//     version 2) global singleton field `archivedSessionIds`, in archive
//     order. Archiving never touches workspace accounting, so restoring a
//     session brings it back to its original workspace slot.
//   - The workspace registry reads that same state object back from the domain
//     on every call, so this plugin's own archive writes mutate it IN PLACE and
//     roll the mutation back when the durable write fails.
//   - `archiveSession(id, { stopActivity: true })` resolves without writing,
//     asking or stopping when the id is ALREADY archived. Every session this
//     plugin deletes is archived, so a stop request must first run
//     `unarchiveSession(id)` and then re-archive with the option — otherwise the
//     call never reaches the `workspace/session-stop` dispatch. See
//     requestStopActivity.
//   - Session logs are per-session JSONL files; deleting a session that is live
//     in the in-memory store is unstable (its write chain re-creates the log),
//     so a live session is queued instead of deleted in place.
//   - `SessionPersistence.list()` observes the medium but omits what it cannot
//     interpret; `stat()` and the on-disk artifact are what distinguish "gone"
//     from "present but unreadable". See lib/logs.js (probeLogState): the
//     cleanup paths must never turn the latter into a record-only purge.
//   - The seam has no deletion API, so deletion re-derives the session directory
//     from `resolveCurrentLog(id)` / the root scan and then verifies the
//     literal-id directory plus a canonical generation filename before shelling
//     out. encodeSegment() is the identity for every DSH-minted id, which is why
//     the directory name must equal the id. See lib/logs.js (resolveSessionDir)
//     and removeLogDirectory below.

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  BULK_CONFIRM_WORD,
  DEFAULT_CASCADE_MODE,
  ORPHAN_KINDS,
  classifyChild,
  classifyOrphan,
  comparableWorkspacePaths,
  confirmWordMatches,
  normalizeCascadeMode,
  shouldDeleteChild,
  summarizeResults,
} from './plan.js'
import {
  buildById,
  isGenerationFile,
  loadSnapshots,
  probeLogState,
  resolveSessionDir,
  subtreeOf,
  workspaceTitleOf,
} from './logs.js'

const ARCHIVED_LIMIT = 6
const MAX_TEXT = 240
const CONCURRENCY = 2
// Display label for an archived id with no log behind it. The Host owns this
// string: `list()` reports it as `staleLabel` and the delete gate accepts it, so
// the client renders the Host's wording instead of keeping a second copy in
// sync. `displayedTitle` still covers any client that shows different text.
const STALE_ROW_LABEL = '日志已不存在（归档记录失效）'

// Per-session message-count cache keyed by the log revision token. It is an LRU
// bounded by COUNT_CACHE_MAX: a long-lived host that archives many sessions must
// not grow the map forever (restore() and purgeRecords() also drop entries).
const COUNT_CACHE_MAX = 500
const countCache = new Map()
const countQueue = []
const countInflight = new Set()
let countRunning = 0

function rememberCount(sessionId, entry) {
  countCache.delete(sessionId)
  countCache.set(sessionId, entry)
  while (countCache.size > COUNT_CACHE_MAX) {
    const oldest = countCache.keys().next().value
    if (oldest === undefined) break
    countCache.delete(oldest)
  }
}

function cachedCount(sessionId) {
  const entry = countCache.get(sessionId)
  if (entry === undefined) return undefined
  // Refresh recency so the LRU evicts the least recently LISTED session, not
  // merely the least recently counted one.
  countCache.delete(sessionId)
  countCache.set(sessionId, entry)
  return entry
}

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

async function readDurableTitle(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (!query) return ''
  const obs = await query.readTitleSnapshot(sessionId)
  const title = obs && obs.title && typeof obs.title.title === 'string' ? obs.title.title : ''
  return title.trim()
}

// Delete one session's own log directory after re-verifying the derived path.
// Shared by the target session and, in cascade mode, every descendant. Durable
// records are the caller's job; verification is a single pass at the end.
async function removeLogDirectory(persistence, shell, snap) {
  const sessionId = snap.header.id
  if (!shell) throw new Error('文件删除服务不可用，已取消删除')
  if (!persistence) throw new Error('会话存储服务不可用，已取消删除')
  const dir = await resolveSessionDir(persistence, sessionId)
  if (dir === null || dir === '') throw new Error('无法定位会话日志文件，已取消删除：' + sessionId)
  // `basename(dir) === sessionId` holds because encodeSegment is the identity for
  // every DSH-minted id; an id containing `~` or another unsafe unit would appear
  // as ~XXXX here and is REFUSED by design (encodeSegment is not exported).
  if (basename(dir) !== sessionId) throw new Error('日志文件路径校验失败，已取消删除：' + sessionId)
  // Accept every canonical generation filename (`session.jsonl[.zstd]`,
  // `session.vN.jsonl[.zstd]`) and require one to exist before shelling out.
  let artifactNames = []
  try {
    artifactNames = await readdir(dir)
  } catch (error) {
    artifactNames = []
  }
  if (!artifactNames.some(isGenerationFile)) {
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
    // `shell.execute(spec)` is the ONLY name this seam has: the abstract
    // ShellExecutor and all four executors expose `execute` and never `run`.
    // There is also no `foreground` flag on ShellExecSpec — "foreground" means
    // AWAITING the returned ShellExecution's `result()` METHOD, which resolves
    // (rather than rejects) on timeout/abort with exitCode null.
    const execution = await shell.execute(spec)
    const result = await execution.result()
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
  const cached = cachedCount(sessionId)
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
        rememberCount(job.sessionId, { revision: job.revision, messageCount })
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

// Re-add one id to the archive set through the same storage-domain path.
// Only used as the compensating write of requestStopActivity: that helper has
// to unarchive first (the official archive seam early-returns for an archived
// id), and if the re-archive then fails the session must not stay visible in
// the sidebar as if it had been restored.
async function archiveRecord(ctx, sessionId) {
  const storageDomain = ctx.get('storageDomain')
  const domain = storageDomain ? storageDomain.get('workspace') : undefined
  if (!domain) throw new Error('workspace 存储域不可用')
  const state = domain.global.get()
  const archived = state && Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : []
  if (archived.includes(sessionId)) return
  const original = state.archivedSessionIds
  state.archivedSessionIds = archived.concat([sessionId])
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
// subagent descendants, owned background jobs, active schedules).
//
// The seam's `archiveSession(id, { stopActivity: true })` resolves WITHOUT
// writing, asking or stopping when the id is already in the archive set, and
// every session this plugin deletes is archived — so a direct call is a no-op.
// `unarchiveSession(id)` is the official public counterpart that removes the
// entry; re-archiving with the option then writes the entry back and dispatches
// `workspace/session-stop`. (0.2.0-rc.2 and 0.2.1-rc.1 both expose both methods;
// see the README's seam section.) The id is briefly outside the archive set
// between the two durable writes, so a sidebar render in that window can flash
// the row; the re-archive follows immediately.
//
// A failure is RETURNED (not thrown): the delete that follows may fail for a
// reason the user needs to see, and a version without the seam must still
// report why the stop could not be requested. If the re-archive fails after the
// unarchive succeeded, the compensating write restores the archive entry; the
// returned text then names that failure so the caller can surface it.
async function requestStopActivity(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry || typeof registry.archiveSession !== 'function') {
    return '当前 dsh 版本没有 archiveSession(stopActivity) 接缝，无法请求停止其运行中的工作'
  }
  if (typeof registry.unarchiveSession !== 'function') {
    return '当前 dsh 版本没有 unarchiveSession 接缝，无法先解除归档再请求停止其运行中的工作'
  }
  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    return '无法先解除归档以请求停止：' + String((error && error.message) || error)
  }
  try {
    await registry.archiveSession(sessionId, { stopActivity: true })
    return null
  } catch (error) {
    try {
      await archiveRecord(ctx, sessionId)
    } catch {
      /* the returned error already explains the stop failure; the archive entry
         is the caller's to re-check (deleteSession/deleteSessions only queue the
         delete here, and the next listing shows the real archive state). */
    }
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
//
// EVERY owner loses its slot, not just the first one found: the registry is the
// authority for grouping, and a second accounting slot left behind re-surfaces
// the session on the next grouping snapshot (the sidebar's ungrouped bucket).
async function purgeRecords(ctx, ids) {
  const registry = ctx.get('workspaceRegistry')
  for (const id of ids) {
    for (const workspace of registry.list()) {
      if (!Array.isArray(workspace.sessionIds) || !workspace.sessionIds.includes(id)) continue
      await workspace.detachSession(id)
    }
  }
  for (const id of ids) await unarchive(ctx, id)
  for (const id of ids) {
    countCache.delete(id)
    countInflight.delete(id)
  }
}

// Ids the queue has actually completed since the last listing.
//
// The drain is fired WITHOUT awaiting (a listing must never wait on queue I/O),
// so its outcome is reported to the NEXT listing instead: the client uses it to
// refresh the sidebar's session store. Without that refresh the browser keeps
// rendering rows the Host no longer lists — and because the completed deletion
// also drops the archive entry, those stale rows become VISIBLE again as
// ungrouped, logless ghosts (the reported "删掉的会话跑到未分组" symptom).
const DRAINED_LEDGER_MAX = 200
let drainedSinceLastList = []

function rememberDrained(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return
  for (const id of ids) if (!drainedSinceLastList.includes(id)) drainedSinceLastList.push(id)
  if (drainedSinceLastList.length > DRAINED_LEDGER_MAX) {
    drainedSinceLastList = drainedSinceLastList.slice(-DRAINED_LEDGER_MAX)
  }
}

function takeDrained() {
  const ids = drainedSinceLastList
  drainedSinceLastList = []
  return ids
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
    // Without a listing there is no way to tell a deleted log from a readable one
    // the medium failed to report; touching nothing keeps the queue intact and
    // the records consistent. The next sweep retries.
    if (!loaded.ok) return { drained: [], remaining: state.sessionIds }
    const bySnap = buildById(loaded.snapshots)
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
        let snap = bySnap.get(id)
        if (!snap) {
          // The listing omits what it cannot interpret, so a queued id without a
          // snapshot must be probed before its records are dropped: anything but
          // positive evidence of absence means the log may still own its workspace
          // accounting, and purging the records would orphan it.
          const probe = await probeLogState(ctx.get('sessionPersistence'), id)
          if (probe.state !== 'missing') {
            remaining.push(id)
            continue
          }
        }
        if (snap) await purgeLogs(ctx, [snap])
        await purgeRecords(ctx, [id])
        await markRecentlyDeleted([id])
        drained.push(id)
      } catch {
        remaining.push(id) // still locked, unreadable or re-listed: retry on the next sweep
      }
    }
    if (drained.length > 0) {
      await dequeuePending(drained)
      rememberDrained(drained)
    }
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
    // listing must never wait on queue I/O; ids a PREVIOUS sweep completed are
    // reported here so the client can refresh the sidebar's session store.
    drainPending(ctx).catch(() => {})
    const drainedIds = takeDrained()
    // The label text is part of the wire: the client renders what the Host
    // reports instead of keeping a second copy in sync.
    const staleLabel = STALE_ROW_LABEL
    const registry = ctx.get('workspaceRegistry')
    const sessions = ctx.get('sessions')
    if (!registry) return { items: [], drainedIds, staleLabel, error: 'workspace 服务不可用' }
    const ids = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds.slice() : []
    const pendingIds = await readPendingIds()
    if (ids.length === 0) return { items: [], pendingIds, drainedIds, staleLabel }

    const { snapshots, ok } = await loadSnapshots(ctx)
    if (!ok) return { items: [], drainedIds, staleLabel, error: '无法读取会话列表' }
    const bySnap = buildById(snapshots)
    const persistence = ctx.get('sessionPersistence')

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

    const items = []
    for (const sessionId of ids) {
      const workspace = wsBySession.get(sessionId) || null
      const live = sessions ? sessions.get(sessionId) !== undefined : false
      let snap = bySnap.get(sessionId)
      if (!snap) {
        // A listing SILENTLY OMITS a log it cannot interpret, so absence is not
        // "gone". Probe the medium: `missing` requires positive evidence of
        // absence, `unreadable` means a log still owns the id, and `present`
        // (stat found it after all) falls through to the normal row.
        const probe = await probeLogState(persistence, sessionId)
        if (probe.state === 'missing') {
          // The stale-record row: the archive set names this id, but nothing
          // backs it any more. This is the only state the record cleanup may
          // retire (see purgeStaleRecords).
          items.push({
            sessionId, status: 'missing', missing: true, unreadable: false,
            formatStatus: undefined, live, workspace, messageCount: null, statsPending: false,
          })
          continue
        }
        if (probe.state === 'unreadable') {
          // The log exists but this build cannot read it (needs migration or a
          // newer/older harness). Its workspace accounting and archive entry
          // must survive, so the row is reported as unreadable — never missing.
          items.push({
            sessionId, status: 'unreadable', missing: false, unreadable: true,
            unreadableReason: probe.reason, formatStatus: undefined,
            live, workspace, messageCount: null, statsPending: false,
          })
          continue
        }
        snap = probe.snap
      }
      const formatStatus = typeof snap.formatStatus === 'string' ? snap.formatStatus : undefined
      const cached = cachedCount(sessionId)
      let messageCount = null
      let statsPending = false
      if (cached && cached.revision === snap.revision) {
        messageCount = cached.messageCount
      } else {
        enqueueCount(ctx, sessionId, snap.revision)
        statsPending = countPending(sessionId)
      }
      items.push({
        sessionId, status: 'present', missing: false, unreadable: false,
        formatStatus, live, workspace, messageCount, statsPending,
      })
    }
    return { items, pendingIds, drainedIds, staleLabel }
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
    // The cached count came from the log this session no longer hides behind;
    // drop it so a later re-archive recounts against the current revision.
    countCache.delete(sessionId)
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
   * accounting + archive entry.
   *
   * A session that is still live in the in-memory store is QUEUED, never deleted
   * in place: archiving only hides it, so its write chain would re-create the
   * log after the records are gone. requestStopActivity asks the official seam to
   * stop its running work first; the client explains the queue.
   *
   * A session whose log exists but cannot be read by this build (unreadable) is
   * REFUSED here: the listing omits it, so deleting "the records" would leave
   * the still-present log orphaned. The user can restore it or migrate/upgrade
   * DSH first.
   *
   * The confirmation gate accepts any of: the durable title, the cwd
   * basename, the session id, the stale-row label, or the exact string the UI
   * displayed (`displayedTitle`) — see the candidate block below.
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

    // The listing SILENTLY OMITS a log it cannot interpret, so an absent
    // snapshot is not proof that no content exists. Probe BEFORE the stop
    // request: an unreadable log must be refused without first interrupting the
    // session's running work. Removing only the accounting and archive entry
    // would orphan that log for good; a positively missing id continues as a
    // record-only cleanup (no log to delete).
    const { snapshots, ok } = await loadSnapshots(ctx)
    if (!ok) throw new Error('无法读取会话列表，已取消删除')
    const bySnap = buildById(snapshots)
    let snap = bySnap.get(sessionId)
    if (!snap) {
      const probe = await probeLogState(persistence, sessionId)
      if (probe.state === 'unreadable') {
        throw new Error(
          '该会话的日志文件存在，但当前 DSH 版本无法读取（需迁移或升级 DSH）；' +
          '为避免只删记录、把日志留成孤儿，已取消删除：' + (probe.reason || sessionId)
        )
      }
      // stat() found a readable snapshot the listing omitted (a listing/medium
      // race): adopt it, so the delete still removes the real log instead of only
      // the records.
      if (probe.state === 'present') snap = probe.snap
    }

    // A session that is still live in the in-memory store is NO LONGER refused.
    // A freshly archived session always is (archiving hides it, it does not stop
    // it), which used to make the most obvious delete impossible until a restart.
    // Ask the official seam to stop its running work, then try the delete; a log
    // that survives goes to the pending queue and completes as soon as the
    // session leaves memory (see the queue helpers above).
    const session = sessions ? sessions.get(sessionId) : undefined
    const wasLive = session !== undefined
    const stopError = wasLive ? await requestStopActivity(ctx, sessionId) : null

    const isLiveDescendant = (id) => (sessions ? sessions.get(id) !== undefined : false)
    const tree = subtreeOf(snapshots, sessionId, isLiveDescendant)
    const descendantIds = tree.deletable.map((entry) => entry.header.id).concat(tree.blocked)
    if (descendantIds.length > 0 && allowChildren !== true && cascadeChildren !== true) {
      /* Do NOT refuse outright. A child session lives in its own artifact — a
         spawn child (isSeeded=false) has no inherited prefix at all, and a
         seeded fork carries its own copy of the inherited events — so deleting
         the parent leaves every child readable; it only removes the parent link.
         A hard refusal is a dead end here: this page can only see ARCHIVED
         sessions, while children are normally unarchived and DSH has no
         session-deletion path of its own. Return the facts instead and let the
         UI offer "parent only" or "parent + subtree". */
      return {
        ok: true,
        needsChildrenAck: true,
        childCount: descendantIds.length,
        deletableCount: tree.deletable.length,
        liveCount: tree.blocked.length,
        childIds: descendantIds.slice(0, 20),
      }
    }

    // Confirmation candidates. The durable title is read through the host's
    // live-preferred cold read, which loads and validates the stored artifact; an
    // artifact this build refuses to migrate makes that read reject
    // (SessionFormatUnsupportedError). The title is only a confirmation
    // affordance, so an unreadable one MUST degrade to the remaining
    // candidates: hard-failing here is a dead end, because retrying can never
    // succeed. `displayedTitle` is the exact string the UI showed, so
    // "copy the title" always matches; the session id is always accepted (the UI
    // shows it on every row).
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
      addCandidate(STALE_ROW_LABEL)
      addCandidate(sessionId)
    }
    addCandidate(displayedTitle)
    if (!candidates.includes(titleConfirm.trim())) {
      /* Return every accepted value so the UI can show exactly what to type
         instead of a dead-end mismatch. */
      throw new Error('输入的标题与「' + candidates[0] + '」不一致，已取消删除。可输入：' + candidates.join(' 或 '))
    }

    // A session that is still live is NEVER deleted in place. Removing its log
    // only deletes a file its write chain re-creates moments later — after the
    // workspace accounting is already gone — which is exactly how a purged
    // session came back as an ungrouped, data-missing sidebar row. The stop
    // request above helps it leave memory sooner; the log goes once it has.
    if (wasLive) {
      const pendingIds = await enqueuePending([sessionId])
      const stopped = stopError === null
      return {
        ok: true,
        pending: true,
        pendingIds,
        reason: '该会话仍在内存中（' +
          (stopped ? '已请求停止其运行中工作' : '停止其运行中工作的请求未成功') +
          '）。为避免日志被写回后变成无归属的孤儿，已加入待删除队列。',
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
   *   - no workspace accounts for, and
   *   - is absent from the archive set (so this page cannot show it).
   *
   * That rule is mechanical, and it catches three populations that must NOT be
   * conflated (see `classifyOrphan`): an ordinary session whose cwd belongs to a
   * registered workspace yet has no slot (`suspect` — the signature of a delete
   * that left a log behind), a delegated subagent child (`subagent` — DSH never
   * gives those a slot, and every delegation leaves one), and an ordinary
   * session in a directory with no workspace (`unaccounted` — legitimately
   * ungrouped). The scan never removes anything: it reports the kind plus the
   * evidence per candidate (whether the log is READABLE, how many events it
   * holds, whether it is live, and for a child whether its parent still owns a
   * slot) so the user decides.
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
    const workspacePaths = []
    for (const workspace of registry.list()) {
      if (typeof workspace.path === 'string') workspacePaths.push(workspace.path)
      if (!Array.isArray(workspace.sessionIds)) continue
      for (const id of workspace.sessionIds) accounted.add(id)
    }
    const comparablePaths = comparableWorkspacePaths(workspacePaths)
    const counts = { suspect: 0, subagent: 0, unaccounted: 0 }
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
      // The candidate rule above catches three different populations; the kind
      // is what lets the UI stop calling a delegation child "debris".
      const kind = classifyOrphan(snap.header, comparablePaths)
      counts[kind] += 1
      const parentSession = typeof snap.header.parentSession === 'string' && snap.header.parentSession !== ''
        ? snap.header.parentSession
        : null
      items.push({
        sessionId,
        kind,
        createdAt: typeof snap.header.createdAt === 'number' ? snap.header.createdAt : null,
        cwd: typeof snap.header.cwd === 'string' ? snap.header.cwd : null,
        live: sessions ? sessions.get(sessionId) !== undefined : false,
        readable,
        eventCount,
        parentSession,
        // Whether the parent still owns a slot: false means the delegation
        // history outlived the session that produced it.
        parentAccounted: parentSession === null ? null : accounted.has(parentSession),
      })
      if (items.length >= 200) break // bounded: the page must stay responsive
    }
    return { ok: true, items, counts, kinds: ORPHAN_KINDS, confirmWord: BULK_CONFIRM_WORD, scanned: snapshots.length }
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
        // Absence from the listing is not "the log is gone": an artifact this
        // build cannot read is skipped instead of being reported as deleted
        // content (nothing was removed either way).
        const probe = await probeLogState(ctx.get('sessionPersistence'), sessionId)
        results.push({
          sessionId,
          status: 'skipped',
          reason: probe.state === 'unreadable'
            ? '日志文件存在但当前 DSH 版本无法读取（需迁移或升级），未清理'
            : probe.state === 'present'
              ? '该会话仍存在，但本次列表没有读到；请重新扫描后再清理'
              : '日志已不存在',
          deletedChildren: [],
          skippedChildren: [],
        })
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
   * Remove archive entries whose session log no longer exists.
   *
   * How a dead id enters the archive set: a completed delete leaves the browser
   * holding a stale sidebar row (see the drained-ids ledger on `list`), and
   * archiving that row reaches the Host's `archiveSession`, whose
   * `sessionKnown` check consults a header index built at boot and never
   * pruned — so an id whose log was removed after boot still passes. The id
   * then sits in the archive set with nothing behind it.
   *
   * This cleanup can never destroy content: `/list()` omits an unreadable log,
   * so absence alone is not enough. An id is retired only after `probeLogState`
   * returns `missing` (stat() says undefined AND no artifact directory survives)
   * and it is not live in memory. `unreadable` ids keep BOTH their workspace
   * accounting and their archive entry — the log still exists, so removing the
   * accounting would orphan it. The set is re-derived here, never trusted from
   * the client.
   */
  async purgeStaleRecords() {
    const ctx = this.ctx
    const registry = ctx.get('workspaceRegistry')
    const sessions = ctx.get('sessions')
    const persistence = ctx.get('sessionPersistence')
    if (!registry) throw new Error('workspace 服务不可用')
    const archived = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds.slice() : []
    if (archived.length === 0) {
      return { ok: true, removed: [], skippedLive: [], skippedUnreadable: [], pendingIds: [] }
    }
    const { snapshots, ok } = await loadSnapshots(ctx)
    // An unreadable listing must never look like "every log is gone".
    if (!ok) throw new Error('无法读取会话列表，已取消清理')
    const bySnap = buildById(snapshots)
    const removed = []
    const skippedLive = []
    const skippedUnreadable = []
    for (const sessionId of archived) {
      if (bySnap.has(sessionId)) continue
      if (sessions && sessions.get(sessionId) !== undefined) {
        skippedLive.push(sessionId)
        continue
      }
      const probe = await probeLogState(persistence, sessionId)
      if (probe.state !== 'missing') {
        // Present-but-unreadable (or unverifiable): keep the accounting slot and
        // the archive entry. Cleaning them would turn a real log into an orphan
        // with no owner, which is the exact damage this cleanup must not cause.
        skippedUnreadable.push(sessionId)
        continue
      }
      await purgeRecords(ctx, [sessionId])
      removed.push(sessionId)
    }
    if (removed.length > 0) {
      await markRecentlyDeleted(removed)
      await dequeuePending(removed)
    }
    return { ok: true, removed, skippedLive, skippedUnreadable, pendingIds: await readPendingIds() }
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
    const persistence = ctx.get('sessionPersistence')
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
      let missing = false
      let unreadable = false
      let formatStatus
      if (snap) {
        formatStatus = typeof snap.formatStatus === 'string' ? snap.formatStatus : undefined
        // Same candidate chain the single-delete confirmation uses; an
        // unreadable durable title must degrade, never fail the dialog.
        try {
          title = (await readDurableTitle(ctx, sessionId)) || workspaceTitleOf(snap.header.cwd) || sessionId
        } catch {
          title = workspaceTitleOf(snap.header.cwd) || sessionId
        }
      } else {
        // The dialog must say the same thing the list row says: a missing record
        // can be retired, while a log this build cannot read must not be offered
        // as "already gone" (bulk delete skips it for the same reason).
        const probe = await probeLogState(persistence, sessionId)
        missing = probe.state === 'missing'
        unreadable = probe.state === 'unreadable'
      }
      items.push({
        sessionId,
        title,
        live: isLive(sessionId),
        missing,
        unreadable,
        formatStatus,
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
    const persistence = ctx.get('sessionPersistence')
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
      let snap = bySnap.get(sessionId)
      if (!snap) {
        // Same rule as the single-delete path: the listing omits a log this
        // build cannot read, so an absent snapshot is not "content already
        // gone". Only a positively missing record may be retired record-only;
        // an unreadable one is skipped so its log cannot become an orphan.
        const probe = await probeLogState(persistence, sessionId)
        if (probe.state === 'unreadable') {
          results.push({
            sessionId,
            status: 'skipped',
            reason: '日志文件存在但当前 DSH 版本无法读取（需迁移或升级），未删除以避免留下孤儿',
            deletedChildren: [],
            skippedChildren: [],
          })
          continue
        }
        // A readable snapshot the listing raced past: use it so the log is
        // actually removed with the records.
        if (probe.state === 'present') snap = probe.snap
      }
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
          reason: '该会话仍在内存中（' +
            (stopError === null ? '已请求停止其运行中工作' : '停止其运行中工作的请求未成功') +
            '）。为避免日志被写回后变成无归属的孤儿，已加入待删除队列。',
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
markRemote('purgeStaleRecords')

export function apply(ctx) {
  // TypertRemoteService registers `archivedSessions` in ctx.reflect.props and
  // sets `service.typertRemote`; the Gateway's source-mode discovery consumes
  // both.
  new ArchivedSessionsService(ctx)
  // Boot sweep: nothing is live in a freshly booted host, so every queued
  // deletion from a previous run can complete now. Delayed past service startup
  // and unref'd so it can never hold the process open; owned by the fiber so a
  // reload/dispose cancels it instead of leaving an old timer pointed at the
  // dead context.
  ctx.effect(function bootSweep() {
    const timer = setTimeout(() => { drainPending(ctx).catch(() => {}) }, 1500)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  })
  // The count cache, queue and drained-ids ledger are module-level because they
  // are consulted from several helpers; clear them with the fiber so a reload
  // does not reuse counts computed through the old context and so abandoned jobs
  // cannot keep pumping the old queue.
  ctx.effect(function countCacheLifetime() {
    return () => {
      countCache.clear()
      countQueue.length = 0
      countInflight.clear()
      drainedSinceLastList = []
    }
  })
}
