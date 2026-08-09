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
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-536fbe?style=flat-square"></a>
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
> PaperCanvas does not yet publish signed, notarized installers. The reproducible installation path today is to build on the target Mac or Windows computer using the steps below. Until signing is configured, shared artifacts should be treated as local/test builds rather than official trusted releases.

## Why PaperCanvas

- **A visual canvas, not a permanent split view.** Write in one Tiptap/ProseMirror document and switch to an editable CodeMirror Markdown source mode only when you need it.
- **Mathematics that remains LaTeX.** Inline and display formulas render with KaTeX. Click any formula to edit its source beside a live preview.
- **Files you control.** Create, open, rename, auto-save, export, and reopen local `.md` and `.markdown` documents. Installed builds register both file types with Finder or Explorer.
- **Portable images.** Paste or drag images, resize them on the canvas, and save them beside the document under `<document>.assets/` with relative Markdown references.
- **Content-preserving by design.** Unsupported Markdown or sanitized HTML stays visible and round-trips as source instead of disappearing silently.
- **Built for long technical documents.** Outline navigation, tables, task lists, highlighted code blocks, word counts, themes, font controls, adjustable spacing, and English, 简体中文, and 繁體中文 UI are included.

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

These steps follow the official [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) and build a native `.app` and `.dmg` on the Mac where PaperCanvas will run. Apple Silicon and Intel Macs must use a Rust toolchain that matches the computer's architecture.

### 1. Install the build tools

You need:

