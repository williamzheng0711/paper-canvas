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
  <strong>一张安静、在本地优先运行的桌面画布，适合研究笔记、数学内容与技术写作。</strong>
</p>

<p align="center">
  文档始终保存为可直接阅读的 UTF-8 Markdown 文件。PaperCanvas 在此基础上提供专注的可视化编辑器、实时 LaTeX、本地图像资源与原生桌面文件操作，而且不需要账号或云服务。
</p>

<p align="center">
  <img alt="支持平台：macOS 与 Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-555?style=flat-square">
  <img alt="使用 Tauri 2 构建" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white">
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-43853D?style=flat-square&logo=nodedotjs&logoColor=white">
  <a href="LICENSE"><img alt="Apache License 2.0" src="https://img.shields.io/badge/license-Apache--2.0-536fbe?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://williamzheng0711.github.io/paper-canvas/download/PaperCanvas-Windows-x64-Setup.exe?v=0.2.0">
    <img alt="下载 Windows 版 PaperCanvas" src="https://img.shields.io/badge/Download_for_Windows-0078D4?style=for-the-badge&logo=windows11&logoColor=white">
  </a>
  <a href="https://williamzheng0711.github.io/paper-canvas/download/PaperCanvas-macOS-universal.dmg?v=0.2.0">
    <img alt="下载 macOS 版 PaperCanvas" src="https://img.shields.io/badge/Download_for_macOS-111111?style=for-the-badge&logo=apple&logoColor=white">
  </a>
</p>

<p align="center">
  <sub>当前安装包版本：v0.2.0 · Windows 10/11 x64 · macOS Intel 与 Apple Silicon · 每个按钮都会直接下载最新版本。</sub>
</p>

<p align="center">
  <a href="#在-macos-上安装">在 macOS 上安装</a> ·
  <a href="#在-windows-上安装">在 Windows 上安装</a> ·
  <a href="#开发">开发</a> ·
  <a href="#隐私与文件格式">隐私</a>
</p>

<p align="center">
  <a href="docs/assets/papercanvas-editor.png">
    <img src="docs/assets/papercanvas-editor.png" alt="PaperCanvas 可视化编辑器，其中显示了大纲、研究笔记、渲染后的数学公式和实验检查清单" width="100%">
  </a>
</p>

<p align="center"><sub>本仓库中实际运行的 PaperCanvas 界面。</sub></p>

> [!IMPORTANT]
> 桌面安装包会由[发布工作流](.github/workflows/release-desktop.yml)根据每个版本标签构建，再由 [Pages 工作流](.github/workflows/publish-downloads.yml)复制到公开下载站点。安装 PaperCanvas 不需要 Node.js、Rust、Git、GitHub 账号，也不需要从源代码构建。

## 为什么是 Markdown

Markdown 将正文、结构、链接、代码与数学记号保存在可直接阅读的 UTF-8 纯文本文件中；单个 `.md` 文档即可独立保存核心内容，不依赖特定应用，语法容易上手，也便于搜索、Git 版本控制与跨工具打开，渲染后仍清晰美观。相比之下，`.txt` 缺乏标题、链接、图像、表格与数学结构的标准语法；`.tex` 排版能力强，但语法和工具链门槛较高；`.docx` 功能完整，却依赖兼容的办公软件，也较难直接检查、比较差异或合并。PaperCanvas 因此采用 Markdown，在便携、开放的文档中兼顾 LaTeX 数学与美观呈现；图像则可存放在相邻的资源目录中。

<table>
  <tr>
    <td width="50%">
      <a href="docs/assets/papercanvas-formula-editor.png">
        <img src="docs/assets/papercanvas-formula-editor.png" alt="PaperCanvas 块级公式编辑器，同时显示 LaTeX 源码和实时渲染预览">
      </a>
    </td>
    <td width="50%">
      <a href="docs/assets/papercanvas-markdown-source.png">
        <img src="docs/assets/papercanvas-markdown-source.png" alt="PaperCanvas 深色 Markdown 源码编辑器，带语法高亮和行号">
      </a>
    </td>
  </tr>
  <tr>
    <td><strong>实时公式编辑</strong><br><sub>编辑时，LaTeX 源码与 KaTeX 预览始终并排显示。</sub></td>
    <td><strong>真正的 Markdown 源码模式</strong><br><sub>CodeMirror 提供可编辑、带高亮的源码视图，而不是只读预览。</sub></td>
  </tr>
</table>

## 隐私与文件格式

<p align="center">
  <img src="docs/assets/local-first-workflow.svg" alt="PaperCanvas 本地优先工作流：在 PaperCanvas 中写作，保存普通 Markdown 与资源文件，并通过 Finder、资源管理器、Git 或其他编辑器使用它们" width="100%">
