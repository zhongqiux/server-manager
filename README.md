# Server Manager · 科研多 GPU 服务器调度台

本地运行的 Web 应用（127.0.0.1，单用户，无登录），用于统一管理多台异构 GPU 服务器：

- **服务器管理**：密码 / 私钥认证（AES-256-GCM 加密入库），连接测试、硬件快照、GPU 实时状态
- **项目与目标**：一个项目可绑定多台服务器（Target），各自的代码目录、数据目录、conda 环境、GPU 设备、运行命令模板
- **代码同步**：自研 SFTP 增量同步（dry-run / 镜像删除 / A→B 中转）+ Git 中心仓库模式（commit / push / clone / ff-only 合并）
- **任务运行**：三种方式——新建独立会话（tmux / screen / nohup 自动降级）、在远程已有 tmux / screen 会话中新开窗口、或向已有窗口注入命令；断连不中断，实时日志（SSE 断线续传不重不漏），五步式优雅停止，且永不关闭用户已有会话/窗口
- **GPU 看板**：nvidia-smi 双查询（指标 + 计算进程按 uuid 关联），订阅驱动的轮询，多标签页去重

核心闭环：本地或任一服务器上改完代码 → 一键增量同步到任一台目标机 → 用该机环境配置运行 → 实时看日志与 GPU 状态 → 随时切换到另一台。

---

## 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | >= 22.18（开发与打包实测 v22.19.0） |
| npm | 10.x（随 Node 附带即可） |
| 操作系统 | 开发：Windows / macOS / Linux；单文件构建：Windows x64 / macOS arm64、x64 |
| 远端服务器 | Linux，SSH 可达；建议安装 tmux 或 screen（自动模式二者都无时降级 nohup）；Git 模式需 git |

数据存储在本地 SQLite（`node:sqlite`，实验性 API，启动时已屏蔽对应 ExperimentalWarning）。

---

## 快速开始（开发模式）

```bash
npm install
npm run dev
```

- 前端 Vite：http://127.0.0.1:5173 （`/api` 代理到后端）
- 后端 API：http://127.0.0.1:8787
- `dev` 会并行启动 shared 类型 watch、服务端 watch、前端 dev server

## 生产构建与本地运行

```bash
npm run build     # shared tsc → server tsc → web vite build
npm start         # 单端口 8787 托管 API + 前端静态站点
```

浏览器访问 http://127.0.0.1:8787 。SPA 子路由刷新不会 404（服务端有 fallback 中间件，`/api` 不受影响）。

## 任务运行与会话选择

创建任务时可选择三种方式：

| 模式 | 行为 | 任务结束/停止后 |
|---|---|---|
| 新建独立会话 | 按 tmux → screen → nohup 自动选择并创建 | 关闭本工具新建的会话（Target 开启 `keep_session` 时保留） |
| 已有会话 · 新窗口 | 从远程已有 tmux / screen 会话中选择，新建一个专属窗口运行任务 | 只关闭本工具新建的窗口，会话本身保留 |
| 已有会话 · 已有窗口 | 向所选窗口直接注入启动命令 | 永不关闭会话或窗口；停止只发送 Ctrl-C 并终止任务进程组 |

- 运行面板会读取目标服务器上的 tmux 会话/窗口与 screen 会话/窗口（`GET /api/servers/:id/sessions`），支持手动刷新；会话与窗口列表不会缓存到数据库。
- 选择已有窗口时会展示窗口当前前台命令：tmux 仅当前台为 shell 时允许注入；screen 无法可靠探测，必须勾选“确认窗口空闲”才能运行。
- 已有窗口注入由 `~/.server_manager/jobs/<id>.go` 闸门文件保护：8 秒内未开始执行（窗口正忙）就删除闸门，排队命令变为空操作，不会稍后误执行。
- 任务脚本启动时把 PID 与 PGID 写入 `~/.server_manager/jobs/<id>.pid`，停止流程只终止该进程组；已有会话与窗口不受影响。
- 演示模式同样提供模拟会话（A100 的 `protein` / `af2`、4090 的 `lab`、云端的 `autodl`），可直接体验三种方式。

## 演示模式（无需真实服务器）

`SM_DEMO=1` 启动时载入一套固定的合成数据：3 台异构服务器（A100×2、RTX 4090、云上 4×3090）、2 个项目、4 个 Target、5 条任务（运行中 / 完成 / 失败 / 已停止各状态）、4 条同步记录。GPU 利用率与显存按正弦曲线波动，运行中任务日志每 5 秒追加一行；连接测试、硬件探测、任务启动/停止、同步进度均为本地模拟，**不会发起任何 SSH/SFTP 连接**。

