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
6. Close/reopen `notes.md`, toggle **顯示原始 Markdown**, and verify the editor never changes into a simultaneous split source/preview view.
7. Resize, minimize, and maximize the window. Confirm the fine vertical page-margin lines remain visible, both outer margins stay the same width, and the text line length grows with a wider desktop window. Check the sidebar still collapses and the central canvas remains the only primary editor.
8. Open **導出** and export both formats. Confirm Markdown opens a save dialog for a `.md` copy without changing the active document path. On macOS, confirm PDF opens a direct save dialog without a print-preview panel or any visible change to the editor behind it. While the PDF is being written, confirm the app remains responsive. Open the completed file in Preview and verify every page renders, the intended 18 mm top margin is present, and the PDF contains no top bar, sidebar, status bar, margin guides, image handles, or formula copy controls. Also confirm a failed or interrupted export never replaces the chosen destination with a partial PDF.
9. Build and install the native app. In Finder/Explorer, right-click a `.md` and `.markdown` file and choose **Open With → PaperCanvas**; then double-click a file after setting PaperCanvas as default. Verify both cold launch and opening a second file while PaperCanvas is already running load the requested document. With unsaved edits, verify the replacement confirmation is shown.