</p>

PaperCanvas 没有遥测、账号系统、同步服务、协作后端或 AI/联网功能。文档始终保留在你指定的保存位置。最近使用的文件路径与偏好设置存放在操作系统的 Tauri 应用数据目录中。

原生外壳只授予打开、保存、重命名、图像资源和导出所必需的文件权限。用户主动选择的文件会通过 Tauri 的持久化作用域在重启后保持可访问，而其他无关文件不会暴露给编辑器。

## 在 macOS 上安装

1. 点击上方的 **Download for macOS**，下载 `PaperCanvas-macOS-universal.dmg`。
2. 打开下载好的 DMG。
3. 将 **PaperCanvas** 拖入 **Applications（应用程序）**，推出 DMG，然后从“应用程序”中打开 PaperCanvas。

同一个安装包同时包含 Intel (`x86_64`) 与 Apple Silicon (`arm64`) 原生可执行文件，因此不需要按处理器类型选择下载项。

> [!NOTE]
> 如果某个版本采用临时签名，而不是 Developer ID 签名与公证，macOS 可能会阻止首次启动。请先确认 DMG 来自本仓库，再打开 **System Settings → Privacy & Security（系统设置 → 隐私与安全性）**，为 PaperCanvas 选择 **Open Anyway（仍要打开）**。配置所需的 Apple 密钥后，发布工作流会自动改用 Developer ID 签名和公证。

## 在 Windows 上安装

1. 点击上方的 **Download for Windows**，下载 `PaperCanvas-Windows-x64-Setup.exe`。
2. 运行下载好的安装程序，并按提示操作。
3. 从“开始”菜单启动 **PaperCanvas**，或直接用它打开 `.md` 或 `.markdown` 文件。

安装程序面向使用 64 位 Intel/AMD 处理器的标准 Windows 10 与 Windows 11 电脑。它会检查 Microsoft Edge WebView2；如果系统尚未提供该运行时，就会自动下载。

> [!NOTE]
> 在配置 Authenticode 证书之前，Microsoft Defender SmartScreen 可能会提示发布者未知。请先确认安装程序来自本仓库，再选择 **More info → Run anyway（更多信息 → 仍要运行）** 继续。

## 在开发环境中运行

完成当前操作系统所需的准备工作后，运行：

```bash
npm ci
npm run tauri dev
```

只包含浏览器前端的版本可通过 `npm run dev` 启动，但原生打开/保存对话框、文件关联、本地图像访问以及 macOS 直接导出 PDF 等功能需要使用 `npm run tauri dev`。

## 开发

PaperCanvas 使用 React 19、Tiptap/ProseMirror、CodeMirror 6、KaTeX、Tauri 2，以及一个小型 Rust 原生层。

常用验证命令：

```bash
npm run lint
npm test
npm run test:perf
npm run build
```

测试覆盖 Markdown ↔ 编辑器文档往返转换、数学分隔符、不受支持内容的保留、实时公式编辑、公式边界导航、文档搜索与焦点恢复、图像行为、自动保存稳定性、PDF 导出逻辑，以及创建 → 公式 → UTF-8 Markdown 保存/重新打开的冒烟流程。`npm run test:perf` 测量一份 50,000 字符中文文档在本地解析/序列化路径上的性能；它并不代表所有 UI 或输入法场景的延迟。

发布前，请参考 [docs/QA.md](docs/QA.md) 检查原生剪贴板、图像、文件关联、导出与窗口行为。

### 故障排除

| 现象                                                   | 检查事项                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 出现 `EBADENGINE`，或 `node --version` 不是 `v22.x`    | 将 Node.js 22 的二进制目录放在 `PATH` 最前面，重新打开终端，再运行 `npm ci`。                                                 |
| 出现 `Cannot find module '@rollup/rollup-darwin-arm64'` | 在 Apple Silicon 上运行 `npm ci --include=optional`，然后重试该命令。                                                        |
| Apple Silicon 构建中包含 `x86_64` 可执行文件           | 确认 `rustc -Vv` 使用 rustup 的 `aarch64-apple-darwin` 主机；在 `src-tauri` 中运行 `cargo clean --release`，然后重新构建。    |
| Windows 报告缺少 `link.exe`                            | 修改 Visual Studio Build Tools，安装 **Desktop development with C++（使用 C++ 的桌面开发）**工作负载和 Windows SDK。        |
| Tauri 引用了先前检出的路径                             | 在 `src-tauri` 中运行 `cargo clean --release`，返回仓库根目录，然后重新构建。                                                |

## 许可证

PaperCanvas 采用 [Apache License 2.0](LICENSE) 许可证。
