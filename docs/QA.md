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
  Compare bytes with the original; also repeat with CRLF line endings. Edit one
  character in source mode and confirm untouched CRLF, LF, and CR separators
  retain their original bytes. Delete across mixed separators and undo/redo;
  undo must restore their exact bytes. Newly inserted lines should use the file's separator.
- Rename a copy with a companion image folder, then Save As into another directory.
  Confirm images still display, only actual local image destinations change, and
  literal paths in prose/code/titles remain intact. Selections and comment anchors
  before, between, and after images should stay on their original text. Export
  Markdown into another directory and reopen it; images and comments must remain
  valid. Renaming or saving files ending in `.MD` or `.markdown` must not append
  a duplicate extension. In the native app, Rename must show a filename input;
  Cancel and Escape must leave the original filename intact.
  Rename must replace its old Recent entry, and renaming `note.markdown` to
  `note.markdown.md` must keep their shared image folder. Save As must accept
  `.markdown`; cancelling it must preserve the current saved/unsaved status.
- Type while saving, renaming, switching files, or completing an image paste/drop.
  Confirm the latest edits stay with their originating file. A history-settings
  failure after a successful save or rename must not restore the previous path.
  After New or Open, undo/redo must never restore the previous file's content;
  ordinary typing and Save As within the same file must retain undo/redo.
  With unsaved edits, New and Open must wait for the discard dialog; Cancel
  must retain those edits, and a delayed answer must not replace a newer file.
- In a table cell, press Enter and Shift+Enter, then add formatted text and a
  formula. Switch modes and save/reopen; every paragraph and line break must
  remain. Richer tables that GFM cannot represent retain their content as HTML previews.
- Rename an unnamed draft, including an empty one, and restart. Confirm recovery
  restores the new filename. Paste an image, immediately switch to Markdown,
  and confirm the completed image survives switching back and saving.
- Footnotes render as numbered references and editable notes. Click references
  and backlinks, edit a note, and switch modes; labels, repeated references,
  nested blocks, and formulas must remain. Ordered task lists retain their starting
  number and ordinary siblings when toggled, typed, split with Enter, or reopened.
- Navigate into a note beginning with a formula, then type in its explanation;
  the formula must remain. Follow nested notes from repeated references and
  return with backlinks; every note must return to its own last reference.
- Copy and paste numbered tasks, footnotes with math, merged table cells, and
  resized images between documents; numbering, checked states, note bodies,
  alignment, cell spans, column widths, and dimensions must survive. Copy a local
  image into another directory, save/reopen, then copy it again; its relative
  reference must still resolve to the same physical image. Save SVG diagrams
  under names containing literal `%20`, `#`, or `?`; their formats and paths
  must remain valid after reopening.
- Copy a linked image with separate image and link titles; its link and both
  titles must survive. Save or export immediately after pasting an image;
  the completed image must be included. Switching documents while waiting
  must cancel that document's delayed save or export, including PDF capture
  after a pending native save dialog.
- Save and reopen a rich table containing footnotes, numbered tasks, code with
  blank lines, and formulas. The table must remain one block. Copy its HTML
  back into Canvas; note IDs, checkbox states, formula sources, and code
  languages must survive without duplicate checkbox labels.
- Search a visible phrase crossing inline HTML such as `Press <kbd>Command</kbd>`
  or an HTML comment. Selecting that phrase before Command-F must prefill its
  visible text; selected hard breaks must retain their line boundaries. Search
  backward from the end of a document; the last occurrence must be selected first.
- Apply underline to formatted text and formulas; source switching, copying,
  editing, and save/reopen must retain it. Empty links and links whose labels
  contain only a break must retain their destination and title after a Canvas edit.
- Import display TeX inside list or footnote continuation paragraphs. The formula
  and following text must remain within the same item or note; indented code
  examples must remain literal.
- Image-containing headings/table cells retain recoverable Markdown source. Relative links to another Markdown
  file report a status message; they do not navigate the editor away.

Run `npm test`, `npm run lint`, `npm run build`, and `cargo test --offline` from
`src-tauri` alongside the native manual checks above.

## Stress and recovery checks

Use disposable documents and a separate native app identifier for deliberate
failure injection. Keep original bytes for comparison.

- Open UTF-8 with a BOM and mixed CRLF/LF/CR separators. Switch views, inspect
  formulas, search, undo/redo, and save. An untouched save must preserve all
  original bytes. Invalid UTF-8 and UTF-16 files must report an error without
  replacing their bytes with decoding substitutions.
