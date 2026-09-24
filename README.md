# dsh-archived-sessions

在 DSH 设置页管理「已归档」的会话：看一看、恢复回去，或者彻底删除。

## 能做什么

入口：**设置 → 归档会话**。

- **查看**：列表秒开，直接显示会话标题、原工作区和最后活跃时间（绝对时间戳）；消息数在后台统计并缓存，反复打开列表不会重复解析日志。
- **预览**：点「预览」看会话开头的 6 条对话（用户 / 助手消息，以及调用了哪些工具）。
- **恢复**：点「恢复到工作区」，归档记录被移除，会话回到原来的工作区位置，侧边栏立即刷新。
- **彻底删除**：日志文件、工作区归属、归档记录三处一起清理。删除前要输入会话标题确认（防误删）；有子会话的归档会被拦下；删除后还会验证日志确实已经消失，避免会话「复活」。

日志目录的删除命令按平台自适应：Windows 用 PowerShell，macOS / Linux 用 `rm -rf`。

## 已知限制

- **正在运行的会话删不掉**：如果某个归档会话在本次运行中被打开过，删掉日志后它的写入链会把日志重新写回来，表现为「删了又回来」。界面会把这类会话标成「无法删除 · 仍在运行」，重启 DSH 后即可正常删除。
- **删除要输入标题或会话 ID**：每张卡片上都会显示该会话的 ID，确认框里还会再给一次。标题、工作区目录名、会话 ID、以及界面上显示的那串标题，输入任意一个都算通过。
- **有子会话时会先问一次**：子会话的日志是独立的，删父会话不会损坏它们。确认框给两个选择——「仅删父会话」（子会话保留，只失去父会话关联）或「连同 N 个子会话一起删除」（整棵子会话树一起永久删除；仍在运行的子会话及其下级会被跳过）。

## 安装

