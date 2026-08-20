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
`;

		// --- Remote namespace contribution --------------------------------------
		// The `remote.archivedSessions` namespace is mounted by THIS entry; it
		// must therefore never appear in `inject`. Codecs are "strict" with
		// passthrough schemas: the client-side Gateway only calls
		// `codec.schema.parse(value)`; the Host Gateway validates via SRC markers.
		function passthroughSchema() {
			return { parse: (value) => value };
		}
		function strictCodec(typeSymbol) {
			return { mode: "strict", typeSymbol: typeSymbol, schema: passthroughSchema() };
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
						{ name: "titleConfirm", wire: "titleConfirm", source: "json", codec: strictCodec("dsh-archived-sessions#archivedSessions/deleteSession:titleConfirm") }
					],
					result: strictCodec("dsh-archived-sessions#archivedSessions/deleteSession:result"),
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
			const { item, expanded, preview, confirming, busy, disabled,
				onTogglePreview, onRestore, onStartDelete, onCancelDelete, onConfirmDelete,
				deleteInput, onDeleteInputChange } = props;
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

			// The confirmation panel: live sessions cannot be deleted at all (the
			// Host refuses; deleting an open session would let its write chain
			// re-create the log and resurrect it), so show an explanation instead.
			let confirmPanel = null;
			if (confirming) {
				if (item.live) {
					confirmPanel = React.createElement('div', { className: 'as-confirm' },
						React.createElement('p', { className: 'as-warn', role: 'alert' },
							'该会话仍在运行中，无法删除。\n' +
							'原因：归档只会把会话从列表中隐藏，并不会停止它——它仍在内存中继续运行、继续写入日志。此时删除日志文件，运行中的会话会把它重新写回，会话将再次出现。\n' +
							'请重启 DSH（会话随服务停止而退出内存），重启后即可从本页删除。'),
						React.createElement('div', { className: 'as-confirmRow' },
							React.createElement('button', { type: 'button', className: 'as-btn', onClick: onCancelDelete }, '知道了'),
						),
					);
				} else {
					confirmPanel = React.createElement('div', { className: 'as-confirm' },
						React.createElement('p', { className: 'as-warn', role: 'alert' },
							'删除不可恢复：该会话的日志文件将被永久删除。请输入会话标题以确认：'),
						React.createElement('input', {
							className: 'as-input',
							value: deleteInput,
							placeholder: item.title,
							onChange: (event) => onDeleteInputChange(event.target.value),
							onKeyDown: (event) => {
								/* Compare trimmed on both sides to match the Host's
								   trim() validation. */
								if (event.key === 'Enter' && deleteInput.trim() === item.title.trim() && !disabled) onConfirmDelete(item);
								if (event.key === 'Escape') onCancelDelete();
							},
							autoFocus: true,
						}),
						React.createElement('div', { className: 'as-confirmRow' },
							React.createElement('button', { type: 'button', className: 'as-btn', onClick: onCancelDelete, disabled }, '取消'),
							React.createElement('button', {
								type: 'button',
								className: 'as-btn as-btn-danger',
								onClick: () => onConfirmDelete(item),
								disabled: deleteInput.trim() !== item.title.trim() || disabled,
							}, busyOn && busy.kind === 'delete' ? '删除中…' : '确认删除'),
						),
					);
				}
			}

			return React.createElement('li', { className: 'as-card' },
				React.createElement('div', { className: 'as-cardHead' },
					React.createElement('div', { className: 'as-cardTitles' },
						React.createElement('span', { className: 'as-titleRow' },
							React.createElement('span', { className: 'as-cardTitle' }, item.title),
							item.live && React.createElement('span', { className: 'as-tag as-tag-live' }, '无法删除 · 仍在运行'),
						),
						React.createElement('span', { className: 'as-cardMeta' }, metaText),
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

		function ArchivedSessionsSection(props) {
			const { remote, refreshSessions } = props;
			const [phase, setPhase] = React.useState('loading');
			const [items, setItems] = React.useState([]);
			const [listError, setListError] = React.useState(null);
			const [notice, setNotice] = React.useState(null);
			const [expandedId, setExpandedId] = React.useState(null);
			const [previews, setPreviews] = React.useState({});
			const [confirmingId, setConfirmingId] = React.useState(null);
			const [deleteInput, setDeleteInput] = React.useState('');
			const [busy, setBusy] = React.useState(null);
			const retries = React.useRef(0);

			// Standard props: reactive session summaries + archive-set version.
			const byId = props.useSessions((s) => s.byId);
			const archivedVersion = props.useWorkspaces((s) => s.archivedSessionIds);

			// silent refreshes update data without flashing the whole list back to
			// the loading state (stats polls and archive-set changes use them).
			const load = (silent) => {
				if (!silent) setPhase('loading');
				remote().list()
					.then((result) => {
						const next = result && Array.isArray(result.items) ? result.items : [];
						setItems(next);
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
			};

			const cancelDelete = () => {
				setConfirmingId(null);
				setDeleteInput('');
			};

			const confirmDelete = (item) => {
				setBusy({ id: item.sessionId, kind: 'delete' });
				setNotice(null);
				remote().deleteSession(item.sessionId, deleteInput)
					.then(() => {
						setNotice({ kind: 'success', text: '已永久删除会话「' + item.title + '」' });
						setConfirmingId(null);
						setDeleteInput('');
						refreshSessions();
						load(true);
					})
					.catch((error) => {
						setNotice({ kind: 'error', text: '删除失败：' + String((error && error.message) || error) });
					})
					.finally(() => setBusy(null));
			};

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

			return React.createElement('div', { className: 'as-section' },
				React.createElement('h2', { className: 'as-title' }, '归档会话'),
				React.createElement('p', { className: 'as-intro' },
					'管理已归档的会话：查看内容、恢复到原工作区，或彻底删除。' +
					'在侧边栏的会话菜单中选择「归档会话」即可归档。'),
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
						deleteInput,
						onDeleteInputChange: setDeleteInput,
					})),
				),
			);
		}

		async function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;

			// Mount the remote namespace BEFORE registering UI so section calls
			// resolve immediately.
			try {
				await ctx.remote.$mount(CONTRIBUTION);
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
					deleteSession: (sessionId, titleConfirm) => call("deleteSession", sessionId, titleConfirm)
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

			insertCss(CSS);

			slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "archived-sessions", order: 25, label: "归档会话" },
				(props) => React.createElement(ArchivedSessionsSection, {
					...props,
					remote,
					refreshSessions,
				}),
			));
		}

		const inject = ["slots", "remote"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