- Externally replace, delete, or retarget the symlink of an opened document,
  then save local edits. Saving must report the conflict without overwriting or
  recreating the disk version. Unsaved writing must have an independent recovery
  copy even when its named file cannot be saved. Restart after an abrupt stop,
  save the recovered copy elsewhere, and reopen it; relative image origins and
  BOM/line-ending bytes must survive. Repeat with BOM-prefixed first-line
  inline HTML, formulas, image references, and repeated leading BOM markers;
  Canvas parsing and image path rewriting must not shift source offsets. Explicit Save As remains available.
- Type immediately before native Quit or window close. The latest writing must
  be durable before the window disappears. Inject a failed save/settings flush;
  the document must stay open with a visible error. Repeat while images are
  still loading and while typing during an in-progress save.
- Damage preferences and recent-file JSON while retaining an independent
  recovery draft. Startup must recover the writing, report the settings error,
  and preserve the damaged settings. A recovered draft with damaged comment
  metadata must retain its original recovery record until the author edits it;
  simply waiting, switching views, or quitting must not rewrite that record.
- Keep source undo/redo through repeated view switches. After a real Canvas
  replacement, source undo must never apply stale line-ending restoration or
  resurrect writing from another file. Rename and Save As path rewrites must
  retain applicable history.
- Open a formula with CRLF/CR source, enter its textarea, and save without
  typing. Browser textarea normalization must not dirty or change it. Cancel
  composition, including after a save flush, then repeat rich HTML copy/paste;
  the original formula source must survive. An empty formula deletion must not
  later delete an unrelated node.
- Capture a context-menu selection, then finish a delayed image insertion or
  normalize nearby Markdown. Copy/Cut must still target the selected text;
  deleting the selection or replacing the file must leave a valid selection.
- Probe malformed comments, long fence delimiters, overlapping marks, negative
  or overflowing ordered-list numbers, merged tables, and extreme code blocks.
  Unsupported source must remain recoverable. Code above 20,000 characters
  uses plain code styling to avoid excessive highlighting decorations.
- Open 40,000 paragraphs, a very long wrapped paragraph, and HTML containing
  40,000 elements. Documents above the Canvas budget (10,000 model/preview
  nodes or 250,000 text/source characters) open in source with an explanation.
  Source editing, search, undo, and Markdown saves retain the complete document.
  Canvas/outline requests and PDF export must not mount the oversized preview.
  An oversized Canvas insertion reports the limit and leaves the document and
  history intact; reducing source content permits Canvas again.
- Source syntax styling pauses above 250,000 characters or a 20,000-character
  line. The complete text, selections, mixed line endings and undo/redo remain
  available; reducing content or undoing the oversized insertion resumes styling.
- Open Markdown with supported local images outside the home directory. Existing
  referenced files must render without granting an entire directory. Repeat with
  HTML image references, symlinks, missing images, and Save As in another folder.
- Export PDF from Source and confirm it stays active with its selection and undo
  history. Verify all rendered pages, local images, formulas and intended margins;
  native printing must start pagination with the same margins as print CSS.
- Resolve Windows drive-root and UNC image paths, including repeated parent
  traversal. A relative path must retain its drive or server/share root. Hiding
  a recent file must not consume a visible Recent slot when it is saved again.

During the October 2026 stress campaign, native checks confirmed exact-byte
BOM/CRLF saves, safe immediate Quit, independent recovery with damaged settings,
and responsive source access plus byte-preserving undo/save for a 2 MB,
40,000-paragraph document. Further native checks confirmed a responsive
750,000-character wrapped paragraph, independent recovery after a disk conflict
and abrupt app termination, exact recovered BOM/CRLF Save As with rebased images,
and complete multi-page PDF export while Source stayed active. The seeded
Canvas history probe exercised 70,000 actions; a browser probe accepted 4,000
nested HTML blockquotes without a parser or traversal error. Native oversized
paste followed by Undo/Redo/Undo and Save preserved mixed CRLF/LF/CR bytes.
The final automated run passed 1,249 tests across 70 frontend test files and
31 native tests, along with lint, type checking, and production/native builds.
Composition and delayed-operation regressions are
also exercised by the automated editor and application suites. Real IME
behavior and Windows-native dialogs still require their platform manual checks.
