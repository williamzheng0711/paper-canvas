<p align="center">
  <a href="README.md">繁體中文</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <strong>English</strong>
</p>

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" height="96" alt="PaperCanvas app icon">
</p>

<h1 align="center">PaperCanvas</h1>

<p align="center">
  <strong>A calm, local-first desktop canvas for research notes, mathematics, and technical writing.</strong>
</p>

<p align="center">
  Your documents stay as readable UTF-8 Markdown files. PaperCanvas adds a focused visual editor, live LaTeX, local image assets, and native desktop file handling—without an account or cloud service.
</p>

<p align="center">
  <img alt="Platforms: macOS and Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-555?style=flat-square">
  <img alt="Built with Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white">
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-43853D?style=flat-square&logo=nodedotjs&logoColor=white">
  <a href="LICENSE"><img alt="Apache License 2.0" src="https://img.shields.io/badge/license-Apache--2.0-536fbe?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://williamzheng0711.github.io/paper-canvas/download/PaperCanvas-Windows-x64-Setup.exe?v=0.1.1">
    <img alt="Download PaperCanvas for Windows" src="https://img.shields.io/badge/Download_for_Windows-0078D4?style=for-the-badge&logo=windows11&logoColor=white">
  </a>
  <a href="https://williamzheng0711.github.io/paper-canvas/download/PaperCanvas-macOS-universal.dmg?v=0.1.1">
    <img alt="Download PaperCanvas for macOS" src="https://img.shields.io/badge/Download_for_macOS-111111?style=for-the-badge&logo=apple&logoColor=white">
  </a>
</p>

<p align="center">
  <sub>Current installer release: v0.1.1 · Windows 10/11 x64 · macOS Intel and Apple Silicon · Each button downloads the newest release directly.</sub>
</p>

<p align="center">
  <a href="#install-on-macos">Install on macOS</a> ·
  <a href="#install-on-windows">Install on Windows</a> ·
  <a href="#development">Development</a> ·
  <a href="#privacy-and-file-format">Privacy</a>
</p>

<p align="center">
  <a href="docs/assets/papercanvas-editor.png">
    <img src="docs/assets/papercanvas-editor.png" alt="PaperCanvas visual editor showing an outline, a research note, rendered mathematics, and an experiment checklist" width="100%">
  </a>
</p>

<p align="center"><sub>The real PaperCanvas interface, captured from this repository.</sub></p>

> [!IMPORTANT]
> Desktop installers are built from each version tag by [the release workflow](.github/workflows/release-desktop.yml), then copied to a public download site by [the Pages workflow](.github/workflows/publish-downloads.yml). No Node.js, Rust, Git, GitHub account, or source build is required to install PaperCanvas.

## Why Markdown

Markdown keeps text, structure, links, code, and mathematical notation in a readable UTF-8 file. A single `.md` document can preserve its core content without depending on a particular app; its syntax is approachable, its content is easy to search and manage with Git, it opens across tools, and it renders cleanly. By comparison, `.txt` has no standard syntax for headings, links, images, tables, or mathematics; `.tex` offers powerful typesetting but has a steeper syntax and toolchain; `.docx` is capable but depends on compatible office software and is harder to inspect, diff, or merge. PaperCanvas therefore uses Markdown to combine portable, open documents with LaTeX mathematics and polished rendering; images can live in a neighboring asset folder.

<table>
  <tr>
    <td width="50%">
      <a href="docs/assets/papercanvas-formula-editor.png">
        <img src="docs/assets/papercanvas-formula-editor.png" alt="PaperCanvas block formula editor with LaTeX source and live rendered preview">
      </a>
    </td>
    <td width="50%">
      <a href="docs/assets/papercanvas-markdown-source.png">
        <img src="docs/assets/papercanvas-markdown-source.png" alt="PaperCanvas dark Markdown source editor with syntax highlighting and line numbers">
      </a>
    </td>
  </tr>
  <tr>
    <td><strong>Live formula editing</strong><br><sub>LaTeX source and KaTeX preview stay together while you edit.</sub></td>
    <td><strong>Real Markdown source mode</strong><br><sub>CodeMirror provides an editable, highlighted source view—not a read-only preview.</sub></td>
  </tr>
