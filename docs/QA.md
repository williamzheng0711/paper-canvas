# PaperCanvas P0 manual QA

Run `npm run tauri dev` on a machine with the Tauri prerequisites, then check these behaviours before a release.

1. Create a document, type Chinese with an IME, English, and punctuation in the same paragraph. Confirm composition is not committed prematurely.
2. Type `The loss is $x^2 + 1$` and confirm the completed formula changes into a rendered inline node. Click it once; confirm the LaTeX source and live preview are both visible, edit the source, then press `Esc` and click elsewhere.
3. Type `$$` in an otherwise empty paragraph and confirm it creates exactly one display formula. Enter the aligned-equation example below. Click the formula and confirm the source appears above a live preview; finish with the check button, then repeat with `Cmd`/`Ctrl` + `Enter`. Use arrow keys around the selected formula, then use Backspace and Delete after selecting it.

   ```latex
   \begin{aligned}
   x_{t-1} &= \mu_\theta(x_t,t)+\sigma_t\epsilon, \\
   \epsilon &\sim \mathcal{N}(0,I).
   \end{aligned}
   ```

4. Open Markdown containing Typora-style `\\(x\\)` and multiline `\\[...\\]` formulas. Confirm both forms render, while the same delimiters inside inline/fenced/indented code remain source text. Also test `matrix`, `cases`, Chinese text around an inline formula, and `\definitelyNotALatexCommand{`. The last case must retain the source and show only a local formula warning.
5. Drag an image into the canvas and paste another one from the clipboard. Each must display immediately. Select an image, drag each corner handle, and repeat while holding `Shift` to verify temporary aspect-ratio locking. Save as `notes.md`; verify images are written into `notes.assets/`, the Markdown contains relative image paths plus the PaperCanvas size metadata, and reopening preserves the final dimensions.
6. Close/reopen `notes.md`, use the **Canvas / Markdown** segments to switch modes repeatedly, and verify there is one primary editor. Without editing, use outline links, inspect a formula, and save; confirm the original Markdown remains unchanged.
7. Add a phrase in several locations, including once across bold/plain formatting. Press `Cmd`/`Ctrl` + `F`, type that phrase, and confirm every canvas match is highlighted. Press `Enter` and `Shift` + `Enter` to move forward and backward with wraparound, then press `Esc`; confirm highlights disappear and typing resumes in the editor. Repeat in **原始 Markdown** mode, including a no-results query.
8. Resize, minimize, and maximize the window. Confirm the toolbar remains usable at the minimum window width, the reading column stays centered and bounded on wider windows, and the sidebar collapses correctly. Switch between Outline and Recent with clicks and arrow keys. In **Aa**, change font size and line spacing, then reopen the app to verify persistence; confirm Escape cancels an uncommitted input. Check both themes and dismiss the settings/actions menus with Escape and outside clicks.
9. Open the document actions menu, then **導出**, and export both formats. Confirm Markdown opens a save dialog for a `.md` copy without changing the active document path. On macOS, confirm PDF opens a direct save dialog without a print-preview panel or any visible change to the editor behind it. While the PDF is being written, confirm the app remains responsive. Open the completed file in Preview and verify every page renders, the intended 18 mm top margin is present, and the PDF contains no top bar, sidebar, status bar, margin guides, image handles, or formula copy controls. Check short and multi-page preserved-source panels for clipping or an empty trailing page. Also confirm a failed or interrupted export never replaces the chosen destination with a partial PDF.
10. Build and install the native app. In Finder/Explorer, right-click a `.md` and `.markdown` file and choose **Open With → PaperCanvas**; then double-click a file after setting PaperCanvas as default. Verify both cold launch and opening a second file while PaperCanvas is already running load the requested document. With unsaved edits, verify the replacement confirmation is shown.

## Reading regression fixtures

Use `test-fixtures/reading-demo/remark-gfm-readme.md` for long outlines, reference
links/images, inline HTML, and code examples. Attribution and its MIT license
are included beside it. `reading-edge-cases.md` covers bilingual research notes,
formulas, aligned tables, mixed lists, local/missing images, and preserved source.
Use a temporary copy for intentional edits.

- Open each file, navigate links and the outline in both modes, search forward
  and backward, inspect formulas, switch modes repeatedly, and save without edits.
  Compare bytes with the original; also repeat with CRLF line endings.
- Rename a copy with a companion image folder, then Save As into another directory.
  Confirm images still display, only actual local image destinations change, and
  literal paths in prose/code/titles remain intact. Selections and comment anchors
  before, between, and after images should stay on their original text.
- Type while saving, renaming, switching files, or completing an image paste/drop.
  Confirm the latest edits stay with their originating file. A history-settings
  failure after a successful save or rename must not restore the previous path.
- In a table cell, press Enter and Shift+Enter, then add formatted text and a
  formula. Switch modes and save/reopen; every paragraph and line break must
  remain. Richer tables that GFM cannot represent retain their content as HTML previews.
- Rename an unnamed draft, including an empty one, and restart. Confirm recovery
  restores the new filename. Paste an image, immediately switch to Markdown,
  and confirm the completed image survives switching back and saving.
- Unsupported footnotes, ordered task lists, and image-containing headings/table
  cells retain recoverable Markdown source. Relative links to another Markdown
  file report a status message; they do not navigate the editor away.

Run `npm test`, `npm run lint`, `npm run build`, and `cargo test --offline` from
`src-tauri` alongside the native manual checks above.
