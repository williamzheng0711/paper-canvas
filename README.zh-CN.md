<p align="center">
  <a href="README.md">繁體中文</a> ·
  <strong>简体中文</strong> ·
  <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" height="96" alt="PaperCanvas 应用图标">
</p>

<h1 align="center">PaperCanvas</h1>

<p align="center">
  适合研究笔记、数学内容和技术文档的 Markdown 桌面编辑器。可在可视化画布和 Markdown 源码之间切换，文档以 UTF-8 纯文本保存在本地。
</p>

<p align="center">
  <a href="https://williamzheng0711.github.io/paper-canvas/download/PaperCanvas-Windows-x64-Setup.exe">下载 Windows 版</a>
  ·
  <a href="https://williamzheng0711.github.io/paper-canvas/download/PaperCanvas-macOS-universal.dmg">下载 macOS 版</a>
</p>

版本号与更新内容见 [GitHub 最新发布](https://github.com/williamzheng0711/paper-canvas/releases/latest)。

<p align="center">
  <a href="docs/assets/papercanvas-editor.png">
    <img src="docs/assets/papercanvas-editor.png" alt="PaperCanvas 画布，左侧是文档大纲，右侧是批注栏" width="100%">
  </a>
</p>

## 安装

- **macOS（Intel 和 Apple Silicon）**。打开 DMG，将 PaperCanvas 拖入“应用程序”，再从该文件夹打开。如果 macOS 阻止首次启动，请确认安装包来自上方的下载链接，再到“系统设置”的“隐私与安全性”选择“仍要打开”。
- **Windows 10/11（x64）**。运行安装程序，按提示完成安装，再从“开始”菜单启动 PaperCanvas。如果 SmartScreen 提示发布者未知，请确认安装包来源，再选择“更多信息”和“仍要运行”。

安装后，可以从访达或文件资源管理器中选择用 PaperCanvas 打开 `.md` 或 `.markdown` 文件。

## 编辑与阅读

- **画布 / Markdown**。在画布中直接编辑格式化文字、表格、任务列表和脚注，或切换到带语法高亮和行号的 Markdown 源码。超出画布容量的文档会在 Markdown 模式打开，完整源码仍可编辑和保存。
- **数学公式**。用 `$…$` 输入行内公式。独立公式的前后各用一行 `$$`。在画布中点击公式，即可修改 LaTeX 并查看 KaTeX 实时预览。
- **大纲与搜索**。从左侧的“大纲”跳转到文档标题，或在“最近”中重新打开文档。按 `⌘/Ctrl + F` 可在两种模式下搜索。
- **批注**。在画布中选中文字或放置光标，右键选择“新增批注”。点击工具栏上的对话气泡图标打开批注栏，并定位到原文。
- **阅读设置**。点击工具栏上的 **Aa** 调整字体、字号、行距或切换浅色／深色主题。也可以在这里选择简体中文、繁體中文或 English。

<table>
  <tr>
    <td width="50%">
      <a href="docs/assets/papercanvas-formula-editor.png"><img src="docs/assets/papercanvas-formula-editor.png" alt="LaTeX 公式编辑器和实时预览"></a>
    </td>
    <td width="50%">
      <a href="docs/assets/papercanvas-markdown-source.png"><img src="docs/assets/papercanvas-markdown-source.png" alt="带语法高亮和行号的 Markdown 源码编辑器"></a>
    </td>
  </tr>
  <tr>
    <td>LaTeX 公式编辑</td>
    <td>Markdown 源码模式</td>
  </tr>
</table>

## 保存与导出

- 工具栏右侧的 **⋯** 菜单可新建、打开、保存、另存和重命名文档。已保存的文档会自动保存更改。首次保存前，PaperCanvas 会在本地保留恢复草稿。
- 可以将图片拖入或粘贴到画布，并拖动控制点调整大小。保存 `notes.md` 时，新加入的图片文件可放在相邻的 `notes.assets/` 文件夹。移动或分享文档时，请一并带上相关图片和资源文件夹。
- 批注保存在 Markdown 文件末尾的 HTML 注释中，会随文件一起分享。偏好设置、最近打开的文件列表和恢复草稿也保存在本地。PaperCanvas 无需账号，没有遥测或云端同步。文档中的 HTTPS 图片可能会从原网站加载。
- 在 **⋯** 菜单的“导出”中选择 Markdown 或 PDF。Markdown 会另存为副本。macOS 可直接保存 PDF，Windows 则通过系统打印对话框存为 PDF。

## 从源码运行

使用 Node.js 22（与自动化测试环境相同），并安装 Rust 和操作系统所需的 [Tauri 开发工具](https://v2.tauri.app/start/prerequisites/)。在项目根目录运行以下命令。

```bash
npm ci
npm run tauri dev
```

使用 `npm run dev` 可在浏览器中试用编辑器。要测试原生打开与保存对话框、文件关联或本地图片访问，请使用桌面版。

```bash
npm run lint
npm test -- --maxWorkers=2
npm run test:perf
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

原生剪贴板、输入法、文件关联和导出的手动测试步骤见 [QA 指南](docs/QA.md)。

## 许可证

[Apache License 2.0](LICENSE)
