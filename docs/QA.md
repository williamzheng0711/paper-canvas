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
- Delete a local image in Source, Save As into another folder, then Undo and
  save. The restored reference must still point to the original physical image.
  Repeat with Rename and a moved companion asset folder, another Save As, and
  subsequent typing. Redo must remove the complete restored reference without
  leaving part of its rewritten URL behind; preserve mixed line endings.
  Inject a rename failure where the document returns to its original path but
  its companion folder remains renamed; Undo must use that surviving folder.
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
- Open 5 MB of unmatched TeX, backticks, prose, or headings. Source must open
  without parsing the entire Markdown tree. A shortened or partial outline must
  explain its limit, and word/character counts must remain meaningful. Preserve
  stale or ambiguous comment footers as source rather than guessing ownership.
- Search 249,980 characters containing 124,990 occurrences. Confirm the complete
  count and forward/backward wraparound; bounded highlights explain their limit.
  Add point comments while searching and confirm the combined DOM stays bounded.
  Opening 12,000 comments must show 100 cards per page and retain every ID when
  editing a later page, saving, and reopening.
- In Source, delete the space between a standalone CR and LF in `A\r \nB`.
  The two visible line breaks must survive saving/reopening, and Undo must restore
  the original exact bytes. Repeat with trailing-whitespace cleanup and Save As.
- Save As or export a source file above 250,000 characters. Image-free writing
  must preserve exact bytes. If a location change requires parsing possible image
  references beyond that budget, show an explanation before moving or writing
  files; ordinary saves to the existing path must remain available.
- In a formula source field, paste an environment that gains a closing delimiter,
  then use Undo/Redo. Both the source and rendered formula must follow editor
  history. Excessive formula expansion must retain complete source with a local
  preview warning rather than constructing an enormous preview.
  Import adjacent Typora formulas containing escaped dollars, such as
  `\(\text{\$5}\)`. Each must remain one formula with its complete source;
  formula-local image-looking text must not become a rewritten file reference.
- Open Markdown with supported local images outside the home directory. Existing
  referenced files must render without granting an entire directory. Repeat with
  HTML image references, symlinks, missing images, and Save As in another folder.
- Within disposable permitted image locations, substitute a named pipe for an
  image. Loading it must fail promptly while writing and menus remain responsive.
  Reopen a cached image, then add another relative image in Source and return to
  Canvas; both must appear immediately. Open Markdown through a symlink and paste
  an image; the companion folder must belong to the physical Markdown file.
- Export PDF from Source and confirm it stays active with its selection and undo
  history. Verify all rendered pages, local images, formulas and intended margins;
  native printing must start pagination with the same margins as print CSS.
- Export over a writable PDF and preserve its permissions. Export through a
  symlink without replacing the link. A read-only target must report failure and
  retain its previous bytes. Test long Unicode filenames and inspect every page.
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
The initial three-hour automated run passed 1,249 tests across 70 frontend test
files and 31 native tests, along with lint, type checking, and production/native
builds.

The two-hour continuation confirmed native responsiveness with a 5 MB unmatched
TeX source and 124,990 search matches, retaining complete writing and search
counts. An image backed by a named pipe failed promptly without blocking the UI.
Native Source Undo/Redo preserved distinct adjacent CR/LF separators and restored
a deleted image to its moved companion folder after Rename and Save As, saving
exact CRLF bytes. Cached and newly referenced SVG images rendered immediately.
PDF exports preserved writable target permissions and relative symlinks;
read-only targets retained their original bytes and reported failure. Exported
PDF pages were rendered and inspected. A settings-write failure retained unsaved
writing in independent recovery and prevented Quit until saving succeeded.
The final continuation run passed 1,463 tests across 74 frontend test files and
63 native tests, plus native doctests, lint, type checking, production and native
builds. Full frontend verification used two workers to avoid performance-test
contention; focused adversarial probes retained their original time limits.

## Ordinary writing continuation

- Type a GFM table with left, center, and right separator alignment. Paste its
  rich HTML into Canvas, then use Tab in the final cell to continue the table.
  Every new cell must inherit its column alignment; Undo/Redo must retain it.
- Preserve code-fence metadata and inactive duplicate reference definitions
  while editing nearby prose. Copy preserved blocks without losing their source
  or throwing a clipboard serialization error.
