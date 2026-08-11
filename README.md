<p align="center">
  <strong>繁體中文</strong> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" height="96" alt="PaperCanvas 應用程式圖示">
</p>

<h1 align="center">PaperCanvas</h1>

<p align="center">
  <strong>一張安靜、以本機為優先的桌面畫布，適合研究筆記、數學內容與技術寫作。</strong>
</p>

<p align="center">
  文件始終儲存為可直接閱讀的 UTF-8 Markdown 檔案。PaperCanvas 在此基礎上提供專注的視覺化編輯器、即時 LaTeX、本機圖片資源與原生桌面檔案操作，而且不需要帳號或雲端服務。
</p>

<p align="center">
  <img alt="支援平台：macOS 與 Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-555?style=flat-square">
  <img alt="使用 Tauri 2 建置" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white">
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-43853D?style=flat-square&logo=nodedotjs&logoColor=white">
  <a href="LICENSE"><img alt="Apache License 2.0" src="https://img.shields.io/badge/license-Apache--2.0-536fbe?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://williamzheng0711.github.io/paper-canvas/download/PaperCanvas-Windows-x64-Setup.exe?v=0.1.1">
    <img alt="下載 Windows 版 PaperCanvas" src="https://img.shields.io/badge/Download_for_Windows-0078D4?style=for-the-badge&logo=windows11&logoColor=white">
  </a>
  <a href="https://williamzheng0711.github.io/paper-canvas/download/PaperCanvas-macOS-universal.dmg?v=0.1.1">
    <img alt="下載 macOS 版 PaperCanvas" src="https://img.shields.io/badge/Download_for_macOS-111111?style=for-the-badge&logo=apple&logoColor=white">
  </a>
</p>

<p align="center">
  <sub>目前安裝程式版本：v0.1.1 · Windows 10/11 x64 · macOS Intel 與 Apple Silicon · 每個按鈕都會直接下載最新版本。</sub>
</p>

<p align="center">
  <a href="#在-macos-上安裝">在 macOS 上安裝</a> ·
  <a href="#在-windows-上安裝">在 Windows 上安裝</a> ·
  <a href="#開發">開發</a> ·
  <a href="#隱私與檔案格式">隱私</a>
</p>

<p align="center">
  <a href="docs/assets/papercanvas-editor.png">
    <img src="docs/assets/papercanvas-editor.png" alt="PaperCanvas 視覺化編輯器，其中顯示了大綱、研究筆記、渲染後的數學公式與實驗檢查清單" width="100%">
  </a>
</p>

<p align="center"><sub>本儲存庫中實際執行的 PaperCanvas 介面。</sub></p>

> [!IMPORTANT]
> 桌面安裝程式會由[發佈工作流程](.github/workflows/release-desktop.yml)根據每個版本標籤建置，再由 [Pages 工作流程](.github/workflows/publish-downloads.yml)複製到公開下載網站。安裝 PaperCanvas 不需要 Node.js、Rust、Git、GitHub 帳號，也不需要從原始碼建置。

## 為什麼是 Markdown

Markdown 將正文、結構、連結、程式碼與數學記號保存在可直接閱讀的 UTF-8 純文字檔中；單一 `.md` 文件即可獨立保存核心內容，不依賴特定應用程式，語法容易上手，也便於搜尋、Git 版本控制與跨工具開啟，渲染後仍清晰美觀。相較之下，`.txt` 缺乏標題、連結、圖片、表格與數學結構的標準語法；`.tex` 排版能力強，但語法與工具鏈門檻較高；`.docx` 功能完整，卻依賴相容的辦公軟體，也較難直接檢視、比較差異或合併。PaperCanvas 因此採用 Markdown，在可攜、開放的文件中兼顧 LaTeX 數學與美觀呈現；圖片則可存放在相鄰的資源資料夾。

