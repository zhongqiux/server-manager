科研 GPU 调度台 · MCP 服务（可选）
=================================

这是给 AI Agent（Qoder / Claude Desktop 等）使用的 MCP stdio 服务，
不是桌面主程序的一部分。主程序安装包见 Release 中的 Windows / macOS 版本。

运行要求
--------
- Node.js 22.18 或更高版本（https://nodejs.org）
- Server Manager 主程序已启动（桌面版或 npm start）

快速开始
--------
1. 解压本压缩包到任意目录，例如 ~/tools/server-manager-mcp
2. 确认目录中存在 index.js
3. 在 MCP 客户端中添加配置（格式见同目录 mcp-config.example.json）：
     command: node
     args:    ["<解压目录>/index.js"]
     env:     SM_MCP_BASE_URL=http://127.0.0.1:8787
4. 重启 MCP 客户端，即可看到 server-manager 的 24 个工具

环境变量
--------
SM_MCP_BASE_URL      Server Manager 服务地址；不填则自动探测 127.0.0.1:8787–8806
SM_MCP_TIMEOUT_MS    REST 请求超时，默认 30000
SM_MCP_READ_ONLY     设为 1 时隐藏并拒绝 start_sync / cancel_sync / start_job / stop_job

安全默认值
----------
- start_sync 默认 dry-run；真实同步需显式 dryRun=false
- 不提供密码/私钥的读取或写入工具
- start_job 默认新建独立会话，不触碰已有 tmux / screen 会话