```powershell
# PowerShell（推荐用独立数据目录，避免污染真实数据）
$env:SM_DEMO='1'
$env:SM_DATA_DIR="$env:TEMP\sm-demo"
npm start          # 或 npm run dev
```

```bat
:: cmd
set SM_DEMO=1
set SM_DATA_DIR=%TEMP%\sm-demo
npm start
```

```powershell
# 打包版 exe（配合 --portable，数据写在 exe 同目录 data\）
$env:SM_DEMO='1'
.\release\ServerManager.exe --portable
```

```bash
# macOS 打包版
SM_DEMO=1 ./release/ServerManager --portable
```

- 演示数据只插入一次（数据库 settings 中记录 `demo.seed.v1`）；重复启动不会重复添加。
- 去掉 `SM_DEMO` 即回到真实模式；演示记录可像普通记录一样删除，删除服务器/项目会级联清理关联 Target 与任务。
- 想彻底重置：换一个空的 `SM_DATA_DIR`（或删除该目录下的 `server_manager.db`）再启动。
- 演示记录与真实数据可以共存；模拟逻辑只对 ID 以 `d0d0d0d0-` 开头的记录生效。

### 演示走查（8 步）

1. **总览**：在线 3/3、空闲 GPU 5/7、运行中任务 2，卡片墙实时波动。
2. **服务器** → `A100 双卡实验机` → 连接测试与硬件快照（合成时间线）。
3. **项目** → `AF2 蛋白质结构训练` → 扫描文件数与忽略规则。
4. **Target 工作台** → 查看渲染后的命令/脚本与路径变量。
5. **同步**：先 dry-run 看计划，再真跑观察进度与历史记录。
6. **任务** → 新建任务时切换到“使用已有 tmux / screen 会话”，体验新开窗口或在已有窗口注入（演示含 `protein` / `lab` / `autodl` 会话）；再打开运行中任务看实时日志（SSE）。
7. **停止任务** → 五步停止时间线与退出码（合成）。
8. 回到总览/服务器页确认 GPU 与任务状态已随之更新。

## 其他脚本

```bash
npm run typecheck   # 前后端类型检查
npm test            # vitest 单元测试（diff 判定、忽略规则、模板渲染、任务会话命令、远程会话解析、git 参数等）
npm run mcp         # 构建后启动 MCP stdio 服务（供 agent 接入，见下节）
```

---

## MCP 服务（接入 agent）

`packages/mcp` 提供一个独立的 **stdio MCP 服务**，作为本地 REST API 的薄客户端：不复制业务逻辑、不改动现有服务端，也不读写服务器凭据。agent 通过它完成「查看资源 → 预检 → 同步 → 运行 → 读日志」的闭环。

**前置**：应用正在运行（开发模式 `npm start`，或已打开的 `ServerManager.exe`）；MCP 进程本身需要 Node.js，未打包进 exe。

```bash
npm run build       # 首次使用需构建（会产出 packages/mcp/dist/index.js）
npm run mcp         # 启动 MCP stdio 服务
```

在 MCP 客户端（Qoder / Claude Desktop 等）中注册，`args` 换成仓库绝对路径：

```json
{
  "mcpServers": {
    "server-manager": {
      "command": "node",
      "args": ["D:\\code\\server_manager\\packages\\mcp\\dist\\index.js"],
      "env": { "SM_MCP_BASE_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

不设 `SM_MCP_BASE_URL` 时会自动探测 `127.0.0.1:8787–8806` 的第一个健康实例；本机同时运行多个实例时建议显式指定。

| 变量 | 默认 | 说明 |
|---|---|---|
| `SM_MCP_BASE_URL` | 自动探测 | Server Manager 服务地址（只接受 origin） |
| `SM_MCP_TIMEOUT_MS` | 30000 | REST 请求超时 |
| `SM_MCP_READ_ONLY` | 未开启 | `1` 时隐藏并拒绝 `start_sync` / `cancel_sync` / `start_job` / `stop_job` |

**工具（24 个）**

| 分组 | 工具 |
|---|---|
| 总览 | `get_overview` |
| 服务器 | `list_servers`、`get_server`、`test_server`、`probe_server`、`list_remote_sessions` |
| 项目 | `list_projects`、`get_project`、`scan_project`、`explain_ignore` |
| Target | `list_targets`、`get_target`、`preview_target` |
| 同步 | `list_sync_runs`、`get_sync_run`、`wait_sync`、`start_sync`、`cancel_sync` |
| 任务 | `list_jobs`、`get_job`、`read_job_logs`、`wait_job`、`start_job`、`stop_job` |

另有资源 `sm://dashboard`、`sm://servers`，以及 prompts `find_idle_gpu`、`run_experiment`、`diagnose_job`。

