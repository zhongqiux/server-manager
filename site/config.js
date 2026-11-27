// 发布前只需要改这一个文件。
// downloads 填入 GitHub Release 资产直链，留空时对应按钮显示为待发布。
window.SM_SITE = {
  downloads: {
    windows: 'https://github.com/zhongqiux/server-manager/releases/latest/download/ServerManager-windows-x64.exe',
    macArm64: 'https://github.com/zhongqiux/server-manager/releases/latest/download/ServerManager-macos-arm64.tar.gz',
    macX64: 'https://github.com/zhongqiux/server-manager/releases/latest/download/ServerManager-macos-x64.tar.gz',
    mcp: 'https://github.com/zhongqiux/server-manager/releases/latest/download/ServerManager-mcp.zip',
  },
  checksumsUrl: 'https://github.com/zhongqiux/server-manager/releases/latest/download/SHA256SUMS.txt',
  version: 'v0.1.1',
  size: 'Windows 约 97 MB · macOS 约 41 MB',
  os: 'Windows 10 / 11 · macOS（ARM / Intel）',
};