要求：DSH `0.1.5-rc.2`（或兼容的 `0.1.x` 系列）与 [pnpm](https://pnpm.io/zh/)。

```bash
# 发布态：钉死提交，最稳定
dsh plugin --profile web add github:Zalpha263/dsh-archived-sessions#<40位commit>

# 开发态：裸目录路径 = link:（源码即部署，改完不用重装）
dsh plugin --profile web add D:/path/to/dsh-archived-sessions

# 卸载
dsh plugin --profile web remove dsh-archived-sessions
```

装完**重启 DSH**。之后只有界面（Client）改动刷新页面（Ctrl+F5）即可，Host 改动需要重启。

## 常见问题

| 问题 | 原因与解决 |
| --- | --- |
| 设置里没有「归档会话」 | 装完没有重启 DSH；重启后再看 |
| 列表里出现「数据缺失的会话」 | 归档记录还在，但日志文件已经不在了（多半被手动删过）；可以直接删掉这条记录 |
| 删除时提示「仍在运行」 | 见上面的「已知限制」；重启 DSH 后再删 |
| 删除时提示「该会话有 N 个子会话」 | 这是二次确认不是拒绝：选「仅删父会话」或「连同 N 个子会话一起删除」。仍在运行的子会话会被跳过 |
| 预览提示「读取会话内容失败」 | 该会话是旧格式（v0）日志，当前 DSH 无法读取；不影响删除，按提示输入确认值即可 |
| 恢复后侧边栏没变化 | 正常会自动刷新；没刷新就 Ctrl+F5 |

## 开发者

- `lib/index.js` —— Host 半区，注册 `archivedSessions` 远程服务（`list` / `preview` / `restore` / `deleteSession`）。
- `lib/client.js` —— Client 半区，web 模块加载器格式，注册设置页的「归档会话」入口。
- `cordis.patch.yml` —— bundle 层注册行（id: `archived-sessions`）。

归档集合存在 workspace 存储域（version 2）的 `archivedSessionIds` 字段里；删除通过 Host 的 `shell` 服务执行平台命令。改完源码：Host 重启 DSH，Client 刷新页面，全程无需构建。

## 更新日志

### v1.3.7
- 迁移：对齐 DSH `0.1.7-rc.1`（自 `0.1.7-alpha.2`）。逐包比对原始产物：`@deepseek-ai/dsh-typert-protocol`（`Remote` / `TypertRemoteService`，含本插件手工 decorator-context 写法）、`@deepseek-ai/dsh-client-modules`（`clientPath()`、`__ModuleLoader__.load({id,factory})`）、以及本插件探测的 6 个 host 服务（`sessionQuery` / `sessionPersistence` / `storageDomain` / `workspaceRegistry` / `sessions` / `shell`）在 `alpha.2 → rc.1` 之间**逐字节未变**，因此无需改接口代码。peer 对齐 `^0.1.7-rc.1`。
- 修正注释（非兼容性改动）：`shell.run(spec)` 在 `0.1.5-rc.2 → 0.1.7-rc.1` 之间**从未存在** —— 抽象 `ShellExecutor` 与 4 个执行器都只有 `execute(spec)`，`ShellExecSpec` 也没有 `foreground` 字段（“前台”指 await 返回的 `ShellExecution.result()`）。原注释声称「0.1.7 把 `run` 改名成 `execute`」与原始产物不符；`run` 分支保留为不可达的防御代码并如实标注，行为零变化。
- 验证：隔离 `DSH_HOME` 冷启动 rc.1 → 本插件在宿主 `__DSH_BOOT__` 中已注册、客户端产物 HTTP 200 且含 `__ModuleLoader__.load`；`node --check` 通过。

### v1.3.6
- 修复：DSH 0.1.7 起 Remote namespace 挂载失败（strict codec 必须带 `create()` 工厂），「归档会话」取不到数据；`strictCodec()` 改为提供 `create`。
- 修复：删除会话报 `shell.run is not a function`。宿主 shell 服务在 0.1.7 把 `run(spec)` 改成 `execute(spec)` → `ShellExecution`，前台结果改由 `result()` **方法**给出（不再是属性）。现优先走 `execute()`、回退 `run()`；并补上超时/中断判定（它们以 `exitCode: null` **resolve**，旧判断看不见，会把没跑成的删除当成成功）。peer 对齐 `^0.1.7-alpha.2`。

### v1.3.5
- 新增：会话有子会话时，删除确认框给出两个选项——「仅删父会话」与「连同 N 个子会话一起删除」。级联删除整棵子会话树（叶子优先，父会话最后），仍在运行的子会话及其下级会跳过并在结果里说明。
- 安全：级联与单删共用同一套路径校验（目录名必须等于会话 ID、必须含规范的世代文件名）；任一目录删除失败或删除后仍存在都会中止，不会留下半删的持久记录。

### v1.3.4
- 新增：卡片上显示「会话 ID」，删除确认框里再显示一次；标题、工作区目录名、会话 ID、界面显示的标题，输入任意一个都能通过确认。
- 变更：有子会话不再直接拒绝。第一次删除会返回子会话数量并要求二次确认；确认后只删除父会话，子会话的日志独立，会保留（仅失去父会话关联）——此前这条路径是死结，因为该页面只能看到归档会话，而子会话通常没有归档、也没有别的删除入口。

### v1.3.3
- 修复：删除确认不再因为「读不到持久化标题」而死锁。部分归档会话是旧格式（v0）日志，当前 DSH 拒绝迁移读取，宿主读标题时会直接抛 `SessionFormatUnsupportedError`，旧代码把它当成不可恢复的错误（重试永远不会成功）。现在读不到标题就退回到「工作区目录名 / 会话 ID / 界面显示的那串标题」，接受其中任意一个。
- 变更：界面把显示的标题一起发给宿主，所以「复制界面上的标题」一定能通过确认；确认失败时提示里会列出所有可输入的值。

### v1.3.2
- 适配 DSH 0.1.5-rc.2：`SessionPersistence.listSnapshots()` 已从接口中移除，改用 `list()` / `stat()`，消息数恢复按 revision 缓存；永久删除改用公开的 `resolveCurrentLog(id)`，并接受带格式版本号的文件名（`session.v3.jsonl.zstd`）——此前输入标题后必定删除失败。
- peer 依赖对齐 `@deepseek-ai/dsh-typert-protocol ^0.1.5-rc.2`。

### v1.3.1
- 修复：回退路径下消息数永不更新（每次列举都生成唯一 revision，缓存不再被钉死）。

### v1.3.0 及更早
- **v1.3.0**：适配 DSH 0.1.2-rc.1；修复删除确认面板报错、确认门死锁、fork 继承的消息被多算。
- **v1.2.1**：删除命令按平台分支（非 Windows 也能删）；恢复后侧边栏立即刷新；确认失败时回显期望标题。
- **v1.2.0**：删除时拦截运行中的会话与子会话；删除前做路径校验、删除后做持久化验证。
- **v1.1.0**：消息数改为后台统计并按日志 revision 缓存。
- **v1.0.0**：初版（列表 / 预览 / 恢复 / 删除）。

## License

MIT