**安全默认值**

- `start_sync` 默认 **dry-run**，只返回 add/update/delete 计划；真实同步必须显式传 `dryRun=false`
- Target 开启镜像删除时，真实同步还必须传 `confirmTargetName`（目标 label，未设置时为服务器名）
- 不提供任何密码/私钥的读取或写入工具；Target 环境变量值、Git URL 凭据与预览脚本中的密钥均脱敏
- `start_job` 默认 `sessionMode=new`，不会触碰用户已有 tmux/screen 会话；使用已有会话需先 `list_remote_sessions`
- 任务日志按原文返回（可能含敏感信息），工具描述中已提示不要外传

---

## 宣传页（site/）

`site/` 是零依赖的产品宣传单页（原生 HTML / CSS / JS，无外部字体与 CDN），可直接双击 `site/index.html` 预览，也可以原样托管到 GitHub Pages 或任意静态服务器。

发布前只需修改 `site/config.js`：

- `downloads.windows` / `downloads.macArm64` / `downloads.macX64`：填入对应平台的直链（默认指向本仓库 `releases/latest/download/` 下的固定资产名）；留空的平台按钮会显示为待发布并滚动回下载区
- `checksumsUrl`：可选，填入后下载区展示 `SHA256SUMS.txt` 校验链接
- `version` / `size` / `os`：下载区展示的版本信息；`size` 建议按 Release 实际产物更新
- 兼容旧字段 `downloadUrl`：仅在 `downloads.windows` 为空时作为 Windows 下载地址使用

页面截图位于 `site/assets/`，均来自演示模式的真实界面。更新二进制后，请同步更新 `config.js` 与本文档的构建记录。

---

## 打包与发布（Windows / macOS）

单文件构建必须在目标系统上执行（SEA 直接注入当前 `node` 可执行文件，不支持交叉打包）：

```bash
npm run dist        # 当前平台；Windows 输出 release/ServerManager.exe，macOS 输出 release/ServerManager
```

`npm run dist:win` / `npm run dist:mac` 是同一命令的别名。构建链：

1. esbuild 将服务端（含 shared）打成单 CJS bundle（`ssh2` 的可选原生依赖 `*.node` / `cpu-features` 置为 external）
2. `node --experimental-sea-config` 生成 SEA blob，前端 `packages/web/dist` 全部作为资源内嵌（带 asset manifest，Node 22 无 `getAssetKeys()`）
3. 复制构建所用的 `node` 可执行文件并注入 `NODE_SEA_BLOB`
   - Windows：先用 Windows SDK 的 `signtool remove` 剥离 Node 官方签名（否则 postject 注入会因签名段校验失败）
   - macOS：先 `codesign --remove-signature`，注入 `NODE_SEA` 段后执行 ad-hoc 签名（`codesign --sign -`）并用 `codesign --verify` 校验

构建要求：Node >= 22.18；Windows 需要 `signtool.exe`（Windows SDK，`Program Files (x86)\Windows Kits\...` 或 PATH）；macOS 需要 Xcode Command Line Tools（`codesign`）。若代码缓存生成失败，脚本会自动退回 `useCodeCache: false` 重试。

### GitHub Actions 自动发布

[release.yml](.github/workflows/release.yml) 会在三个原生 runner 上分别构建：

| 平台 | 产物 |
|---|---|
| Windows 10 / 11 x64 | `ServerManager-windows-x64.exe` |
| macOS Apple Silicon | `ServerManager-macos-arm64.tar.gz` |
| macOS Intel | `ServerManager-macos-x64.tar.gz` |

- **手动运行**（Actions → Build desktop release → Run workflow）：只构建并上传 workflow artifacts，不创建 Release，可用于干跑。
- **推送 `v*` tag**：构建、冒烟测试通过后创建 GitHub Release，附 `SHA256SUMS.txt`：

```bash
git tag v0.1.0
git push origin v0.1.0
```

