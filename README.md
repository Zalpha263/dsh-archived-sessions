# dsh-archived-sessions

> 在 DSH 的设置面板里管理已归档的会话：查看它们、把误归档的会话恢复回原工作区，或者彻底删除。

## 它做什么

**查看**：打开「设置 → 归档会话」就能看到归档列表，而且列表是秒开的——它不解析会话日志，只读归档记录，因此标题、来源工作区与最后活跃时间（绝对时间戳）立刻可见；消息数由后台统计并按照日志 revision 缓存，不会因为反复打开列表而重复解析。

**恢复**：点恢复会移除归档记录，会话回到原来工作区的位置，侧边栏随即刷新。

**删除**：删除是彻底的——日志目录、工作区归属与归档记录三处一起清理，删除前会拦截仍有子会话的归档，删除后会验证日志确实已经消失（验证失败同样中止，避免会话「复活」）；确认时需要输入会话标题，确认值取「持久化标题 → 工作区目录名 → 会话 ID」这条链，当会话摘要缺失时界面会提示你确切应该输入什么。日志目录的删除命令按平台自适应（Windows 用 PowerShell，macOS / Linux 用 `rm -rf`）。

## 已知限制

- **位于内存中的会话无法删除**：如果某个归档会话在本次运行中被打开过，删除文件后它的持久化写入链会把日志重新写回去，表现为「删了又回来」。界面会把这类会话明确标记为「无法删除 · 位于内存中」，重启 DSH 后即可正常删除。
- **删除确认需要输入标题**：这是为了防误删；提示文案与宿主校验共用同一条取值链，因此不会出现「看起来输对了却永远匹配不上」的情况。

## 安装

```bash
# 发布态（推荐：钉死提交）
dsh plugin --profile web add github:Zalpha263/dsh-archived-sessions#<完整40位commit>

# 开发态（本地源码目录，必须带 file: 前缀）
dsh plugin --profile web add file:D:/DeepseekPlugin/dsh-archived-sessions
```

开发态要注意两点：pnpm（`nodeLinker: hoisted`）在 profile 的 `node_modules` 里生成的是**真实副本**，裸路径会被记成 `link:` 生成 junction，启动时会报 `ERR_MODULE_NOT_FOUND`，所以必须用 `file:` 前缀；而 pnpm 的 `install` / `update` 不会刷新这个副本（实测提示 "Already up to date"），改完源码需要先 remove 再 add 强制重新打包：

```bash
dsh plugin --profile web remove dsh-archived-sessions
dsh plugin --profile web add file:D:/DeepseekPlugin/dsh-archived-sessions
```

之后 Host 改动重启 DSH，仅 Client 改动硬刷新（Ctrl+F5）即可。

## 验证

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
node --input-type=module -e "const m = await import('dsh-archived-sessions'); console.log(typeof m.apply)"
# 输出 function 即安装成功
(Invoke-WebRequest http://127.0.0.1:3080/).Content -match 'dsh-archived-sessions'   # 重启后 manifest 含包名
```

## 架构

- `lib/index.js` —— Host 半区，注册 `archivedSessions` 远程服务（`list` / `preview` / `restore` / `deleteSession`）
- `lib/client.js` —— Client 半区，web 模块加载器格式，注册 `settings.section` 入口
- `cordis.patch.yml` —— bundle 层注册行（id: `archived-sessions`）

## 更新日志

### v1.3.1
- 修复：回退路径下消息数永不更新（每次列举都生成唯一 revision，缓存不再被钉死）。

### v1.3.0
- 变更：适配 DSH 0.1.2-rc.1 —— 设置页槽位改为直读客户端服务，资源挂到 `ctx.effect` 纤维所有权，清理幽灵依赖声明。
- 修复：删除确认面板引用未定义函数导致点击即报错；确认门与宿主期望值不一致时死锁；fork 继承的消息前缀被错误计入消息数。

### v1.2.1
- 修复：日志目录删除命令按平台分支，非 Windows 也能删除。
- 修复：恢复会话后侧边栏立即刷新；确认失败时回显期望的标题。

### v1.2.0
- 新增：删除时拦截运行中的会话与子会话；删除前路径校验、删除后持久化验证。

### v1.1.0
- 新增：消息数后台统计（按日志 revision 缓存）。

### v1.0.0
- 初版：列表 / 预览 / 恢复 / 删除。

## License

MIT