<table>
  <tr>
    <td width="50%">
      <a href="docs/assets/papercanvas-formula-editor.png">
        <img src="docs/assets/papercanvas-formula-editor.png" alt="PaperCanvas 區塊公式編輯器，同時顯示 LaTeX 原始碼與即時渲染預覽">
      </a>
    </td>
    <td width="50%">
      <a href="docs/assets/papercanvas-markdown-source.png">
        <img src="docs/assets/papercanvas-markdown-source.png" alt="PaperCanvas 深色 Markdown 原始碼編輯器，具備語法醒目提示與行號">
      </a>
    </td>
  </tr>
  <tr>
    <td><strong>即時公式編輯</strong><br><sub>編輯時，LaTeX 原始碼與 KaTeX 預覽會一直並排顯示。</sub></td>
    <td><strong>真正的 Markdown 原始碼模式</strong><br><sub>CodeMirror 提供可編輯、帶有醒目提示的原始碼檢視，而不是唯讀預覽。</sub></td>
  </tr>
</table>

## 隱私與檔案格式

<p align="center">
  <img src="docs/assets/local-first-workflow.svg" alt="PaperCanvas 本機優先工作流程：在 PaperCanvas 中寫作，儲存一般 Markdown 與資源檔案，並透過 Finder、檔案總管、Git 或其他編輯器使用它們" width="100%">
</p>

PaperCanvas 沒有遙測、帳號系統、同步服務、協作後端或 AI/連網功能。文件始終保留在你指定的儲存位置。最近使用的檔案路徑與偏好設定存放在作業系統的 Tauri 應用程式資料目錄中。

原生外殼只授予開啟、儲存、重新命名、圖片資源與匯出所必需的檔案權限。使用者主動選取的檔案會透過 Tauri 的持久化作用域在重新啟動後保持可存取，而其他無關檔案不會暴露給編輯器。

## 在 macOS 上安裝

1. 點選上方的 **Download for macOS**，下載 `PaperCanvas-macOS-universal.dmg`。
2. 開啟下載好的 DMG。
3. 將 **PaperCanvas** 拖入 **Applications（應用程式）**，退出 DMG，然後從「應用程式」開啟 PaperCanvas。

同一個安裝程式同時包含 Intel (`x86_64`) 與 Apple Silicon (`arm64`) 原生執行檔，因此不需要依處理器類型選擇下載項目。

> [!NOTE]
> 如果某個版本採用臨時簽署，而不是 Developer ID 簽署與公證，macOS 可能會阻止首次啟動。請先確認 DMG 來自本儲存庫，再開啟 **System Settings → Privacy & Security（系統設定 → 隱私權與安全性）**，為 PaperCanvas 選擇 **Open Anyway（仍要打開）**。設定所需的 Apple 密鑰後，發佈工作流程會自動改用 Developer ID 簽署與公證。

## 在 Windows 上安裝

1. 點選上方的 **Download for Windows**，下載 `PaperCanvas-Windows-x64-Setup.exe`。
2. 執行下載好的安裝程式，並依照提示操作。
3. 從「開始」功能表啟動 **PaperCanvas**，或直接用它開啟 `.md` 或 `.markdown` 檔案。

安裝程式適用於採用 64 位元 Intel/AMD 處理器的標準 Windows 10 與 Windows 11 電腦。它會檢查 Microsoft Edge WebView2；如果系統尚未提供該執行階段，就會自動下載。

> [!NOTE]
> 在設定 Authenticode 憑證之前，Microsoft Defender SmartScreen 可能會提示發行者不明。請先確認安裝程式來自本儲存庫，再選擇 **More info → Run anyway（其他資訊 → 仍要執行）** 繼續。

## 在開發環境中執行

完成目前作業系統所需的準備工作後，執行：

```bash
npm ci
npm run tauri dev
```

僅包含瀏覽器前端的版本可透過 `npm run dev` 啟動，但原生開啟/儲存對話框、檔案關聯、本機圖片存取，以及 macOS 直接匯出 PDF 等功能需要使用 `npm run tauri dev`。

