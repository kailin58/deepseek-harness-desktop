# DeepSeek Harness 桌面版

Electron 外壳：把 **内置的 DeepSeek Harness（dsh）本地服务** 封装成一个可分发、一键安装、能自动监控 GitHub 更新的桌面应用。

## 它做什么
- 启动 / 复用内置 `dsh --profile web` 本地服务（默认 `127.0.0.1:3080`）
- 在原生窗口里加载该 Web UI（含已装的 modlens / better-sidebar 插件）
- 关闭窗口时自动回收 dsh 子进程
- 首次运行引导填写 DeepSeek API Key（仅存本机用户目录，不外发）
- 自动监控 GitHub Releases，发现新版本弹「更新提醒」，确认后下载、重启安装

## 两种运行模式（harnessMode）
| 模式 | 说明 | 适用 |
| --- | --- | --- |
| `auto`（默认） | 打包后优先用内置 bundle，否则回退本机 dsh | 开发 & 分发通用 |
| `bundled` | 强制用内置 bundle（`<resources>/harness`） | 分发出去的安装包 |
| `system` | 强制用本机已装 dsh（`harnessDir`） | 开发调试复用本机环境 |

## 目录结构
```
deepseek-harness-desktop/
├─ main.js              # 主进程：启动/回收 dsh、Key 录入、自动更新
├─ preload.js           # 渲染进程桥接
├─ splash.html          # 启动加载页 / 错误页
├─ key.html             # 首次运行 Key 录入页
├─ config.json          # 配置（端口 / 模式 / 更新源）
├─ bundle-harness.js    # 打包脚本：把可独立运行的 dsh 复制进 build-resources
├─ build-resources/
│  └─ harness/          # 由 bundle-harness.js 生成（node.exe + node_modules + dsh-home）
└─ dist/                # electron-builder 产物（安装包）
```

## 配置 config.json
| 字段 | 含义 |
| --- | --- |
| `harnessMode` | `auto` / `bundled` / `system` |
| `harnessDir` | system 模式下的 dsh 安装目录 |
| `port` / `host` | 本地服务地址 |
| `autoStart` | 是否自动拉起 dsh |
| `update.owner` / `update.repo` | **GitHub 仓库坐标**，填好后才会启用自动监控与更新提醒 |
| `update.autoCheck` | 是否启动即检查更新 |
| `update.checkIntervalMinutes` | 后台轮询间隔（默认 60） |

## 一键安装 + 分发（Phase 2）
安装包内置 Node + dsh + 你的 `.dsh` profile，**用户端无需预装任何东西**。

```bash
npm install            # 安装 electron / electron-builder / electron-updater
npm run bundle         # 生成 build-resources/harness（内置 dsh，较慢，仅在需要刷新内置 dsh 时执行）
npm run dist           # 打包为安装包（electron-builder，不再重复 bundle）
```
> `dist` 脚本已拆成两步：`bundle` 只负责把内置 dsh 复制进 `build-resources/harness`，
> `dist` 只负责打包。这样重打包时不会每次都重拷 3 万多个 node_modules 文件（在机械/慢盘上会卡很久）。
产物：`dist/DeepSeek Harness Setup *.exe`（NSIS 一键安装，每用户安装，自动建桌面快捷方式）。
把该 exe 发给同事/工厂即可，双击安装。

### 打包前须知
1. 先确保本机已安装 dsh 及其前端，标准位置为 `~/deepseek-harness`（dsh launcher）
   与 `~/.dsh`（profiles）。若不在主目录下，可用环境变量覆盖：
   `DSH_SRC`（dsh 前端目录）、`DSH_HOME_SRC`（`.dsh` 目录）、`NODE_SRC`（要内置的 node.exe）。
2. `bundle-harness.js` 会复制：
   - 内置 Node：`node.exe`
   - dsh launcher：`deepseek-harness/node_modules`
   - 你的全套 profile（含 modlens / better-sidebar）：`.dsh`
3. **API Key 不会被打进包**——安装包不含任何 `.env`，首次运行由用户自己录入并存到
   `%APPDATA%/deepseek-harness-desktop/.env`（仅本机）。

## 自动更新（自动监控 GitHub）
基于 `electron-updater` + GitHub Releases：
1. 把应用发布到 GitHub Releases（`npm run dist` 后手动上传 `dist/*.exe`，或用 `gh release create`）。
2. 在 `config.json` 填好 `update.owner` / `update.repo`；并同步把 `package.json` 的
   `build.publish[0].owner` 改成同一值（CI 工作流会自动替换占位符，手动发布需手改）。
