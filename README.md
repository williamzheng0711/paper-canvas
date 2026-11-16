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
  適合研究筆記、數學內容與技術文件的 Markdown 桌面編輯器。可在視覺化畫布和 Markdown 原始碼之間切換，文件以 UTF-8 純文字儲存在本機。
</p>

<p align="center">
  <a href="https://williamzheng0711.github.io/paper-canvas/download/PaperCanvas-Windows-x64-Setup.exe">下載 Windows 版</a>
  ·
  <a href="https://williamzheng0711.github.io/paper-canvas/download/PaperCanvas-macOS-universal.dmg">下載 macOS 版</a>
</p>

公開安裝包版本為 **v0.2.0**。下方的說明和畫面對應目前的原始碼，包含 v0.2.0 發布後的變更。

<p align="center">
  <a href="docs/assets/papercanvas-editor.png">
    <img src="docs/assets/papercanvas-editor.png" alt="PaperCanvas 畫布，左側是文件大綱，右側是批注欄" width="100%">
  </a>
</p>

## 安裝

- **macOS（Intel 和 Apple Silicon）**。開啟 DMG，將 PaperCanvas 拖入「應用程式」，再從該資料夾開啟。如果 macOS 阻止首次開啟，請確認安裝包來自上方的下載連結，再到「系統設定」的「隱私權與安全性」選擇「仍要打開」。
- **Windows 10／11（x64）**。執行安裝程式，依照提示完成安裝，再從「開始」功能表開啟 PaperCanvas。如果 SmartScreen 顯示發行者不明，請確認安裝包來源，再選擇「更多資訊」和「仍要執行」。

安裝後，可從 Finder 或檔案總管選擇以 PaperCanvas 開啟 `.md` 或 `.markdown` 檔案。

## 編輯與閱讀

- **畫布 / Markdown**。在畫布中直接編輯格式化文字、表格、待辦清單與註腳，或切換到帶語法高亮和行號的 Markdown 原始碼。超出畫布容量的文件會在 Markdown 模式開啟，完整原始碼仍可編輯和儲存。
- **數學公式**。用 `$…$` 輸入行內公式。獨立公式的前後各用一行 `$$`。在畫布中點選公式，即可修改 LaTeX 並查看 KaTeX 即時預覽。
- **大綱與搜尋**。從左側的「大綱」跳到文件標題，或在「最近」重開文件。按 `⌘/Ctrl + F` 可在兩個模式中搜尋。
- **批注**。在畫布中選取文字或放置游標，按右鍵選擇「新增批注」。使用工具列的對話框圖示開啟批注欄，並定位到原文。
- **閱讀設定**。按工具列的 **Aa** 調整字體、字級、行距或切換淺色／深色主題。也可在此選擇繁體中文、简体中文或 English。

<table>
  <tr>
    <td width="50%">
      <a href="docs/assets/papercanvas-formula-editor.png"><img src="docs/assets/papercanvas-formula-editor.png" alt="LaTeX 公式編輯器和即時預覽"></a>
    </td>
    <td width="50%">
      <a href="docs/assets/papercanvas-markdown-source.png"><img src="docs/assets/papercanvas-markdown-source.png" alt="帶語法高亮和行號的 Markdown 原始碼編輯器"></a>
    </td>
  </tr>
  <tr>
    <td>LaTeX 公式編輯</td>
    <td>Markdown 原始碼模式</td>
  </tr>
</table>

## 儲存與導出

- 工具列右側的 **⋯** 選單可新增、開啟、儲存、另存和重新命名文件。已儲存的文件會自動儲存變更。首次儲存前，PaperCanvas 會在本機保留復原草稿。
- 可將圖片拖入或貼到畫布，並拖曳控制點調整大小。儲存 `notes.md` 時，新加入的圖片檔案可放在相鄰的 `notes.assets/` 資料夾。搬移或分享文件時，請一併帶上相關圖片和資源資料夾。
- 批注儲存於 Markdown 檔案末尾的 HTML 註解中，會隨檔案一起分享。偏好設定、最近開啟的檔案清單和復原草稿也儲存在本機。PaperCanvas 無須帳號，沒有遙測或雲端同步。文件中的 HTTPS 圖片可能會從原網站載入。
- 在 **⋯** 選單的「導出」中選擇 Markdown 或 PDF。Markdown 會另存副本。macOS 可直接儲存 PDF，Windows 則透過系統列印對話框存成 PDF。

## 從原始碼執行

使用 Node.js 22（與自動化測試環境相同），並安裝 Rust 和作業系統所需的 [Tauri 開發工具](https://v2.tauri.app/start/prerequisites/)。在專案根目錄執行以下指令。

```bash
npm ci
npm run tauri dev
```

使用 `npm run dev` 可在瀏覽器中試用編輯器。若要測試原生開啟與儲存對話框、檔案關聯或本機圖片存取，請使用桌面版。

```bash
npm run lint
npm test -- --maxWorkers=2
npm run test:perf
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

原生剪貼簿、輸入法、檔案關聯和導出的手動測試步驟見 [QA 指南](docs/QA.md)。

## 授權

[Apache License 2.0](LICENSE)