- macOS with [Xcode Command Line Tools](https://developer.apple.com/xcode/resources/).
- [Homebrew](https://brew.sh/) and Node.js 22.
- Stable Rust installed through [rustup](https://rustup.rs/), not an older package-manager Rust.
- Git, which is included with Xcode Command Line Tools.

Open Terminal and run:

```bash
xcode-select --install
brew install node@22
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

`xcode-select` may report that the tools are already installed. After rustup finishes, close and reopen Terminal once.

### 2. Clone, verify, and build

```bash
git clone https://github.com/williamzheng0711/paper-canvas.git
cd paper-canvas

export PATH="$HOME/.cargo/bin:$(brew --prefix node@22)/bin:$PATH"

node --version
rustc -Vv

npm ci
npm run tauri build -- --bundles app,dmg
```

Before building, `node --version` must begin with `v22`. On Apple Silicon, `rustc -Vv` must report `host: aarch64-apple-darwin`; on an Intel Mac it must report `host: x86_64-apple-darwin`.

### 3. Install the app

```bash
open src-tauri/target/release/bundle/dmg
```

Open the generated `.dmg`, then drag **PaperCanvas** into **Applications**. The unpacked app bundle is also available at:

```text
src-tauri/target/release/bundle/macos/PaperCanvas.app
```

To verify the actual executable architecture instead of trusting the installer filename:

```bash
file src-tauri/target/release/bundle/macos/PaperCanvas.app/Contents/MacOS/papercanvas
```

> [!NOTE]
> Current builds use an ad-hoc signature and are not notarized. A locally built app normally opens directly; a shared or downloaded build may trigger Gatekeeper. Only open artifacts you trust, then use **System Settings → Privacy & Security → Open Anyway** if macOS offers that option. Public distribution without this warning requires an Apple **Developer ID Application** certificate and notarization; see Tauri's [macOS code-signing guide](https://v2.tauri.app/distribute/sign/macos/).

## Install on Windows

Follow the official [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) and build PaperCanvas from a regular 64-bit Windows 10 or Windows 11 environment. WSL alone cannot produce the normal native Windows installer workflow described here.

### 1. Install the build tools

Install the following, then restart PowerShell:

- [Git for Windows](https://git-scm.com/download/win).
- [Node.js 22](https://nodejs.org/en/download/archive/v22) for your Windows architecture.
- Stable Rust from the official [rustup installer](https://rustup.rs/) using the MSVC toolchain.
- [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload, MSVC, and a Windows 10 or 11 SDK selected.
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). It is already present on most current Windows 10 and Windows 11 systems.

### 2. Clone, verify, and build

Open a new PowerShell window:

```powershell
git clone https://github.com/williamzheng0711/paper-canvas.git
Set-Location paper-canvas

node --version
rustc -Vv

npm ci
npm run tauri build -- --bundles nsis
```

`node --version` must begin with `v22`. For a standard 64-bit Intel/AMD Windows computer, `rustc -Vv` should report `host: x86_64-pc-windows-msvc`.

### 3. Run the installer

```powershell
$paperCanvasInstaller = Get-ChildItem ".\src-tauri\target\release\bundle\nsis\*.exe" | Select-Object -First 1
Start-Process $paperCanvasInstaller.FullName
```

The NSIS installer is generated under:

```text
src-tauri\target\release\bundle\nsis\
```

> [!NOTE]
> Current Windows installers are not Authenticode-signed. SmartScreen may warn about a shared or downloaded build with no established reputation. Verify where the file came from before choosing **More info → Run anyway**. A future public release should sign and timestamp its installer; see Tauri's [Windows code-signing guide](https://v2.tauri.app/distribute/sign/windows/).

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

The tests cover Markdown ↔ editor-document round trips, math delimiters, unsupported-content retention, live formula editing, formula boundary navigation, image behavior, auto-save stability, PDF export logic, and a create → formula → UTF-8 Markdown save/reopen smoke path. `npm run test:perf` measures the local parse/serialize path for a 50,000-character Chinese document; it is not a universal UI or IME latency claim.

Use [docs/QA.md](docs/QA.md) for native clipboard, image, file-association, export, and window checks before a release.

### Troubleshooting

| Symptom                                                | What to check                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `EBADENGINE` or `node --version` is not `v22.x`        | Put the Node.js 22 binary directory first in `PATH`, reopen the terminal, and rerun `npm ci`.                                |
| `Cannot find module '@rollup/rollup-darwin-arm64'`     | On Apple Silicon, run `npm ci --include=optional`, then retry the command.                                                   |
| An Apple Silicon build contains an `x86_64` executable | Confirm `rustc -Vv` uses rustup's `aarch64-apple-darwin` host, run `cargo clean --release` inside `src-tauri`, then rebuild. |
| Windows reports that `link.exe` is missing             | Modify Visual Studio Build Tools and install the **Desktop development with C++** workload plus a Windows SDK.               |
| Tauri refers to a previous checkout path               | Run `cargo clean --release` inside `src-tauri`, return to the repository root, and rebuild.                                  |

## Markdown and mathematics support

PaperCanvas intentionally supports a focused Markdown subset: headings, paragraphs, emphasis, strike-through, inline code, links, lists and task lists, block quotes, rules, fenced code, GFM tables, images, and the math forms below.

- Inline math: `$...$` and `\(...\)`.
- Display math: standalone `$$...$$` and multiline `\[...\]`.
- Standalone KaTeX environments including `equation`, `align`, `gather`, `aligned`, `cases`, and common matrix variants.
- Everyday KaTeX constructs such as fractions, scripts, roots, Greek letters, `\mathbb`, `\mathbf`, and `\operatorname`.

Arbitrary TeX packages, journal templates, custom macro preferences, formula numbering, labels, references, and general HTML execution are not supported. Invalid KaTeX stays in the document as source with a local warning; it does not crash or silently delete the document.

PaperCanvas is its own design and asset set. It aims for a low-distraction, single-page writing experience without claiming complete Markdown, TeX, or Typora compatibility.

## Known limits

- No sync, collaboration, command palette, spelling dictionaries, or typewriter/focus mode yet.
- Tables round-trip through GFM but do not yet have a spreadsheet-style cell toolbar.
- PDF export is direct on macOS; other platforms currently use their system print flow.
- Public releases still need macOS Developer ID signing/notarization and Windows Authenticode signing.

## License

PaperCanvas is available under the [MIT License](LICENSE).