3. 已安装的用户启动时会自动轮询该仓库 Releases：
   - 发现新版本 → 弹「更新提醒」对话框，用户确认后下载；
   - 下载完成 → 弹「重启安装」提示，重启即生效。
4. 菜单「帮助 → 检查更新」可手动触发。

> 若不想用 GitHub，可把 `config.json` 的 `update` 改为
> `{ "provider": "generic", "url": "https://你的静态服务器/latest/" }`，
> 并在该 URL 下放置 `latest.yml` 与安装包（详见 electron-updater 文档）。

## API Key 原则（重申）
- Key **只存本机用户目录**，由首次运行录入页写入。
- 绝不进入安装包、绝不上传、绝不进仓库。
- 开发机便利：若本机 `harnessDir/.env` 已配 Key，首次运行会自动迁移，免重复填写。

## 发布到 GitHub（开源分发）
仓库需为 **Public**，且 `package.json` 的 `build.publish` 与 `config.json` 的 `update` 中的
`owner` 必须是真实 GitHub 用户名/组织（当前为占位符 `REPLACE_WITH_GITHUB_OWNER`）。

### 手动发布（一次性）
1. 在 github.com/new 建仓库 `deepseek-harness-desktop`（Public，不要勾选初始化文件）。
2. 本地 `git init` 并提交（见 `.gitignore`：`node_modules` / `build-resources` / `dist` 均不入库）。
3. `git remote add origin https://github.com/<你的用户名>/deepseek-harness-desktop.git` 并 `git push -u origin main`。
4. 本地 `npm run bundle && npm run dist` 生成安装包，再
   `gh release create v0.1.0 "dist/DeepSeek Harness Setup 0.1.0.exe"` 上传到 Releases。
   从这一刻起，已安装用户会自动轮询并收到更新提醒。

### 自动发布（GitHub Actions）
仓库已内置 `.github/workflows/release.yml`：推送 `v*` tag 时自动
`npm ci` → `npm run bundle` → `npm run dist --publish always`，并把安装包作为 Release 资产发布。
`REPLACE_WITH_GITHUB_OWNER` 占位符在构建时自动替换为当前仓库 owner（`github.repository_owner`），无需手改。

> ⚠️ **隐私提示**：`npm run bundle` 会把开发者本机的 `~/.dsh`（含个人 profile、聊天历史等）
> 复制进 `build-resources/harness`，最终打进安装包。对外公开发布前务必确认其中不含敏感信息；
> 真正开源分发建议改为「安装时拉取 dsh」而非内置开发者个人环境（后续重构项）。

## 备注
- 启动日志前缀 `[dsh]` / `[updater]` 可在开发者控制台查看（菜单 → 帮助 → Toggle DevTools）。
- 端口被占用或 dsh 未正确打包时，会弹出错误提示。

## 关于 Electron 版本
- `package.json` 中 `electron` 锁定为 **30.5.1**，与本机已安装的 Electron 运行时一致
  （`node_modules/electron/dist/electron.exe` 即 30.5.1）。注意：`electron@20.16.0` 在 npm 上
  **并不存在**（404），切勿写回该版本号，否则 `npm install` 会报 ETARGET。
- `electron-updater` 使用 **6.8.9**（与 Electron 30 兼容）。注意：dsh 的
  `healProfilesModuleFallback` 在每次启动时为 `profiles/node_modules` 重建 junction，
  故 bundle 中无需、也不能打包该目录（`bundle-harness.js` 已排除）。
- 升级 Electron 大版本：改 `package.json` 的 `electron` 与 `electron-builder` 约束后从干净源重装。
- `build.electronDist` 已指向本机 `node_modules/electron/dist`，打包时**复用已安装的 Electron**，
  不再从 GitHub 重新下载 100+ MB 运行时（在慢网下能省大量时间）。若换 Electron 版本，记得同步更新该路径。

## 常见排错
- **安装后启动白屏/连不上服务**：多为 `.dsh` 未随包复制完整，或首次运行 Key 未填。
  看 DevTools 控制台 `[dsh]` 日志。
- **更新检查报 404**：确认 `update.owner/repo` 正确且仓库已发 Release。
- **打出来的包太大**：内置了完整 node_modules，属正常；如需瘦身可后续做 dsh 的依赖精简。
