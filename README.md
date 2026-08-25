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

- **v1.2.1**：跨平台删除（日志目录删除命令按平台分支，Windows 用 PowerShell、macOS/Linux 用 `rm -rf`——此前硬编码 PowerShell 导致非 Windows 无法删除）；恢复会话后侧边栏立即刷新（与文档承诺一致）；删除确认失败时回显期望的标题值，且确认界面提示应输入的内容。
- **v1.2.0**：删除时拦截运行中的会话（防止日志复活）与子会话；删除前路径校验 + 删除后持久化验证。
- **v1.1.0**：消息数后台统计（按日志 revision 缓存，避免重复解析）。
- **v1.0.0**：初版（列表 / 预览 / 恢复 / 删除）。