## 開發

PaperCanvas 使用 React 19、Tiptap/ProseMirror、CodeMirror 6、KaTeX、Tauri 2，以及一個小型 Rust 原生層。

常用驗證命令：

```bash
npm run lint
npm test
npm run test:perf
npm run build
```

測試涵蓋 Markdown ↔ 編輯器文件往返轉換、數學分隔符、不支援內容的保留、即時公式編輯、公式邊界導覽、文件搜尋與焦點還原、圖片行為、自動儲存穩定性、PDF 匯出邏輯，以及建立 → 公式 → UTF-8 Markdown 儲存/重新開啟的煙霧測試流程。`npm run test:perf` 測量一份 50,000 字元中文文件在本機解析/序列化路徑上的效能；它不代表所有 UI 或輸入法情境的延遲。

發佈前，請參考 [docs/QA.md](docs/QA.md) 檢查原生剪貼簿、圖片、檔案關聯、匯出與視窗行為。

### 疑難排解

| 現象                                                   | 檢查事項                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 出現 `EBADENGINE`，或 `node --version` 不是 `v22.x`    | 將 Node.js 22 的執行檔目錄放在 `PATH` 最前面，重新開啟終端機，再執行 `npm ci`。                                               |
| 出現 `Cannot find module '@rollup/rollup-darwin-arm64'` | 在 Apple Silicon 上執行 `npm ci --include=optional`，然後重試該命令。                                                        |
| Apple Silicon 建置中包含 `x86_64` 執行檔               | 確認 `rustc -Vv` 使用 rustup 的 `aarch64-apple-darwin` 主機；在 `src-tauri` 中執行 `cargo clean --release`，然後重新建置。    |
| Windows 回報缺少 `link.exe`                            | 修改 Visual Studio Build Tools，安裝 **Desktop development with C++（使用 C++ 的桌面開發）**工作負載與 Windows SDK。        |
| Tauri 引用了先前簽出的路徑                             | 在 `src-tauri` 中執行 `cargo clean --release`，回到儲存庫根目錄，然後重新建置。                                              |

## Markdown 與數學公式支援

PaperCanvas 有意支援一組聚焦的 Markdown 子集：標題、段落、強調、刪除線、行內程式碼、連結、清單與工作清單、區塊引言、分隔線、圍欄程式碼區塊、GFM 表格、圖片，以及下列數學形式。

- 行內公式：`$...$` 與 `\(...\)`。
- 獨立公式：單獨成塊的 `$$...$$` 與多行 `\[...\]`。
- 獨立 KaTeX 環境，包括 `equation`、`align`、`gather`、`aligned`、`cases` 及常見矩陣變體。
- 常用 KaTeX 結構，例如分數、上下標、根式、希臘字母、`\mathbb`、`\mathbf` 與 `\operatorname`。

目前不支援任意 TeX 巨集套件、期刊範本、自訂巨集偏好、公式編號、標籤、引用或一般 HTML 執行。無效的 KaTeX 會以原始碼保留在文件中，並顯示本機警告；它不會導致應用程式當機，也不會悄悄刪除文件。

PaperCanvas 擁有獨立的設計與資源，目標是提供低干擾的單頁寫作體驗，但不宣稱完全相容於 Markdown、TeX 或 Typora。

## 已知限制

- 尚無同步、協作、命令選擇區、拼字字典或打字機/專注模式。
- 表格可以透過 GFM 往返轉換，但還沒有試算表樣式的儲存格工具列。
- macOS 可直接匯出 PDF；其他平台目前使用各自的系統列印流程。
- 公開版本仍需要 macOS Developer ID 簽署/公證與 Windows Authenticode 簽署。

## 授權條款

PaperCanvas 採用 [Apache License 2.0](LICENSE) 授權條款。