</table>

## Privacy and file format

<p align="center">
  <img src="docs/assets/local-first-workflow.svg" alt="PaperCanvas local-first workflow: write in PaperCanvas, store ordinary Markdown and asset files, and use them with Finder, Explorer, Git, or other editors" width="100%">
</p>

PaperCanvas has no telemetry, account system, sync service, collaboration backend, or AI/network feature. Documents remain where you save them. Recent-file paths and preferences are stored in the operating system's Tauri application-data directory.

The native shell grants only the file capabilities needed for open, save, rename, image assets, and export. A user-selected file remains accessible after restart through Tauri's persisted scope; unrelated files are not exposed to the editor.

## Install on macOS

1. Click **Download for macOS** above to download `PaperCanvas-macOS-universal.dmg`.
2. Open the downloaded DMG.
3. Drag **PaperCanvas** into **Applications**, eject the DMG, and open PaperCanvas from Applications.

The same installer contains native Intel (`x86_64`) and Apple Silicon (`arm64`) executables, so users do not need to choose a processor-specific download.

> [!NOTE]
> If a release is ad-hoc signed rather than Developer ID signed and notarized, macOS may block its first launch. Confirm that the DMG came from this repository, then open **System Settings → Privacy & Security** and choose **Open Anyway** for PaperCanvas. The release workflow automatically switches to Developer ID signing and notarization when the required Apple secrets are configured.

## Install on Windows

1. Click **Download for Windows** above to download `PaperCanvas-Windows-x64-Setup.exe`.
2. Run the downloaded installer and follow its prompts.
3. Launch **PaperCanvas** from the Start menu or open a `.md` or `.markdown` file with it.

The installer targets standard 64-bit Intel/AMD Windows 10 and Windows 11 computers. It checks for Microsoft Edge WebView2 and downloads the runtime when Windows does not already provide it.

> [!NOTE]
> Until an Authenticode certificate is configured, Microsoft Defender SmartScreen may warn that the publisher is unknown. Confirm that the installer came from this repository, then choose **More info → Run anyway** to continue.

## Run in development

After completing the prerequisites for your operating system:

```bash
npm ci
npm run tauri dev
```

The browser-only frontend can be started with `npm run dev`, but native open/save dialogs, file associations, local image access, and direct macOS PDF export require `npm run tauri dev`.

## Development

PaperCanvas uses React 19, Tiptap/ProseMirror, CodeMirror 6, KaTeX, Tauri 2, and a small Rust native layer.

Useful validation commands:

```bash
npm run lint
npm test
npm run test:perf
npm run build
```

The tests cover Markdown ↔ editor-document round trips, math delimiters, unsupported-content retention, live formula editing, formula boundary navigation, document search and focus restoration, image behavior, auto-save stability, PDF export logic, and a create → formula → UTF-8 Markdown save/reopen smoke path. `npm run test:perf` measures the local parse/serialize path for a 50,000-character Chinese document; it is not a universal UI or IME latency claim.

Use [docs/QA.md](docs/QA.md) for native clipboard, image, file-association, export, and window checks before a release.

### Troubleshooting

| Symptom                                                | What to check                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `EBADENGINE` or `node --version` is not `v22.x`        | Put the Node.js 22 binary directory first in `PATH`, reopen the terminal, and rerun `npm ci`.                                |
| `Cannot find module '@rollup/rollup-darwin-arm64'`     | On Apple Silicon, run `npm ci --include=optional`, then retry the command.                                                   |
| An Apple Silicon build contains an `x86_64` executable | Confirm `rustc -Vv` uses rustup's `aarch64-apple-darwin` host, run `cargo clean --release` inside `src-tauri`, then rebuild. |
| Windows reports that `link.exe` is missing             | Modify Visual Studio Build Tools and install the **Desktop development with C++** workload plus a Windows SDK.               |
| Tauri refers to a previous checkout path               | Run `cargo clean --release` inside `src-tauri`, return to the repository root, and rebuild.                                  |

## License

PaperCanvas is available under the [Apache License 2.0](LICENSE).
