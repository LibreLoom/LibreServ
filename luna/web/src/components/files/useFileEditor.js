/**
 * Shared CodeMirror 6 mount for the drive file editors. Binds the editor to
 * a `Y.Text` via `yCollab`, so a solo session is just a document nobody else
 * has joined — the same code path serves standalone and collab editing.
 *
 * - Undo is the Yjs undo manager (`yUndoManagerKeymap`), so undo steps are
 *   per-user even mid-collab; the CM `history` extension stays off.
 * - `livePreview` toggles an extension compartment between the Obsidian-
 *   style rendered-while-typing decorations and plain syntax highlighting.
 * - The view's lifetime follows the host element (a callback ref), so a
 *   parent can swap the surface in and out — e.g. MarkdownEditor's Read
 *   mode — and get a fresh editor bound to the same shared document.
 * - Stats (cursor line/col, word count) stream up through `onStats` for the
 *   status bar.
 */

import { useCallback, useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { GFM } from "@lezer/markdown";
import { UndoManager } from "yjs";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import {
  editorBaseTheme,
  previewTheme,
  sourceTheme,
  sourceHighlighting,
} from "./editorTheme.js";
import { markdownLivePreview } from "./markdownLivePreview.js";
import {
  flushTableDrafts,
  registerTableRecoveryHandler,
  registerTableUndoManager,
  runActiveTableAction,
} from "./markdownTables.js";
import { applyMarkdownAction } from "../../lib/markdown.js";

/**
 * Run a toolbar action against a CodeMirror view. `applyMarkdownAction`
 * computes a full replacement string; we reduce it to the smallest changed
 * span before dispatching so a toolbar edit merges cleanly with concurrent
 * remote edits instead of becoming a delete-all/insert-all.
 *
 * @param {EditorView} view
 * @param {string} action
 */
export function runMarkdownAction(view, action) {
  // A focused table grid owns the inline marks and refuses block actions —
  // the document selection can't be seen while the cursor is in a cell.
  if (runActiveTableAction(view, action)) return;
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc.toString();
  const result = applyMarkdownAction(doc, from, to, action);
  if (result.text === doc) {
    view.dispatch({ selection: { anchor: result.start, head: result.end } });
  } else {
    let prefix = 0;
    const bound = Math.min(doc.length, result.text.length);
    while (prefix < bound && doc[prefix] === result.text[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < bound - prefix &&
      doc[doc.length - 1 - suffix] === result.text[result.text.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    view.dispatch({
      changes: {
        from: prefix,
        to: doc.length - suffix,
        insert: result.text.slice(prefix, result.text.length - suffix),
      },
      selection: { anchor: result.start, head: result.end },
      userEvent: "input.toolbar",
    });
  }
  view.focus();
}

/**
 * @param {string} action
 * @returns {import("@codemirror/view").Command}
 */
function actionCommand(action) {
  return (view) => {
    runMarkdownAction(view, action);
    return true;
  };
}

/** Toolbar actions on real shortcuts, plus Enter that continues lists. */
const markdownKeymap = keymap.of([
  { key: "Mod-b", run: actionCommand("bold") },
  { key: "Mod-i", run: actionCommand("italic") },
  { key: "Mod-k", run: actionCommand("link") },
  { key: "Mod-Shift-x", run: actionCommand("strikethrough") },
  { key: "Enter", run: insertNewlineContinueMarkup },
]);

/**
 * @param {{
 *   ytext: import("yjs").Text,
 *   awareness: import("y-protocols/awareness").Awareness | null,
 *   canWrite?: boolean,
 *   markdown?: boolean,
 *   livePreview?: boolean,
 *   resolveImage?: (src: string) => string | null,
 *   onStats?: (stats: { line: number, col: number, words: number }) => void,
 *   onTableRecovery?: (text: string) => void,
 *   ariaLabel?: string,
 * }} opts
 * @returns {{
 *   attachHost: (host: HTMLDivElement | null) => void,
 *   viewRef: import("react").RefObject<EditorView | null>,
 * }}
 */
export function useFileEditor({
  ytext,
  awareness,
  canWrite = true,
  markdown: isMarkdown = false,
  livePreview = true,
  resolveImage,
  onStats,
  onTableRecovery,
  ariaLabel = "File contents",
}) {
  const viewRef = useRef(/** @type {EditorView | null} */ (null));
  const modeCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());
  const undoManagerRef = useRef(/** @type {UndoManager | null} */ (null));
  // Latest options for (re)mounts — the callback ref reads these, so a host
  // that remounts mid-session gets the current mode rather than the first.
  const optsRef = useRef({ livePreview, resolveImage, canWrite, ariaLabel, onStats, onTableRecovery });
  optsRef.current = { livePreview, resolveImage, canWrite, ariaLabel, onStats, onTableRecovery };

  const attachHost = useCallback(
    (/** @type {HTMLDivElement | null} */ host) => {
      if (viewRef.current) {
        const prev = viewRef.current;
        viewRef.current = null;
        // Commit live cell drafts while the view is still whole — widget
        // teardown never writes, so this is the last chance to land text.
        // A read-only view skips the flush entirely: a commit would be a
        // write, and the draft moves to recovery instead.
        if (isMarkdown) flushTableDrafts(prev, optsRef.current.canWrite);
        const prevHost = /** @type {HTMLElement & { __cmView?: EditorView }} */ (
          prev.dom.parentElement
        );
        if (prevHost?.__cmView === prev) {
          delete prevHost.__cmView;
        }
        prev.destroy();
        undoManagerRef.current?.destroy();
        undoManagerRef.current = null;
      }
      if (!host) return;

      const opts = optsRef.current;
      // One UndoManager per mounted view, shared between yCollab and the
      // table controllers so grid edits and document edits undo together.
      const undoManager = new UndoManager(ytext);
      undoManagerRef.current = undoManager;
      const previewExtensions = isMarkdown
        ? [previewTheme, markdownLivePreview({ resolveImage: opts.resolveImage })]
        : [];

      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          // ySyncPlugin only observes FUTURE ytext changes — the initial doc
          // must be seeded here or a view mounted after hydration (or any
          // remount) renders empty until the next remote edit.
          doc: ytext.toString(),
          extensions: [
            editorBaseTheme,
            EditorView.lineWrapping,
            drawSelection(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            search({ top: true }),
            isMarkdown
              ? markdown({ extensions: [GFM], codeLanguages: languages })
              : [],
            modeCompartment.current.of(
              opts.livePreview
                ? previewExtensions
                : [sourceTheme, sourceHighlighting],
            ),
            editableCompartment.current.of([
              EditorView.editable.of(opts.canWrite),
              EditorView.contentAttributes.of({ "aria-label": opts.ariaLabel }),
            ]),
            yCollab(ytext, awareness || undefined, { undoManager }),
            isMarkdown ? markdownKeymap : [],
            keymap.of([
              ...yUndoManagerKeymap,
              ...searchKeymap,
              indentWithTab,
              ...defaultKeymap,
            ]),
            EditorView.updateListener.of((update) => {
              if (!update.selectionSet && !update.docChanged) return;
              const cb = optsRef.current.onStats;
              if (!cb) return;
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              const text = update.state.doc.toString();
              const words = text.trim() ? text.trim().split(/\s+/).length : 0;
              cb({
                line: line.number,
                col: head - line.from + 1,
                words,
              });
            }),
          ],
        }),
      });
      // Test/debug handle: the host element carries the view.
      /** @type {HTMLDivElement & { __cmView?: EditorView }} */ (host).__cmView = view;
      if (isMarkdown) {
        registerTableUndoManager(view, undoManager);
        // Recovered draft text goes to the editor-owned panel so it
        // survives view teardowns and mode flips — not just the next grid.
        registerTableRecoveryHandler(view, (text) =>
          optsRef.current.onTableRecovery?.(text),
        );
      }
      viewRef.current = view;
    },
    [ytext, awareness, isMarkdown],
  );

  // Reconfigure the preview/source compartment on mode flips.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isMarkdown) return;
    // Land any in-progress cell edit before the widgets are swapped out —
    // never when write permission is off (a flush would be a write).
    flushTableDrafts(view, canWrite);
    view.dispatch({
      effects: modeCompartment.current.reconfigure(
        livePreview
          ? [previewTheme, markdownLivePreview({ resolveImage })]
          : [sourceTheme, sourceHighlighting],
      ),
    });
  }, [livePreview, isMarkdown, resolveImage, canWrite]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (isMarkdown && canWrite) flushTableDrafts(view);
    view.dispatch({
      effects: editableCompartment.current.reconfigure([
        EditorView.editable.of(canWrite),
        EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
      ]),
    });
  }, [canWrite, ariaLabel, isMarkdown]);

  return { attachHost, viewRef };
}