当前发布：[v0.1.0](https://github.com/zhongqiux/server-manager/releases/tag/v0.1.0)，含 Windows x64（约 97 MB）、macOS arm64 / x64（压缩包各约 41 MB）与 `SHA256SUMS.txt`。

> 签名说明：Windows exe 未做 Authenticode 签名，SmartScreen 会提示“未知发布者”；macOS 为 ad-hoc 签名、未公证，首次打开需右键“打开”，或执行 `xattr -dr com.apple.quarantine ServerManager`。

### 本地 Windows 构建记录

| 项目 | 值 |
|---|---|
| 体积 | **84.3 MB（88,438,272 字节）** |
| SHA256 | `e67c48c19e9c33312c3c39ecea45f21260a012c4bc96ae23fa9266603324e6db` |
| 构建 Node | v22.19.0 |

GitHub Release 由 CI 使用 Node 24 构建，哈希以 Release 附带的 `SHA256SUMS.txt` 为准。本地校验：`certutil -hashfile ServerManager.exe SHA256` 或 `Get-FileHash`。

### 运行行为

- 启动后在本机提供服务并**自动打开默认浏览器**；终端窗口保留用于显示日志
- 数据目录：
  - Windows：`%LOCALAPPDATA%\ServerManager\data\`
  - macOS：`~/Library/Application Support/ServerManager/data/`
  - `--portable`：数据落在**可执行文件同目录的 `data/`**，适合放 U 盘携带
  - 环境变量 `SM_DATA_DIR` 可显式指定任意目录
- 单实例：启动先探测 `http://127.0.0.1:8787/api/health`，已在运行则只打开浏览器并退出
- 端口：`SM_PORT` 或 `--port <n>` 指定起始端口；被占用时自动向后尝试最多 20 个端口
- 其他命令行参数：`--open` 强制打开浏览器；`SM_OPEN=0` 禁止自动打开；`--portable` 见上
- 重启后服务器、项目、任务历史全部保留在数据目录

---

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SM_PORT` | 8787 | 起始端口（被占用自动递增） |
| `SM_DATA_DIR` | 开发：仓库 `data/`；打包版：Windows `%LOCALAPPDATA%\ServerManager\data`、macOS `~/Library/Application Support/ServerManager/data` | 数据目录 |
| `SM_OPEN` | 打包版默认打开浏览器 | `0` 禁止自动打开；`1` 强制打开 |
| `SM_DEMO` | 未开启 | `1` 时载入演示数据（合成服务器/GPU/任务/日志，不连真实机器；见「演示模式」） |
| `SM_SSH_MAX_CONCURRENCY` | 4 | SSH 全局并发上限 |
| `SM_SFTP_FILE_CONCURRENCY` | 4 | 单目标文件传输并发 |
| `SM_GPU_INTERVAL_MS` | 5000 | GPU 轮询间隔 |
| `SM_LOG_TAIL_BYTES` | 131072 | 任务日志首屏回填字节数 |
| `SM_RELAY_MAX_BYTES` | 2 GiB | A→B 中转临时区上限 |
| `SM_MASTER_KEY_FILE` | `数据目录/keys/master.key` | 主密钥文件路径 |

---

## 目录结构

```
packages/shared/    # 纯类型 + 纯函数（模板渲染、同步 diff、事件协议），前后端共用
packages/server/    # Express 5 API、SQLite、SSH 连接池、同步引擎、任务引擎、GPU Hub
packages/mcp/       # stdio MCP 服务（REST 薄客户端，供 agent 接入）
packages/web/       # React + antd 5 前端（Vite）
site/               # 产品宣传单页（零依赖静态页面，下载链接见 site/config.js）
scripts/build-sea.mjs  # 单文件构建链（Windows / macOS）
scripts/smoke-sea.mjs  # 打包产物冒烟测试
.github/workflows/  # Pages 部署与桌面端 Release 构建
```

## 安全设计

- 凭据仅加密存储于本地 SQLite（AES-256-GCM，AAD 绑定行与字段），API 只返回 `hasPassword`
- 服务只绑定 `127.0.0.1`，并校验 Host 头（抵御 DNS rebinding）
- 所有日志 / SSE / 错误信息脱敏（含 Git URL 中的 token）
- Git 操作永不 force push、永不 reset/stash/clean；目标机工作区脏时中止且零写入
- 镜像删除默认关闭，需输入目标名确认，并有硬黑名单与路径校验

## 常见问题

- **WSL 作为测试服务器**：需安装并启动 sshd（`sudo apt install openssh-server`），首次缺 host key 时执行 `sudo ssh-keygen -A`
- **老服务器缺 `find -printf` / GNU tail**：首次连接会做能力探测并缓存在服务器记录中，自动降级（`stat -c` 或 SFTP readdir；日志 tail 兼容 busybox）
- **Git 模式连不上中心仓库**：目标机需要自备凭据（SSH key 或 credential helper），本工具不向远端下发凭据；所有 git 子进程都设置 `GIT_TERMINAL_PROMPT=0`，需要交互认证会立即失败并回显原因
- **数据迁移**：直接复制整个数据目录（含 `keys/`）到新机器即可，主密钥丢失将无法解密已存凭据