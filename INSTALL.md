# 安装 / 卸载

## 一键安装（Windows）

```powershell
# 桌面端（DeepSeek Harness Desktop）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop

# Web 端（dsh web）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web
```

安装完**退出并重新打开 DeepSeek Harness**。桌面端在启动时缓存 index 注入表，只刷新页面不会加载新脚本；Web 端重启一次 `dsh web` 后刷新页面。

安装脚本做四件事：

1. 建 `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-audio-player` 目录联接；
2. 桌面端向 profile 的 `cordis.patch.yml` 追加 `insert` 行（DSH 会热加载）；
3. Web 端向 `dsh.profile.bundles` 追加 `dsh-audio-player`；
4. 在 profile 的 `package.json` 里登记 `file:` 依赖，防止 pnpm 之后清理 `node_modules`。

## 目录

| 内容 | 路径 |
|---|---|
| 插件 | `%USERPROFILE%\.dsh\plugins\dsh-audio-player\` |
| 音频 | `%USERPROFILE%\.dsh\dsh-audio-player\tracks\` |
| 设置 / 曲库 | `%USERPROFILE%\.dsh\dsh-audio-player\config.json` · `library.json` |

## 手动安装（桌面端）

1. 把整个插件目录放到任意固定位置（本机是 `C:\Users\admin\.dsh\plugins\dsh-audio-player`）。
2. 让 profile 能解析到它（目录联接或复制）：

   ```cmd
   mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-audio-player" "C:\Users\admin\.dsh\plugins\dsh-audio-player"
   ```

3. 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: dsh-audio-player
         name: dsh-audio-player
   ```

4. 退出并重新打开 DSH。

> 不要同时把插件写进 `dsh.profile.bundles` 和 `cordis.patch.yml`，否则会注册两次、路由冲突。桌面端本插件只走 patch insert。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Profile desktop
```

只移除安装登记与联接，保留 `~/.dsh/dsh-audio-player/` 下的音频和设置；需要彻底清理时手工删除该目录。

## 验证

重启后右下角应出现「音频播放器」悬浮窗。没有的话：

- 看 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里有没有 `dsh-audio-player`；
- 看 `node_modules\dsh-audio-player\lib\index.js` 是否存在；
- 看 DSH 日志是否有 `[dsh-audio-player]` 开头的报错；
- 确认没有重复登记（bundle + patch）。
