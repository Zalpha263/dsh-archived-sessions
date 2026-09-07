# dsh-archived-sessions

归档会话管理 —— DSH 永久插件。

在 **设置 → 归档会话** 页面管理已归档的会话：

- **查看**：列表秒开（零日志解析），显示标题、来源工作区、最后活跃时间（绝对时间戳）、消息数（后台统计，按日志 revision 缓存）
- **恢复**：移除归档记录，会话回到原工作区原位，侧边栏自动刷新
- **删除**：彻底删除（日志目录 + 工作区归属 + 归档记录三处清理），带子会话拦截、标题输入确认、删除后持久化验证；日志目录删除命令按平台自适应（Windows PowerShell / Unix `rm -rf`）

## 已知限制

- 位于内存中（本次运行打开过）的会话无法删除：删除文件后其持久化写入链会重新写回日志导致会话复活。界面会明确标记"无法删除 · 位于内存中"，重启 DSH 后即可删除。
- 删除确认需要输入会话标题：确认值取「持久化标题 → 工作区目录名 → 会话 ID」的链；当会话摘要缺失时，界面会提示确切应输入的内容（输入界面也给出提示），避免"看起来对却永远匹配不上"。

## 架构

- `lib/index.js` — Host 半：`archivedSessions` Typert Remote 服务（list / preview / restore / deleteSession）
- `lib/client.js` — Client 半：web 模块加载器格式，注册 `settings.section` 入口
- `cordis.patch.yml` — bundle 层注册行（id: `archived-sessions`）

## 安装（官方 `dsh plugin` 流程，见 DSH-插件安装注意事项.md v3）

### 开发态（当前采用）

```powershell
dsh plugin --profile web add file:D:/DeepseekPlugin/dsh-archived-sessions
```

- pnpm（`nodeLinker: hoisted`）会在 profile 的 node_modules 里生成**真实副本**（必须用 `file:` 前缀；裸路径会被记为 `link:` 生成 junction，启动时报 `ERR_MODULE_NOT_FOUND`）
- 注册行由包内 `cordis.patch.yml` 提供，bundles 列表由官方 CLI 自动对账
- **改代码后**：pnpm 的 `install`/`update` 不会刷新 file: 副本（实测 "Already up to date"），需 **remove + add 强制重新打包**，然后：Host 改动重启 DSH，仅 Client 改动 Ctrl+F5 硬刷新：
  ```powershell
  dsh plugin --profile web remove dsh-archived-sessions
  dsh plugin --profile web add file:D:/DeepseekPlugin/dsh-archived-sessions
  ```

### 发布态（推送到 GitHub 后切换）

```powershell
dsh plugin --profile web add github:Zalpha263/dsh-archived-sessions#<完整40位commit>
```

## 验证（真实锚点）

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
node --input-type=module -e "const m = await import('dsh-archived-sessions'); console.log(typeof m.apply)"
# 输出 function 即成功
(Invoke-WebRequest http://127.0.0.1:3080/).Content -match 'dsh-archived-sessions'   # 重启后：manifest 含包名
```

## 版本历史

- **v1.3.1**：修复消息数在回退路径下永不更新的问题——当 `sessionPersistence.listSnapshots()` 读取失败、回退到 session-query 语料库时，原来给所有快照打同一个固定 revision（`list-fallback`），导致按 revision 键控的消息数缓存永远命中：会话仍在继续写入，消息数却停留在旧值。修复：回退路径每次列举都生成唯一 revision（`list-fallback-N`），使缓存在该路径下不再"钉死"，每次列举都会重新统计到当前值；在途/排队去重保留（并发列举不会产生重复统计任务）。正常路径（持久化快照带真实 revision）行为不变。
- **v1.3.0**：适配 DSH 0.1.2-rc.1 + 修 3 个真实 bug——① 删除确认面板 `setConfirmHint` 未定义导致点击「删除」即报 ReferenceError（v1.2.1 起线上存在）：补全 state 并把确认提示用作输入框 placeholder；② 确认门与宿主期望值不一致时必然死锁：改为「输入非空即可提交」+ 宿主权威校验报错回显期望值（渲染层显示/宿主校验双链已核对一致）；③ 消息数统计：`SessionHeader.seedLength` 是死字段（恒 undefined），fork 继承前缀被计入消息数——改用 `sessionQuery.readSession()` 的 `inheritedEventCount` 精确排除。另：设置页槽位契约变更（0.1.2-rc.1 只传 `{close}`，原 `props.useSessions/useWorkspaces` 必崩）→ 改为客户端 `sessions`/`workspaces` 服务的 store 直读（`useSyncExternalStore`）；`insertCss`/`$mount`/`slots.inject` 挂 `ctx.effect` 纤维所有权（HMR/卸载正确清理）；删除后「无法验证日志已删除」也中止（防幻影复活）；`dsh.client.inject` 幽灵条目清理、peer 升至 `^0.1.2-rc.1`；日志目录布局 `root/<projectKey>/<encodeSegment(id)>/<id>/` 说明与路径校验注释（不安全的非恒等 id 会被拒绝）。
- **v1.2.1**：跨平台删除（日志目录删除命令按平台分支，Windows 用 PowerShell、macOS/Linux 用 `rm -rf`——此前硬编码 PowerShell 导致非 Windows 无法删除）；恢复会话后侧边栏立即刷新（与文档承诺一致）；删除确认失败时回显期望的标题值，且确认界面提示应输入的内容。
- **v1.2.0**：删除时拦截运行中的会话（防止日志复活）与子会话；删除前路径校验 + 删除后持久化验证。
- **v1.1.0**：消息数后台统计（按日志 revision 缓存，避免重复解析）。
- **v1.0.0**：初版（列表 / 预览 / 恢复 / 删除）。
