# PaperCanvas

PaperCanvas is a local-first desktop writing app for research notes, derivations, proposals, and technical documents. It uses one Tiptap/ProseMirror canvas rather than a permanent Markdown-source/preview split. Markdown is the UTF-8 on-disk format; formulas are stored as LaTeX and displayed through KaTeX.

This project is intentionally not a Typora clone in design or assets. It pursues the same low-distraction, single-page writing outcome without claiming complete Markdown, TeX, or Typora compatibility.

## P0 capabilities

- Create, open, save-as, rename, and auto-save local `.md` files; the window title and status bar show dirty/save state. Installed macOS and Windows builds register `.md` and `.markdown` as editable PaperCanvas document types, so Finder/Explorer double-click and **Open With PaperCanvas** open the file in the canvas; the opened file is also immediately added to **最近文件**.
- One visual writing canvas with undo/redo, macOS `Cmd` / Windows `Ctrl` shortcuts, headings, lists, task lists, block quotes, code blocks with highlighting, tables, links, images, and a collapsible recent-files/outline sidebar.
- Inline and block formula nodes: KaTeX when unfocused; click once to open the LaTeX source and live preview together; `Esc`, `Cmd`/`Ctrl` + `Enter`, the check button, or blur exits. Formula-source copying, error containment, and toolbar / `Cmd` or `Ctrl` + `Alt` + `M` insertion are included.
- Common `$...$` text becomes an inline formula after its closing `$`; entering `$$` at the start of an empty paragraph creates one empty display formula, and a complete standalone `$$...$$` line is normalized as a block formula on open. Typora-style `\\(...\\)` and multiline `\\[...\\]` delimiters are also recognized when Markdown is opened. The toolbar remains an alternative insertion path.
- Choose images from the **圖片** toolbar button, paste, or drag images into the canvas. Images display immediately, have four mouse resize handles, and temporarily preserve aspect ratio while `Shift` is held. Embedded images are saved under `<document>.assets/` on the next save and Markdown references them relatively; resize dimensions and companion assets survive reopen and rename.
- HTML pasted into the editor is DOMPurify-sanitized. Unsupported Markdown/HTML is retained as a visible warning node and emitted back rather than silently discarded.
- Light/dark mode, base font, font size, word/character counts, source-only Markdown mode, recent file list, and local preference storage through Tauri Store.
- Fixed, fine-lined page margins that stay constant as a desktop window grows, allowing each line to use the added width.
- Export a copy as `.md`, or open the system print dialog with a print-optimized layout to save as `.pdf`.

PaperCanvas Markdown support is deliberately bounded: headings, paragraphs, bold/italic/strike/inline code/links, lists/tasks, quotes, rules, fenced code, GFM tables, images, `$...$`, `$$...$$`, `\\(...\\)`, and `\\[...\\]`. Supported math covers KaTeX-compatible everyday constructs such as fractions, scripts, roots, matrices, `cases`, `aligned`, Greek letters, `\mathbb`, `\mathbf`, and `\operatorname`. Arbitrary TeX macros, HTML execution, journal templates, and arbitrary LaTeX packages are not supported.

## Development

Prerequisites:

- Node.js 22 LTS.
- Rust stable via [rustup](https://rustup.rs/).
- macOS: Xcode Command Line Tools. Windows: Visual Studio Build Tools with the C++ workload and WebView2 Runtime.

```bash
npm ci
npm run tauri dev
```

Useful validation commands:

```bash
npm run lint
npm test
npm run test:perf
npm run build
```

`npm test` covers Markdown ↔ editor-document round trips, Typora-compatible math delimiters, unsupported-content retention, formulas including invalid LaTeX, formula source/live-preview editing, formula boundary navigation, and a create → formula → UTF-8 Markdown save/reopen smoke path. `npm run test:perf` measures a 50,000-character Chinese plain-text parse/serialize path; it is a model-layer measurement, not a claim that every platform or IME has identical latency. Use the release QA list in [docs/QA.md](docs/QA.md) for native clipboard, image, and window checks.

## Native packaging and installation

Build on the target operating system:

```bash
npm run tauri build
```

On macOS this creates an `.app` and a `.dmg` under `src-tauri/target/release/bundle/`. On Windows it creates MSI and NSIS installers under `src-tauri/target/release/bundle/msi/` and `src-tauri/target/release/bundle/nsis/`. Cross-compiling installers is not a replacement for building on the target OS, so the GitHub Actions matrix at [.github/workflows/build-desktop.yml](.github/workflows/build-desktop.yml) builds each artifact natively and uploads it.

After installing a new macOS build, move `PaperCanvas.app` to `/Applications` and launch it once. Finder then lists PaperCanvas under **Open With** for `.md` and `.markdown`; selecting it opens the chosen file whether the app is starting or already running. Windows installers register the same types with Explorer. Existing unsigned builds may still need the Gatekeeper confirmation described below.

Without signing credentials, artifacts are intentionally unsigned. macOS Gatekeeper may require the user to open the app with an explicit confirmation, and Windows SmartScreen may show a reputation warning. This is expected and is not notarization or code-signing.

To add macOS signing/notarization later, set `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` as GitHub Actions secrets, then add your certificate/import and notarization workflow appropriate to your Apple Developer ID. For Windows, obtain an Authenticode certificate, store it as protected CI secrets, then add a post-bundle `signtool sign` step for both the MSI and NSIS `.exe`; use a timestamp server from the certificate provider. The current workflow deliberately does not pretend either signing path is configured.

## Privacy and storage

PaperCanvas has no telemetry, accounts, sync, collaboration service, or AI/network feature. Documents remain where users save them; recent-file paths and preferences live in the Tauri application data location. Image assets belong next to their Markdown document, never in the app bundle.

The native shell grants only the file commands needed for open/save, image assets, and rename. Tauri's persisted-scope plugin records the user-selected filesystem scopes so a file chosen through the system dialog or OS file association (including one outside the standard home folders) remains accessible after restart; it does not grant unrelated application code blanket filesystem access. The asset protocol is enabled solely so the WebView can display local image files referenced by the active document.

## P1 / known limits

- No formula numbering, labels, references, custom macro preferences, direct TeX-draft export, or custom PDF page templates yet.
- Tables are editable and round-trip through GFM, but do not yet have a rich spreadsheet-style cell toolbar.
- Focus/typewriter modes, command palette, spelling dictionaries, and advanced font configuration are deferred.
- Formula rendering uses KaTeX. A formula KaTeX cannot parse remains in the document as source plus an inline warning; it never crashes the document.
