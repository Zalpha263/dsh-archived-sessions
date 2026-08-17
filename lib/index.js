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
//   - Session.listSnapshots() scans the medium, so re-listing after a file
//     deletion reliably reports whether the log is really gone.

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

const ARCHIVED_LIMIT = 6
const MAX_TEXT = 240
const CONCURRENCY = 2
const FALLBACK_REVISION = 'list-fallback'

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

// Session metadata listing with a resilience fallback: listSnapshots first
// (cheap headers + revision tokens); when it fails or returns nothing, fall
// back to the session-query corpus with a constant revision placeholder.
async function loadSnapshots(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence) {
    try {
      const snapshots = await persistence.listSnapshots()
      if (snapshots.length > 0) return { snapshots, ok: true }
    } catch {
      /* fall through to the query fallback */
    }
  }
  const query = ctx.get('sessionQuery')
  if (query) {
    try {
      const records = await query.listSessions()
      if (records.length > 0) {
        return {
          snapshots: records.map((record) => ({
            header: record.header,
            revision: FALLBACK_REVISION,
          })),
          ok: true,
        }
      }
    } catch {
      /* fall through */
    }
  }
  return { snapshots: [], ok: false }
}

function buildIndexes(snapshots) {
  const bySnap = new Map()
  const childCounts = new Map()
  for (const snap of snapshots) {
    bySnap.set(snap.header.id, snap)
    const parent = snap.header.parentSession
    if (parent !== undefined && parent !== null) {
      childCounts.set(parent, (childCounts.get(parent) || 0) + 1)
    }
  }
  return { bySnap, childCounts }
}

async function computeCount(ctx, sessionId, seedLength) {
  const query = ctx.get('sessionQuery')
  let count = 0
  const events = await query.listEvents(sessionId)
  for (const event of events) {
    if (event.seq >= seedLength && (event.type === 'user/message' || event.type === 'assistant/message')) {
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
function enqueueCount(ctx, sessionId, seedLength, revision) {
  if (!ctx.get('sessionQuery') || countInflight.has(sessionId)) return
  const cached = countCache.get(sessionId)
  if (cached && cached.revision === revision) return
  if (countQueue.some((job) => job.sessionId === sessionId)) return
  countQueue.push({ sessionId, seedLength, revision })
  pumpCounts(ctx)
}

function pumpCounts(ctx) {
  while (countRunning < CONCURRENCY && countQueue.length > 0) {
    const job = countQueue.shift()
    countRunning += 1
    countInflight.add(job.sessionId)
    ;(async () => {
      try {
        const messageCount = await computeCount(ctx, job.sessionId, job.seedLength)
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
    const { bySnap, childCounts } = buildIndexes(snapshots)

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
        enqueueCount(ctx, sessionId, snap.header.seedLength || 0, snap.revision)
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
   * NOTE: the wire name must not collide with the client-side
   * RemoteNamespaceService's own methods (e.g. `remove` is taken).
   */
  async deleteSession(sessionId, titleConfirm) {
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

    const state = domain.global.get()
    const archived = state && Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : []
    if (!archived.includes(sessionId)) throw new Error('该会话不在归档列表中')

    // Deleting a session that is live in the in-memory store is unstable: the
    // session's persistence write chain re-creates the log file on the next
    // append, resurrecting the session in the workspace. Refuse with a clear
    // remedy (restart DSH, then delete from this page).
    const session = sessions ? sessions.get(sessionId) : undefined
    if (session !== undefined) {
      throw new Error(
        '该会话当前已打开（位于内存中），无法删除。' +
        '直接删除打开中的会话会导致其日志被重新写回、再次出现在工作区。' +
        '请重启 DSH 后，再从本页删除该会话。'
      )
    }

    const { snapshots, ok } = await loadSnapshots(ctx)
    if (!ok) throw new Error('无法读取会话列表，已取消删除')
    const bySnap = new Map(snapshots.map((entry) => [entry.header.id, entry]))
    const children = snapshots.filter((snap) => snap.header.parentSession === sessionId)
    if (children.length > 0) {
      throw new Error('该会话有 ' + children.length + ' 个子会话，无法删除。请先处理这些子会话。')
    }

    const snap = bySnap.get(sessionId)

    // The confirmation title must match what the client displayed: durable
    // title → cwd basename → session id (mirrors displayTitle).
    let durableTitle = ''
    let titleReadFailed = false
    if (snap) {
      try {
        durableTitle = await readDurableTitle(ctx, sessionId)
      } catch (error) {
        titleReadFailed = true
      }
    }
    if (titleReadFailed) throw new Error('无法读取会话标题用于确认，请重试')
    const expected = snap
      ? (durableTitle || workspaceTitleOf(snap.header.cwd) || sessionId)
      : '数据缺失的会话'
    if (titleConfirm.trim() !== expected) {
      throw new Error('输入的标题与「' + expected + '」不一致，已取消删除')
    }

    // Step 1: delete the log directory (irreversible). When the session's
    // log exists, every failure aborts the whole operation so the session
    // can never resurface as an ungrouped phantom.
    if (snap) {
      if (!shell) throw new Error('文件删除服务不可用，已取消删除')
      let location
      try {
        location = persistence.locate(snap.header)
      } catch (error) {
        location = undefined
      }
      if (!location || typeof location.path !== 'string') {
        throw new Error('无法定位会话日志文件，已取消删除')
      }
      const path = location.path
      const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      const fileName = slash >= 0 ? path.slice(slash + 1) : path
      const dir = slash >= 0 ? path.slice(0, slash) : ''
      const dirSlash = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
      const dirName = dirSlash >= 0 ? dir.slice(dirSlash + 1) : dir
      const validFile = fileName === 'session.jsonl' || fileName === 'session.jsonl.zstd'
      if (!validFile || dirName !== sessionId) throw new Error('日志文件路径校验失败，已取消删除')
      const escaped = dir.replace(/'/g, "''")
      let spec
      try {
        spec = shell.resolve({
          command: "Remove-Item -LiteralPath '" + escaped + "' -Recurse -Force",
          sandboxPolicy: { mode: 'danger-full-access' },
        })
      } catch (error) {
        throw new Error('无法发起文件删除命令：' + String((error && error.message) || error))
      }
      try {
        const result = await shell.run(spec)
        if (result && result.exitCode !== 0 && result.exitCode !== null) {
          throw new Error('删除日志文件失败（退出码 ' + result.exitCode + '）')
        }
      } catch (error) {
        throw new Error('删除日志文件失败：' + String((error && error.message) || error))
      }
      // Verify the log is really gone before touching any durable records.
      const after = await loadSnapshots(ctx)
      if (after.ok && after.snapshots.some((entry) => entry.header.id === sessionId)) {
        throw new Error('日志文件删除后仍存在，已中止（可再次尝试删除以清理记录）')
      }
    }

    // Step 2: remove workspace accounting through the entity write path.
    const owner = registry.list().find((workspace) =>
      Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId))
    if (owner) {
      try {
        await owner.detachSession(sessionId)
      } catch (error) {
        throw new Error('移除工作区归属失败：' + String((error && error.message) || error))
      }
    }

    // Step 3: remove from the archive set (with in-memory rollback on failure).
    await unarchive(ctx, sessionId)

    countCache.delete(sessionId)
    countInflight.delete(sessionId)
    return { ok: true }
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
