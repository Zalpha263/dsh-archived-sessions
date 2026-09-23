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
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

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
    // 0.1.5-rc.2 exposed `shell.run(spec)` -> ShellRunResult. 0.1.7 renamed it to
    // `shell.execute(spec)` -> ShellExecution (a process handle) whose foreground
    // projection is the `result()` METHOD — not a property — and whose resolved
    // value carries exitCode/signal/timedOut/aborted. Prefer the current seam and
    // fall back to the old one, the way loadSnapshots() above prefers
    // persistence.list(). Without this the call throws
    // "shell.run is not a function" and every delete is refused.
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

class ArchivedSessionsService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'archivedSessions')
    this.ctx = ctx
  }

  /** One settings-page load: archive ids + cheap metadata, no log parsing. */
  async list() {
    const ctx = this.ctx
    const registry = ctx.get('workspaceRegistry')
    const sessions = ctx.get('sessions')
    if (!registry) return { items: [], error: 'workspace 服务不可用' }
    const ids = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds.slice() : []
    if (ids.length === 0) return { items: [] }

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
    return { items }
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

    // Deleting a session that is live in the in-memory store is unstable: the
    // session's persistence write chain re-creates the log file on the next
    // append, resurrecting the session in the workspace. Refuse with a clear
    // remedy (restart DSH, then delete from this page). Archiving only hides a
    // session — it never stops a running session — which is why a freshly
    // archived session is still live here.
    const session = sessions ? sessions.get(sessionId) : undefined
    if (session !== undefined) {
      throw new Error(
        '该会话仍在运行中（归档只会把会话从列表中隐藏，不会停止其运行）。' +
        '运行中的会话会继续写入日志，删除会导致日志被重新写回、会话再次出现。' +
        '请重启 DSH 后，再从本页删除该会话。'
      )
    }

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

    // Step 1: delete the log directories (irreversible). Every failure aborts
    // before durable records are touched, so a session can never resurface as an
    // ungrouped phantom. In cascade mode the descendants go first (leaf-first),
    // then the target itself.
    const deletedChildren = []
    if (cascadeChildren === true) {
      const ordered = tree.deletable.slice().reverse()
      for (const child of ordered) {
        await removeLogDirectory(persistence, shell, child)
        deletedChildren.push(child.header.id)
      }
    }
    const deletedLogIds = deletedChildren.slice()
    if (snap) {
      await removeLogDirectory(persistence, shell, snap)
      deletedLogIds.push(sessionId)
    }
    if (deletedLogIds.length > 0) {
      // Verify every log is really gone before touching durable records. An
      // unverifiable listing aborts the same way a surviving log does: the
      // shell run reported success but the listing did not confirm it, and
      // proceeding on a phantom log would resurface the session as an
      // ungrouped phantom. A retry is safe — it re-validates before deleting
      // again, and once a log is gone the retry skips that directory.
      const after = await loadSnapshots(ctx)
      if (!after.ok) {
        throw new Error('无法确认日志文件是否已删除，已中止删除')
      }
      const survivors = deletedLogIds.filter((id) =>
        after.snapshots.some((entry) => entry.header.id === id))
      if (survivors.length > 0) {
        throw new Error('日志文件删除后仍存在，已中止（可再次尝试删除以清理记录）：' + survivors.join('、'))
      }
    }

    // Step 2: remove workspace accounting through the entity write path.
    const accountingIds = [sessionId].concat(deletedChildren)
    for (const id of accountingIds) {
      const owner = registry.list().find((workspace) =>
        Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(id))
      if (!owner) continue
      try {
        await owner.detachSession(id)
      } catch (error) {
        throw new Error('移除工作区归属失败：' + String((error && error.message) || error))
      }
    }

    // Step 3: remove from the archive set (with in-memory rollback on failure).
    for (const id of accountingIds) await unarchive(ctx, id)

    for (const id of accountingIds) {
      countCache.delete(id)
      countInflight.delete(id)
    }
    return { ok: true, deletedChildren, skippedChildren: tree.blocked }
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

export function apply(ctx) {
  // TypertRemoteService registers `archivedSessions` in ctx.reflect.props and
  // sets `service.typertRemote`; the Gateway's source-mode discovery consumes
  // both.
  new ArchivedSessionsService(ctx)
}