- Replace an entire inline-code span inside prose with plain text, formula-looking
  text, and multiple lines. Keep its code style and the surrounding prose;
  a selection containing both plain and code text must retain native paste behavior.
- Press Enter twice between writing, then save/reopen and switch modes. Keep the
  interior empty paragraph. Adjacent Typora formulas must remain separate after
  unrelated edits, and code marks on native formulas/footnotes must survive saves.
- Paste images with only width or only height, then save/reopen. Keep the specified
  dimension, title, and alt text. Saving a pasted image must not create a separate
  Undo step; Undo removes the paste and Redo restores its persisted resource.
- Paste HTML images using valid local-file URLs, including encoded filenames and
  network-share paths. Keep their source through the editor's clipboard parser.
  If a clipboard source is unavailable, preserve a nonempty image description as
  ordinary writing, with exact Undo/Redo and save/reopen behavior.
- Delete the sole image, Rename its companion folder, then Undo/Redo and save.
  Repeat with cross-directory Save As, resizing, multiple file moves, preserved
  HTML image sources, and partial rename recovery. Restored images must use the
  current physical and portable paths, including images held only by history.
  If rewriting a restored path exceeds the existing capacity/rewrite budget,
  report the limit before changing the editor or either history branch.
- Add a comment, prepend writing in Source, save, reopen, and locate the comment.
  A stale footer must relocate a unique anchor; an ambiguous stale anchor must
  request review. Current comments on repeated text must retain their positions.
- Save and reopen filenames containing spaces, parentheses, and percent signs.
  Escaped URL parentheses in image/link destinations and titles must stay literal;
  Typora formulas in ordinary link labels must still render.
- Change a formula, image description, or heading in Source, save, and return to
  Canvas. Undo/Redo must retain user-authored edits; only saved asset-path refreshes
  may bypass a separate history step.
- Export a Markdown copy over the active source, including a symlink alias. The
  application must explain that Save should be used and retain the original bytes.
  Subsequent normal Save must remain available.
- Quit while an unnamed document's first Save dialog is pending. Finish, cancel,
  fail, and type during that save; retain pending writing and recovery appropriately.
  New/Open must flush pending Canvas input before testing whether discard is needed.
- Fail or cancel an OS-requested file open at startup. Retain the recoverable
  draft and permit immediate retry of the same file; successful duplicate requests
  remain coalesced.

This continuation exercised 75,000 successful seeded Markdown/schema round trips
and 1,280 actions across 64 short editing sessions, with complete Undo/Redo replay.
Browser checks retained an ordinary bilingual document through 30 mode cycles and
20 Source editing/Undo/Redo cycles. A 350-section, approximately 59 kB multilingual
draft retained its writing through editing, exact Undo/Redo, Source conversion, and
search of all 350 repeated paragraphs. Native checks reproduced and verified code
paste, authored spacing, adjacent formulas, continued table alignment, image
dimensions, image history through Save/Rename/Save As, and comment relocation.
A one-page rich PDF was rendered and visually checked for formulas, table alignment,
spacing, code, image size, footnotes, and absence of application controls.
The final run passed 1,593 tests across 80 frontend test files and 63 native tests,
plus type checking, lint, formatting, web builds, and native QA/production builds.
The final native build also verified parenthesized image paths through edit/save/
reopen, saved Source formula Undo/Redo, and first-save pasted-image Undo/Redo.
Raw local-file image paste through the native clipboard retained its description
when the image source did not reach the parser; exact Undo/Redo, save, and reopen
were verified. The same image with existing origin metadata rendered and retained
its physical resource through first Save and Undo/Redo. Cross-application HTML
can be sanitized by the platform before editor parsing; see
[WebKit's clipboard documentation](https://webkit.org/blog/8170/clipboard-api-improvements/).
The production application was reinstalled at `/Applications/PaperCanvas.app` and
launched from that exact path. Its executable matched the release build; existing
settings and file permissions remained semantically equivalent and the recovery
draft remained byte-identical. Isolated QA settings, recovery, and permissions
were restored from their pre-campaign copies after closing the test application.

Composition and delayed-operation regressions are
also exercised by the automated editor and application suites. Real IME
behavior and Windows-native dialogs still require their platform manual checks.
