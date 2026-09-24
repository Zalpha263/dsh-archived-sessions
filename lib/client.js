// dsh-archived-sessions — Client half (persistent, web module-loader format).
//
// Registers the `settings.section` entry "归档会话" with the full management
// UI (list / preview / restore / delete), calling the Host through the
// `remote.archivedSessions` namespace mounted by THIS entry (never list it in
// `inject` — that would deadlock the entry).

window.__ModuleLoader__.load({
	id: "dsh-archived-sessions",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		/** Package-owned <style> host — the persistent client has no `styles` builtin. */
		let styleEl = null;
		function insertCss(css) {
			if (styleEl === null || !document.contains(styleEl)) {
				styleEl = document.createElement("style");
				// data-plugin lets the client-modules materializer / HMR cleanup
				// claim and remove this tag with the plugin's other owned styles.
				styleEl.setAttribute("data-plugin", "dsh-archived-sessions");
				styleEl.setAttribute("data-plugin-css", "dsh-archived-sessions");
				document.head.appendChild(styleEl);
			}
			const node = document.createTextNode(css);
			styleEl.appendChild(node);
			return function dispose() {
				if (node.parentNode === styleEl) styleEl.removeChild(node);
			};
		}

		const CSS = `
.as-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex;font-family:inherit}
.as-title{margin:0;font-size:18px;font-weight:600}
.as-intro{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:20px}
.as-notice{margin:0;font-size:13px;line-height:20px}
.as-notice-success{color:var(--dsw-alias-state-success-primary)}
.as-notice-error{color:var(--dsw-alias-state-error-primary)}
.as-loading,.as-empty{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:20px;padding:16px 0;text-align:center}
.as-list{margin:0;padding:0;list-style:none;flex-direction:column;gap:8px;display:flex}
.as-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;flex-direction:column;transition:border-color .16s,background .16s;display:flex}
.as-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.as-cardHead{flex-direction:row;align-items:center;gap:12px;padding:12px 14px;display:flex}
.as-cardTitles{flex-direction:column;gap:4px;min-width:0;flex:1;display:flex}
.as-titleRow{flex-direction:row;align-items:center;gap:6px;min-width:0;display:flex;flex-wrap:wrap}
.as-cardTitle{font-size:15px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}
.as-tag{white-space:nowrap;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:0 7px;font-size:11px;font-weight:500;line-height:17px}
.as-tag-live{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.as-cardMeta{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.as-cardId,.as-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.as-actions{flex-direction:row;gap:6px;flex:none;display:flex}
.as-btn{appearance:none;font:inherit;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 10px;font-size:13px;line-height:18px}
.as-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-interactive-bg-hover)}
.as-btn:disabled{opacity:.5;cursor:default}
.as-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.as-btn-primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.as-btn-danger{color:var(--dsw-alias-state-error-primary)}
.as-preview{border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:0 0 12px 12px;flex-direction:column;gap:8px;padding:10px 14px;display:flex}
.as-previewTitle{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.as-msg{flex-direction:column;gap:2px;display:flex}
.as-msgRole{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600}
.as-msgText{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
.as-msgTools{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.as-confirm{border-top:1px solid var(--dsw-alias-border-l1);flex-direction:column;gap:8px;padding:10px 14px;display:flex}
.as-warn{color:var(--dsw-alias-state-warn-primary);margin:0;font-size:13px;line-height:20px;white-space:pre-line}
.as-input{appearance:none;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;font-size:13px;line-height:18px}
.as-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.as-confirmRow{flex-direction:row;gap:8px;justify-content:flex-end;display:flex}
.as-bulkBar{flex-direction:row;align-items:center;gap:8px;flex-wrap:wrap;display:flex}
.as-check{width:16px;height:16px;flex:none;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}
.as-bulkConfirm{flex-direction:column;gap:8px;display:flex}
.as-bulkList{margin:0;padding-left:18px;max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:4px}
.as-bulkItem{font-size:13px;line-height:18px;overflow-wrap:anywhere}
.as-bulkModes{flex-direction:column;gap:4px;display:flex}
.as-bulkMode{flex-direction:row;align-items:center;gap:6px;font-size:13px;cursor:pointer;display:flex}
.as-bulkAck{flex-direction:row;align-items:center;gap:6px;font-size:13px;cursor:pointer;display:flex}
.as-bulkResults{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;flex-direction:column;gap:6px;padding:10px 12px;display:flex}
`;

		// --- Remote namespace contribution --------------------------------------
		// The `remote.archivedSessions` namespace is mounted by THIS entry; it
		// must therefore never appear in `inject`. Codecs are "strict" with
		// passthrough schemas: since DSH 0.1.7 both Gateways require a create() factory and call
		// `codec.create().parse(value)`; the Host Gateway validates via SRC markers.
		function passthroughSchema() {
			return { parse: (value) => value };
		}
		function strictCodec(typeSymbol) {
			return { mode: "strict", typeSymbol: typeSymbol, create: () => passthroughSchema() };
		}
		const CONTRIBUTION = {
			package: "dsh-archived-sessions",
			descriptors: [
				{
					id: "dsh-archived-sessions#archivedSessions/list",
					service: "archivedSessions",
					namespace: "archivedSessions",
					method: "list",
					invocation: { kind: "direct" },
					parameters: [],
					result: strictCodec("dsh-archived-sessions#archivedSessions/list:result"),
					sourceLocation: { "file": "dsh-archived-sessions/lib/client.js", "line": 1, "column": 1 }
				},
				{
					id: "dsh-archived-sessions#archivedSessions/preview",
					service: "archivedSessions",
					namespace: "archivedSessions",
					method: "preview",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "sessionId", wire: "sessionId", source: "json", codec: strictCodec("dsh-archived-sessions#archivedSessions/preview:sessionId") }
					],
					result: strictCodec("dsh-archived-sessions#archivedSessions/preview:result"),
					sourceLocation: { "file": "dsh-archived-sessions/lib/client.js", "line": 1, "column": 1 }
				},
				{
					id: "dsh-archived-sessions#archivedSessions/restore",
					service: "archivedSessions",
					namespace: "archivedSessions",
					method: "restore",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "sessionId", wire: "sessionId", source: "json", codec: strictCodec("dsh-archived-sessions#archivedSessions/restore:sessionId") }
					],
					result: strictCodec("dsh-archived-sessions#archivedSessions/restore:result"),
					sourceLocation: { "file": "dsh-archived-sessions/lib/client.js", "line": 1, "column": 1 }
				},
				{
					id: "dsh-archived-sessions#archivedSessions/deleteSession",
					service: "archivedSessions",
					namespace: "archivedSessions",
					method: "deleteSession",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "sessionId", wire: "sessionId", source: "json", codec: strictCodec("dsh-archived-sessions#archivedSessions/deleteSession:sessionId") },
						{ name: "titleConfirm", wire: "titleConfirm", source: "json", codec: strictCodec("dsh-archived-sessions#archivedSessions/deleteSession:titleConfirm") },
						{ name: "displayedTitle", wire: "displayedTitle", source: "json", codec: strictCodec("dsh-archived-sessions#archivedSessions/deleteSession:displayedTitle") },
						{ name: "allowChildren", wire: "allowChildren", source: "json", codec: strictCodec("dsh-archived-sessions#archivedSessions/deleteSession:allowChildren") },
						{ name: "cascadeChildren", wire: "cascadeChildren", source: "json", codec: strictCodec("dsh-archived-sessions#archivedSessions/deleteSession:cascadeChildren") }
					],
					result: strictCodec("dsh-archived-sessions#archivedSessions/deleteSession:result"),
					sourceLocation: { "file": "dsh-archived-sessions/lib/client.js", "line": 1, "column": 1 }
				},
				{
					id: "dsh-archived-sessions#archivedSessions/planDelete",
					service: "archivedSessions",
					namespace: "archivedSessions",
					method: "planDelete",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "sessionIds", wire: "sessionIds", source: "json", codec: strictCodec("dsh-archived-sessions#archivedSessions/planDelete:sessionIds") }
					],
					result: strictCodec("dsh-archived-sessions#archivedSessions/planDelete:result"),
					sourceLocation: { "file": "dsh-archived-sessions/lib/client.js", "line": 1, "column": 1 }
				},
				{
					id: "dsh-archived-sessions#archivedSessions/deleteSessions",
					service: "archivedSessions",
					namespace: "archivedSessions",
					method: "deleteSessions",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "sessionIds", wire: "sessionIds", source: "json", codec: strictCodec("dsh-archived-sessions#archivedSessions/deleteSessions:sessionIds") },
						{ name: "cascadeMode", wire: "cascadeMode", source: "json", codec: strictCodec("dsh-archived-sessions#archivedSessions/deleteSessions:cascadeMode") },
						{ name: "confirmWord", wire: "confirmWord", source: "json", codec: strictCodec("dsh-archived-sessions#archivedSessions/deleteSessions:confirmWord") }
					],
					result: strictCodec("dsh-archived-sessions#archivedSessions/deleteSessions:result"),
					sourceLocation: { "file": "dsh-archived-sessions/lib/client.js", "line": 1, "column": 1 }
				}
			]
		};

		function formatDateTime(ts) {
			if (!ts) return '—';
			const d = new Date(ts);
			const pad = (n) => String(n).padStart(2, '0');
			const now = new Date();
			const datePart = d.getFullYear() === now.getFullYear()
				? pad(d.getMonth() + 1) + '-' + pad(d.getDate())
				: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
			return datePart + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
		}

		function SessionCard(props) {
			const { item, expanded, preview, confirming, busy, disabled, bulkMode, selected, onToggleSelected,
				onTogglePreview, onRestore, onStartDelete, onCancelDelete, onConfirmDelete, onForceDelete, onCascadeDelete,
				deleteInput, deleteHint, onDeleteInputChange, childrenAck } = props;
			const busyOn = busy !== null && busy.id === item.sessionId;
			const metaParts = [];
			metaParts.push(item.workspace ? '工作区：' + item.workspace.title : '未分组');
			metaParts.push('最后活跃：' + formatDateTime(item.lastActiveAt));
			if (item.messageCount === null) {
				metaParts.push(item.statsPending ? '消息数：统计中…' : '消息数：—');
			} else {
				metaParts.push('消息数：' + item.messageCount);
			}
			const metaText = metaParts.join(' · ');

			// The confirmation panel. Live sessions are no longer refused: the Host
			// asks the official archive seam to stop their running work, tries the
			// delete immediately, and falls back to the pending queue when the log
			// survives — so the panel notes the situation and continues.
			let confirmPanel = null;
			if (confirming) {
				{
					/* The Host is the authoritative validator (durable title →
					   cwd basename → session id; see deleteSession). The gate
					   requires only a deliberate non-empty input so a displayed
					   summary that differs from the Host's expected value cannot
					   dead-lock the confirm: the Host's rejection names the exact
					   value to type, and the placeholder hint shows the candidates
					   up front (setConfirmHint in startDelete). */
					confirmPanel = React.createElement('div', { className: 'as-confirm' },
						item.live && React.createElement('p', { className: 'as-hint' },
							'该会话仍在内存中：删除会先请官方接缝停止它的运行中工作，然后把它加入待删除队列 —— ' +
							'等它退出内存后自动完成（最迟下次重启 DSH）。这样它的日志不会被写回成无归属的孤儿。'),
						React.createElement('p', { className: 'as-warn', role: 'alert' },
							'删除不可恢复：该会话的日志文件将被永久删除。请输入会话标题或会话 ID 以确认：'),
						React.createElement('p', { className: 'as-hint' }, '会话 ID：' + item.sessionId),
						React.createElement('input', {
							className: 'as-input',
							value: deleteInput,
							placeholder: deleteHint || item.title,
							onChange: (event) => onDeleteInputChange(event.target.value),
							onKeyDown: (event) => {
								if (event.key !== 'Enter' || deleteInput.trim().length === 0 || disabled) return;
								if (childrenAck !== null && childrenAck !== undefined) onForceDelete(item);
								else onConfirmDelete(item);
							},
							autoFocus: true,
						}),
						childrenAck !== null && childrenAck !== undefined && React.createElement('p', { className: 'as-warn', role: 'alert' },
							'该会话有 ' + childrenAck.count + ' 个子会话（可一并删除 ' + childrenAck.deletable + ' 个' +
							(childrenAck.live > 0 ? '，另有 ' + childrenAck.live + ' 个仍在运行、会被跳过' : '') + '）。' +
							'子会话的日志是独立的：选「仅删父会话」它们会保留（只失去父会话关联）；选「连同子会话」会一起永久删除。'),
						React.createElement('div', { className: 'as-confirmRow' },
							React.createElement('button', { type: 'button', className: 'as-btn', onClick: onCancelDelete, disabled }, '取消'),
							(childrenAck !== null && childrenAck !== undefined)
								? React.createElement(React.Fragment, null,
									React.createElement('button', {
										type: 'button',
										className: 'as-btn',
										onClick: () => onForceDelete(item),
										disabled: deleteInput.trim().length === 0 || disabled,
									}, busyOn && busy.kind === 'delete' ? '处理中…' : '仅删父会话'),
									React.createElement('button', {
										type: 'button',
										className: 'as-btn as-btn-danger',
										onClick: () => onCascadeDelete(item),
										disabled: deleteInput.trim().length === 0 || disabled || childrenAck.deletable === 0,
									}, '连同 ' + childrenAck.deletable + ' 个子会话一起删除'),
								)
								: React.createElement('button', {
									type: 'button',
									className: 'as-btn as-btn-danger',
									onClick: () => onConfirmDelete(item),
									disabled: deleteInput.trim().length === 0 || disabled,
								}, busyOn && busy.kind === 'delete' ? '删除中…' : '确认删除'),
						),
					);
				}
			}

			return React.createElement('li', { className: 'as-card' },
				React.createElement('div', { className: 'as-cardHead' },
					bulkMode === true && React.createElement('input', {
						type: 'checkbox',
						className: 'as-check',
						checked: selected === true,
						'aria-label': '选择会话「' + item.title + '」',
						onChange: () => onToggleSelected(item.sessionId),
					}),
					React.createElement('div', { className: 'as-cardTitles' },
						React.createElement('span', { className: 'as-titleRow' },
							React.createElement('span', { className: 'as-cardTitle' }, item.title),
							item.live && React.createElement('span', { className: 'as-tag as-tag-live' }, '仍在内存 · 将加入待删除'),
						),
						React.createElement('span', { className: 'as-cardMeta' }, metaText),
						React.createElement('span', { className: 'as-cardId' }, '会话 ID：' + item.sessionId),
					),
					React.createElement('div', { className: 'as-actions' },
						!item.missing && React.createElement('button', {
							type: 'button',
							className: 'as-btn',
							onClick: () => onTogglePreview(item),
							disabled,
						}, expanded ? '收起' : '预览'),
						React.createElement('button', {
							type: 'button',
							className: 'as-btn as-btn-primary',
							onClick: () => onRestore(item),
							disabled,
						}, busyOn && busy.kind === 'restore' ? '恢复中…' : '恢复到工作区'),
						React.createElement('button', {
							type: 'button',
							className: 'as-btn as-btn-danger',
							onClick: () => onStartDelete(item),
							disabled,
						}, busyOn && busy.kind === 'delete' ? '删除中…' : '删除'),
					),
				),
				expanded && !item.missing && React.createElement('div', { className: 'as-preview' },
					React.createElement('p', { className: 'as-previewTitle' }, '对话预览（开头 6 条）'),
					(preview === undefined || preview.phase === 'loading') &&
						React.createElement('p', { className: 'as-loading' }, '加载中…'),
					preview !== undefined && preview.phase === 'error' &&
						React.createElement('p', { className: 'as-notice as-notice-error', role: 'alert' }, preview.error),
					preview !== undefined && preview.phase === 'ready' && preview.messages.length === 0 &&
						React.createElement('p', { className: 'as-loading' }, '该会话没有可显示的对话内容。'),
					preview !== undefined && preview.phase === 'ready' && preview.messages.map((message, index) =>
						React.createElement('div', { key: index, className: 'as-msg' },
							React.createElement('span', { className: 'as-msgRole' }, message.role === 'user' ? '用户' : '助手'),
							message.text !== '' && React.createElement('span', { className: 'as-msgText' }, message.text),
							Array.isArray(message.tools) && message.tools.length > 0 &&
								React.createElement('span', { className: 'as-msgTools' },
									'🔧 调用了 ' + message.tools.map((name) => '「' + name + '」').join('、') + ' 工具'),
						),
					),
				),
				confirmPanel,
			);
		}

		// Stable fallback snapshots / subscription for useSyncExternalStore: the
		// hook loops when getSnapshot returns a fresh identity per call, so both
		// the fallback values and the no-op subscribe are module-level singletons.
		const EMPTY_SESSIONS = { byId: {} };
		const EMPTY_WORKSPACES = { archivedSessionIds: [] };
		function noopSubscribe() { return function noopUnsubscribe() {}; }
		function emptySessionsSnapshot() { return EMPTY_SESSIONS; }
		function emptyWorkspacesSnapshot() { return EMPTY_WORKSPACES; }

		function ArchivedSessionsSection(props) {
			const { remote, refreshSessions, sessionsSvc, workspacesSvc } = props;
			const [phase, setPhase] = React.useState('loading');
			const [items, setItems] = React.useState([]);
			const [pendingIds, setPendingIds] = React.useState([]);
			const [listError, setListError] = React.useState(null);
			const [notice, setNotice] = React.useState(null);
			const [expandedId, setExpandedId] = React.useState(null);
			const [previews, setPreviews] = React.useState({});
			const [confirmingId, setConfirmingId] = React.useState(null);
			const [deleteInput, setDeleteInput] = React.useState('');
			const [confirmHint, setConfirmHint] = React.useState(null);
			const [childrenAck, setChildrenAck] = React.useState(null);
			const [busy, setBusy] = React.useState(null);
			const retries = React.useRef(0);

			// Standard feeds: reactive session summaries + archive-set version.
			// The settings.section slot hands a section ONLY { close } (the
			// 0.1.2-rc.1 contract), so the summary and archive stores are read
			// straight off the client services instead of shell props. The
			// workspace store's subscribe/getSnapshot are prototype methods, so
			// they are bound once per store and memoized (useSyncExternalStore
			// needs stable identities).
			const sessionsStore = sessionsSvc ? sessionsSvc.list : null;
			const workspacesStore = workspacesSvc ? workspacesSvc.list : null;
			const subscribeSessions = React.useMemo(
				() => sessionsStore ? sessionsStore.subscribe.bind(sessionsStore) : noopSubscribe,
				[sessionsStore],
			);
			const snapshotSessions = React.useMemo(
				() => sessionsStore ? sessionsStore.getSnapshot.bind(sessionsStore) : emptySessionsSnapshot,
				[sessionsStore],
			);
			const subscribeWorkspaces = React.useMemo(
				() => workspacesStore ? workspacesStore.subscribe.bind(workspacesStore) : noopSubscribe,
				[workspacesStore],
			);
			const snapshotWorkspaces = React.useMemo(
				() => workspacesStore ? workspacesStore.getSnapshot.bind(workspacesStore) : emptyWorkspacesSnapshot,
				[workspacesStore],
			);
			const sessionsList = React.useSyncExternalStore(subscribeSessions, snapshotSessions);
			const workspacesList = React.useSyncExternalStore(subscribeWorkspaces, snapshotWorkspaces);
			const byId = sessionsList.byId;
			const archivedVersion = workspacesList.archivedSessionIds;

			// silent refreshes update data without flashing the whole list back to
			// the loading state (stats polls and archive-set changes use them).
			const load = (silent) => {
				if (!silent) setPhase('loading');
				remote().list()
					.then((result) => {
						const next = result && Array.isArray(result.items) ? result.items : [];
						setItems(next);
						setPendingIds(result && Array.isArray(result.pendingIds) ? result.pendingIds : []);
						setListError(result && result.error ? result.error : null);
						setPhase('ready');
						/* Prune previews for sessions that left the archive set
						   (deleted / restored) — otherwise the cache grows without
						   bound over a long session. */
						setPreviews((prev) => {
							const ids = new Set(next.map((item) => item.sessionId));
							const kept = {};
							for (const key of Object.keys(prev)) if (ids.has(key)) kept[key] = prev[key];
							return kept;
						});
						if (!next.some((item) => item.messageCount === null)) retries.current = 0;
					})
					.catch((error) => {
						if (!silent) {
							setItems([]);
							setListError(String((error && error.message) || error));
							setPhase('ready');
						}
					});
			};

			React.useEffect(() => {
				load(false);
			}, []);

			// Reload silently when the archive set changes elsewhere.
			const prevArchived = React.useRef(archivedVersion);
			React.useEffect(() => {
				if (prevArchived.current !== archivedVersion) {
					prevArchived.current = archivedVersion;
					load(true);
				}
			}, [archivedVersion]);

			// Re-poll silently while the Host still reports background stats in flight.
			React.useEffect(() => {
				if (phase !== 'ready') return;
				if (!items.some((item) => item.messageCount === null && item.statsPending)) return;
				if (retries.current >= 120) return;
				retries.current += 1;
				const handle = setTimeout(() => load(true), 2000);
				return () => clearTimeout(handle);
			}, [phase, items]);

			const togglePreview = (item) => {
				if (expandedId === item.sessionId) {
					setExpandedId(null);
					return;
				}
				setExpandedId(item.sessionId);
				if (previews[item.sessionId] || item.missing) return;
				setPreviews((prev) => ({ ...prev, [item.sessionId]: { phase: 'loading' } }));
				remote().preview(item.sessionId)
					.then((result) => {
						setPreviews((prev) => ({
							...prev,
							[item.sessionId]: { phase: 'ready', messages: result && Array.isArray(result.messages) ? result.messages : [] },
						}));
					})
					.catch((error) => {
						setPreviews((prev) => ({
							...prev,
							[item.sessionId]: { phase: 'error', error: String((error && error.message) || error) },
						}));
					});
			};

			const restore = (item) => {
				setBusy({ id: item.sessionId, kind: 'restore' });
				setNotice(null);
				remote().restore(item.sessionId)
					.then((result) => {
						if (result && result.workspaceTitle) {
							setNotice({ kind: 'success', text: '已恢复到工作区「' + result.workspaceTitle + '」' });
						} else {
							setNotice({ kind: 'success', text: '已恢复（原工作区已删除，会话将出现在未分组）' });
						}
						refreshSessions(); /* v1.2.1: README 承诺恢复后侧边栏自动刷新 */
						load(true);
					})
					.catch((error) => {
						setNotice({ kind: 'error', text: '恢复失败：' + String((error && error.message) || error) });
					})
					.finally(() => setBusy(null));
			};

			const startDelete = (item) => {
				setNotice(null);
				setConfirmingId(item.sessionId);
				setDeleteInput('');
				setChildrenAck(null);
				/* v1.3.3: the Host accepts the displayed title, the durable title,
				   the cwd basename, or the session id; the hint names the displayed
				   title and always offers the session id as the fallback. */
				if (item.missing) {
					setConfirmHint('数据缺失的会话');
				} else if (item.title === '无标题会话') {
					setConfirmHint('无标题会话（或会话 ID）');
				} else {
					setConfirmHint(item.title + '（或会话 ID）');
				}
			};

			const cancelDelete = () => {
				setConfirmingId(null);
				setDeleteInput('');
				setChildrenAck(null);
			};

			/* Shared delete runner. A first attempt on a session that still has
			   children comes back as { needsChildrenAck } instead of an error, so
			   the UI can warn and let the user choose "parent only" or "parent +
			   subtree". */
			const runDelete = (item, allowChildren, cascadeChildren) => {
				setBusy({ id: item.sessionId, kind: 'delete' });
				setNotice(null);
				remote().deleteSession(item.sessionId, deleteInput, item.title, allowChildren, cascadeChildren)
					.then((result) => {
						if (result && result.needsChildrenAck === true) {
							const count = typeof result.childCount === 'number' ? result.childCount : 0;
							const deletable = typeof result.deletableCount === 'number' ? result.deletableCount : count;
							const live = typeof result.liveCount === 'number' ? result.liveCount : 0;
							setChildrenAck({ id: item.sessionId, count, deletable, live });
							setNotice({ kind: 'error', text: '该会话有 ' + count + ' 个子会话。请选择「仅删父会话」或「连同子会话一起删除」。' });
							return;
						}
						const kids = result && Array.isArray(result.deletedChildren) ? result.deletedChildren : [];
						const skipped = result && Array.isArray(result.skippedChildren) ? result.skippedChildren : [];
						let text = '已永久删除会话「' + item.title + '」';
						if (kids.length > 0) text += '，并删除 ' + kids.length + ' 个子会话';
						if (skipped.length > 0) text += '（' + skipped.length + ' 个仍在运行的子会话已跳过）';
						setNotice({ kind: 'success', text: text });
						setConfirmingId(null);
						setDeleteInput('');
						setChildrenAck(null);
						refreshSessions();
						load(true);
					})
					.catch((error) => {
						setNotice({ kind: 'error', text: '删除失败：' + String((error && error.message) || error) });
					})
					.finally(() => setBusy(null));
			};
			const confirmDelete = (item) => runDelete(item, false, false);
			const forceDelete = (item) => runDelete(item, true, false);
			const cascadeDelete = (item) => runDelete(item, true, true);

			const merged = items.map((item) => {
				const summary = byId ? byId[item.sessionId] : undefined;
				const title = item.missing
					? '数据缺失的会话'
					: (summary && summary.displayTitle) || '无标题会话';
				const lastActiveAt = summary && typeof summary.updatedAt === 'number' ? summary.updatedAt : 0;
				return { ...item, title, lastActiveAt };
			});
			merged.sort((a, b) => (b.lastActiveAt - a.lastActiveAt) || String(a.title).localeCompare(String(b.title)));

			const anyBusy = busy !== null;

			// ---- Batch delete --------------------------------------------------
			// Selection is client state; every POLICY decision (which descendants go,
			// whether a session can be removed now or must queue) belongs to the Host
			// — see planDelete/deleteSessions. The UI never re-implements it.
			const [bulkMode, setBulkMode] = React.useState(false);
			const [selectedIds, setSelectedIds] = React.useState([]);
			const [bulkPlan, setBulkPlan] = React.useState(null);
			const [cascadeMode, setCascadeMode] = React.useState('classified');
			const [bulkAck, setBulkAck] = React.useState(false);
			const [bulkWord, setBulkWord] = React.useState('');
			const [bulkBusy, setBulkBusy] = React.useState(false);
			const [bulkResults, setBulkResults] = React.useState(null);
			const confirmWord = '删除';

			const exitBulk = () => {
				setBulkMode(false);
				setSelectedIds([]);
				setBulkPlan(null);
				setBulkAck(false);
				setBulkWord('');
				setBulkResults(null);
			};
			const toggleSelected = (sessionId) => setSelectedIds((current) =>
				current.includes(sessionId) ? current.filter((id) => id !== sessionId) : current.concat([sessionId]));
			const selectAll = () => setSelectedIds(merged.map((item) => item.sessionId));
			const clearSelected = () => setSelectedIds([]);

			const openBulkDelete = () => {
				const ids = selectedIds.slice();
				if (ids.length === 0) {
					setNotice({ kind: 'error', text: '请先勾选要删除的会话。' });
					return;
				}
				setBulkBusy(true);
				setBulkResults(null);
				remote().planDelete(ids).then((result) => {
					if (!result || result.ok !== true) throw new Error((result && result.error) || '无法规划批量删除');
					setBulkPlan(result);
					setCascadeMode(result.defaultMode === 'all' || result.defaultMode === 'keep' ? result.defaultMode : 'classified');
					setBulkAck(false);
					setBulkWord('');
				}).catch((error) => {
					setNotice({ kind: 'error', text: '批量删除准备失败：' + String((error && error.message) || error) });
				}).then(() => setBulkBusy(false));
			};

			const runBulkDelete = () => {
				if (bulkPlan === null || bulkPlan.ok !== true) return;
				const ids = bulkPlan.items.map((entry) => entry.sessionId);
				setBulkBusy(true);
				remote().deleteSessions(ids, cascadeMode, bulkWord).then((result) => {
					setBulkResults(result);
					const summary = result && result.summary ? result.summary : null;
					const text = summary === null
						? '批量删除已完成。'
						: '批量删除：成功 ' + summary.deleted + ' 个'
							+ (summary.pending > 0 ? '，待删除 ' + summary.pending + ' 个（退出内存后自动完成）' : '')
							+ (summary.failed > 0 ? '，失败 ' + summary.failed + ' 个' : '')
							+ (summary.deletedChildren > 0 ? '，连带删除子会话 ' + summary.deletedChildren + ' 个' : '');
					setNotice({ kind: summary !== null && summary.failed > 0 ? 'error' : 'success', text });
					setBulkPlan(null);
					setSelectedIds([]);
					setBulkAck(false);
					setBulkWord('');
					load(true);
				}).catch((error) => {
					setNotice({ kind: 'error', text: '批量删除失败：' + String((error && error.message) || error) });
				}).then(() => setBulkBusy(false));
			};

			return React.createElement('div', { className: 'as-section' },
				React.createElement('h2', { className: 'as-title' }, '归档会话'),
				React.createElement('p', { className: 'as-intro' },
					'管理已归档的会话：查看内容、恢复到原工作区，或彻底删除。' +
					'在侧边栏的会话菜单中选择「归档会话」即可归档。'),
				phase === 'ready' && merged.length > 0 && React.createElement('div', { className: 'as-bulkBar' },
					!bulkMode && React.createElement('button', {
						type: 'button', className: 'as-btn', onClick: () => setBulkMode(true),
					}, '批量删除'),
					bulkMode && React.createElement(React.Fragment, null,
						React.createElement('button', { type: 'button', className: 'as-btn', onClick: selectAll, disabled: bulkBusy }, '全选'),
						React.createElement('button', { type: 'button', className: 'as-btn', onClick: clearSelected, disabled: bulkBusy }, '清空'),
						React.createElement('span', { className: 'as-hint' }, '已选 ' + selectedIds.length + ' 项'),
						React.createElement('button', {
							type: 'button', className: 'as-btn as-btn-danger', onClick: openBulkDelete,
							disabled: bulkBusy || selectedIds.length === 0,
						}, bulkBusy && bulkPlan === null ? '准备中…' : '删除所选'),
						React.createElement('button', { type: 'button', className: 'as-btn', onClick: exitBulk, disabled: bulkBusy }, '退出批量'),
					),
				),
				Array.isArray(pendingIds) && pendingIds.length > 0 && React.createElement('p', { className: 'as-hint' },
					'待删除队列：' + pendingIds.length + ' 个会话（仍在内存中，退出内存后自动完成，最迟下次重启 DSH）。'),
				bulkPlan !== null && React.createElement('div', { className: 'as-confirm as-bulkConfirm' },
					React.createElement('p', { className: 'as-warn', role: 'alert' },
						'批量删除不可恢复：以下 ' + bulkPlan.items.length + ' 个会话的日志文件将被永久删除。'),
					React.createElement('ul', { className: 'as-bulkList' },
						bulkPlan.items.slice(0, 20).map((entry) => React.createElement('li', { key: entry.sessionId, className: 'as-bulkItem' },
							entry.title,
							entry.live && React.createElement('span', { className: 'as-tag as-tag-live' }, '仍在内存'),
							entry.internalCount > 0 && React.createElement('span', { className: 'as-hint' }, ' · 子代理子会话 ' + entry.internalCount + ' 个'),
							entry.forkCount > 0 && React.createElement('span', { className: 'as-hint' }, ' · 我的 fork 子会话 ' + entry.forkCount + ' 个'),
							entry.liveChildCount > 0 && React.createElement('span', { className: 'as-hint' }, ' · 运行中子会话 ' + entry.liveChildCount + ' 个（跳过）'),
						)),
					),
					bulkPlan.items.length > 20 && React.createElement('p', { className: 'as-hint' },
						'…… 其余 ' + (bulkPlan.items.length - 20) + ' 个未展开'),
					React.createElement('div', { className: 'as-bulkModes' },
						[
							['keep', '仅删所选会话（保留全部子会话）'],
							['classified', '同时删除子代理子会话（默认：我自己 fork 的保留）'],
							['all', '全部级联（含我自己 fork 的子会话）'],
						].map((pair) => React.createElement('label', { key: pair[0], className: 'as-bulkMode' },
							React.createElement('input', {
								type: 'radio', name: 'as-cascade', checked: cascadeMode === pair[0],
								onChange: () => setCascadeMode(pair[0]),
							}), pair[1])),
					),
					React.createElement('label', { className: 'as-bulkAck' },
						React.createElement('input', {
							type: 'checkbox', checked: bulkAck,
							onChange: (event) => setBulkAck(event.target.checked),
						}),
						'我知道这些会话不可恢复',
					),
					React.createElement('input', {
						className: 'as-input', value: bulkWord,
						placeholder: '输入「' + confirmWord + '」以确认',
						onChange: (event) => setBulkWord(event.target.value),
					}),
					React.createElement('div', { className: 'as-confirmRow' },
						React.createElement('button', {
							type: 'button', className: 'as-btn', onClick: () => setBulkPlan(null), disabled: bulkBusy,
						}, '取消'),
						React.createElement('button', {
							type: 'button', className: 'as-btn as-btn-danger', onClick: runBulkDelete,
							disabled: bulkBusy || !bulkAck || bulkWord.trim() !== confirmWord,
						}, bulkBusy ? '删除中…' : '确认批量删除'),
					),
				),
				bulkResults !== null && React.createElement('div', { className: 'as-bulkResults' },
					React.createElement('p', { className: 'as-hint' }, '逐条结果：'),
					React.createElement('ul', { className: 'as-bulkList' },
						bulkResults.results.map((row) => React.createElement('li', { key: row.sessionId, className: 'as-bulkItem' },
							(row.status === 'deleted' ? '✅ 已删除 '
								: row.status === 'pending' ? '⏳ 待删除 '
									: row.status === 'failed' ? '❌ 失败 ' : '⏭ 跳过 ') + row.sessionId,
							row.reason !== undefined && row.reason !== null && row.reason !== ''
								&& React.createElement('span', { className: 'as-hint' }, ' —— ' + row.reason),
							Array.isArray(row.deletedChildren) && row.deletedChildren.length > 0
								&& React.createElement('span', { className: 'as-hint' }, '（连带子会话 ' + row.deletedChildren.length + ' 个）'),
						)),
					),
					React.createElement('button', {
						type: 'button', className: 'as-btn', onClick: () => setBulkResults(null),
					}, '收起结果'),
				),
				notice !== null && React.createElement('p', {
					className: 'as-notice ' + (notice.kind === 'success' ? 'as-notice-success' : 'as-notice-error'),
					role: notice.kind === 'success' ? 'status' : 'alert',
				}, notice.text),
				listError !== null && React.createElement('p', { className: 'as-notice as-notice-error', role: 'alert' }, listError),
				phase === 'loading' && React.createElement('p', { className: 'as-loading' }, '正在加载…'),
				phase === 'ready' && merged.length === 0 && React.createElement('p', { className: 'as-empty' },
					'还没有已归档的会话。'),
				phase === 'ready' && merged.length > 0 && React.createElement('ul', { className: 'as-list' },
					merged.map((item) => React.createElement(SessionCard, {
						key: item.sessionId,
						item,
						bulkMode,
						selected: selectedIds.includes(item.sessionId),
						onToggleSelected: toggleSelected,
						expanded: expandedId === item.sessionId,
						preview: previews[item.sessionId],
						confirming: confirmingId === item.sessionId,
						busy,
						disabled: anyBusy,
						onTogglePreview: togglePreview,
						onRestore: restore,
						onStartDelete: startDelete,
						onCancelDelete: cancelDelete,
						onConfirmDelete: confirmDelete,
						onForceDelete: forceDelete,
						onCascadeDelete: cascadeDelete,
						childrenAck: childrenAck !== null && childrenAck.id === item.sessionId ? childrenAck : null,
						deleteInput,
						deleteHint: confirmHint,
						onDeleteInputChange: setDeleteInput,
					})),
				),
			);
		}

		async function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;

			// Fiber-owned cleanup: the runner disposes these on HMR reload /
			// plugin removal (the dsh-file-explorer / dsh-version-update pattern).
			ctx.effect(function installCss() {
				return insertCss(CSS);
			});

			// Mount the remote namespace BEFORE registering UI so section calls
			// resolve immediately.
			try {
				const disposeMount = await ctx.remote.$mount(CONTRIBUTION);
				ctx.effect(function ownMount() {
					return () => {
						try { disposeMount(); } catch (err) {}
					};
				});
			} catch (err) {
				console.error("[dsh-archived-sessions] remote namespace mount failed:", err);
				return;
			}

			// Remote namespace methods resolve to { ok, value } envelopes; unwrap
			// them before the UI consumes the results (mirrors the file-explorer
			// pattern). Never access `ctx.remote.archivedSessions` as a property —
			// that path resolves through the caller fiber's ancestry and throws for
			// a namespace mounted by this very entry; `ctx.get()` reads the shared
			// store directly.
			function unwrap(result) {
				if (result && result.ok === true) return result.value;
				const error = result && result.error;
				throw new Error((error && error.message) || "archivedSessions remote call failed");
			}
			function call(method) {
				const args = Array.prototype.slice.call(arguments, 1);
				return Promise.resolve().then(() => {
					const ns = ctx.get("remote.archivedSessions");
					if (ns === undefined) throw new Error("archivedSessions namespace unavailable");
					return ns[method].apply(ns, args);
				}).then(unwrap);
			}
			function remote() {
				return {
					list: () => call("list"),
					preview: (sessionId) => call("preview", sessionId),
					restore: (sessionId) => call("restore", sessionId),
					deleteSession: (sessionId, titleConfirm, displayedTitle, allowChildren, cascadeChildren) => call("deleteSession", sessionId, titleConfirm, displayedTitle, allowChildren, cascadeChildren),
					planDelete: (sessionIds) => call("planDelete", sessionIds),
					deleteSessions: (sessionIds, cascadeMode, confirmWord) => call("deleteSessions", sessionIds, cascadeMode, confirmWord)
				};
			}

			function refreshSessions() {
				const sessionsSvc = ctx.get("sessions");
				if (sessionsSvc && typeof sessionsSvc.refresh === "function") {
					try {
						sessionsSvc.refresh().catch((error) => console.error("归档会话：刷新会话列表失败", error));
					} catch (error) {
						console.error("归档会话：刷新会话列表失败", error);
					}
				}
			}

			// Reactive feeds for the section (see the useSyncExternalStore calls
			// in ArchivedSessionsSection: the settings shell hands a section only
			// { close }).
			const sessionsSvc = ctx.get("sessions");
			const workspacesSvc = ctx.get("workspaces");

			ctx.effect(function installSection() {
				return slots.inject("settings.section", () => slots.register(
					{ name: "settings.section", id: "archived-sessions", order: 25, label: "归档会话" },
					(props) => React.createElement(ArchivedSessionsSection, {
						...props,
						remote,
						refreshSessions,
						sessionsSvc,
						workspacesSvc,
					}),
				));
			});
		}

		const inject = ["slots", "remote", "sessions", "workspaces"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
