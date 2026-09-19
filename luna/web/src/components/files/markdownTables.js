/**
 * CodeMirror side of the Markdown table editor. A top-level `Table` syntax
 * node is replaced by a stable grid widget: React (MarkdownTableEditor.jsx)
 * renders the cells and the pill dock, while `TableController` below owns
 * every mutation — selection, the in-progress cell draft, structure
 * operations, clipboard ranges, source spans and Yjs undo grouping.
 *
 * Scalar cell edits replace only that cell's source span; structural edits
 * recompute the model from the latest block text and dispatch a
 * prefix/suffix-reduced replacement, so collab merges stay small and the
 * file remains honest pipe-table text. Column widths live on the controller
 * only — never in the file. Raw source stays reachable through the table
 * menu's Markdown view and the editor's Source mode.
 */

import { EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import MarkdownTableEditor from "./MarkdownTableEditor.jsx";
import { applyMarkdownAction } from "../../lib/markdown.js";
import {
  MAX_CLIPBOARD_CELLS,
  MAX_CLIPBOARD_COLS,
  TABLE_CLIPBOARD_MIME,
  clearTableCells,
  decodeTableCell,
  deleteTableCols,
  deleteTableRows,
  duplicateTableCols,
  duplicateTableRows,
  encodeTableCell,
  fillTableCells,
  insertTableCols,
  insertTableRows,
  moveColumnWidths,
  moveTableCols,
  moveTableRows,
  normalizeClipboardCell,
  parseMarkdownTable,
  parseTableClipboard,
  parseTableDocument,
  pasteTableRows,
  serializeDelimitedRows,
  serializeMarkdownTable,
  setTableAlign,
  setTableCell,
  sortTableRows,
  splitTableLine,
  tableCellValue,
  tableSelection,
  validateTableRows,
} from "./markdownTableModel.js";

export { TABLE_CLIPBOARD_MIME, MIN_COL_PX, DEFAULT_COL_PX, GUTTER_PX };

// Re-exported so existing callers keep working while the model lives in
// markdownTableModel.js.
export {
  parseMarkdownTable,
  serializeMarkdownTable,
  splitTableLine,
  tableSelection,
  encodeTableCell,
  parseTableClipboard,
  serializeDelimitedRows,
  parseTableDocument,
};

const MIN_COL_PX = 120;
const DEFAULT_COL_PX = 180;
const GUTTER_PX = 40;
const FIT_MAX_PX = 480;
const MESSAGE_MS = 4500;
const CELL_ACTIONS = new Set(["bold", "italic", "strikethrough", "code", "link"]);
const ACTION_LABELS = {
  heading: "Heading",
  list: "List",
  task: "Checklist",
  quote: "Quote",
  codeblock: "Code block",
  hr: "Divider",
  table: "Table",
};

/** @type {WeakMap<EditorView, Set<TableController>>} */
const controllersByView = new WeakMap();
/** @type {WeakMap<EditorView, TableController>} */
const activeByView = new WeakMap();
/** @type {WeakMap<EditorView, { undo: () => void, redo: () => void, stopCapturing?: () => void }>} */
const undoManagerByView = new WeakMap();
/**
 * Focus hand-off across grid mounts: insertMarkdownTable (or a structural
 * edit that rebuilds the DOM) stashes the cell to claim once React renders.
 * @type {WeakMap<EditorView, { from: number, r: number, c: number }>}
 */
const pendingFocus = new WeakMap();
/**
 * Draft text kept when a widget dies mid-edit (remote delete, mode flip).
 * The next grid that mounts on the same view offers it back for copying —
 * the buffer is never written back to a document it no longer matches.
 * @type {WeakMap<EditorView, { text: string }[]>}
 */
const draftRecovery = new WeakMap();
/**
 * Editor-owned recovery sink: when the host registered a handler (the
 * MarkdownEditor recovery panel), recovered draft text goes there instead
 * of waiting for another grid — so a deleted table or a Read/Source flip
 * still surfaces the text. Bare controllers keep the WeakMap fallback.
 * @type {WeakMap<EditorView, (text: string) => void>}
 */
const recoveryHandlerByView = new WeakMap();

/**
 * Wire the Yjs undo manager the editor created into the table widgets.
 * Called once per mounted view by useFileEditor; grids can mount before the
 * call (initial doc already holding a table), so existing controllers are
 * updated in place, not just future ones.
 * @param {EditorView} view @param {object} undoManager
 */
export function registerTableUndoManager(view, undoManager) {
  undoManagerByView.set(view, undoManager);
  for (const ctrl of controllersByView.get(view) ?? []) {
    if (!ctrl.disposed) ctrl.undoManager = undoManager;
  }
}

/**
 * A recovery handler the editor mounts once per view — recovered draft
 * text is offered to it (via a microtask, never inside a view update) so
 * the user can copy it even when no grid survives.
 * @param {EditorView} view @param {(text: string) => void} handler
 */
export function registerTableRecoveryHandler(view, handler) {
  recoveryHandlerByView.set(view, handler);
}

/**
 * Commit every live cell draft on the view — call BEFORE a reconfigure or
 * teardown dispatch (mode flip, permission change, view destroy) while the
 * view is not inside an update, so committed text lands in the document.
 * `allowWrite` false refuses the commits: losing write permission (or a
 * teardown on a read-only view) must not create a write — drafts stay
 * buffered for the recovery path instead.
 * @param {EditorView} view @param {boolean} [allowWrite]
 */
export function flushTableDrafts(view, allowWrite = true) {
  if (!allowWrite) return;
  for (const ctrl of controllersByView.get(view) ?? []) {
    if (ctrl.disposed || !ctrl.draft) continue;
    try {
      ctrl.commitDraft(null);
    } catch {
      /* conflict paths keep the draft; teardown moves it to recovery */
    }
  }
}

/**
 * Live controllers for a view — used by the entry hook (focus the grid when
 * the document cursor lands inside a table range) and by tests.
 * @param {EditorView} view @returns {TableController[]}
 */
export function tableControllers(view) {
  return [...(controllersByView.get(view) ?? [])];
}

/**
 * Route a toolbar action at the active table's grid. Returns true when a
 * table owned the action (handled or refused with a notice) — false lets
 * the caller run the normal document-level markdown action.
 * @param {EditorView} view @param {string} action
 */
export function runActiveTableAction(view, action) {
  const ctrl = activeByView.get(view);
  if (!ctrl || ctrl.disposed) return false;
  return ctrl.toolbarAction(action);
}

/**
 * Insert a new pipe table as its own block at the selection, then focus the
 * first header cell once the grid mounts.
 * @param {EditorView} view
 * @param {{ columns?: number, rows?: number, data?: { header?: string[], body?: string[][] } | string[][] }} [opts]
 *   `data` supplies imported values: a {header, body} model or raw rows
 *   (first row becomes the header).
 */
export function insertMarkdownTable(view, { columns = 3, rows = 3, data = null } = {}) {
  if (!view.state.facet(EditorView.editable)) return false;
  let model;
  if (data) {
    const rawHeader = Array.isArray(data) ? (data[0] ?? []) : (data.header ?? []);
    const bodyRows = Array.isArray(data) ? data.slice(1) : (data.body ?? []);
    // Bounds-check before any rectangular allocation — a missing header
    // stands in as one placeholder row for the product check.
    const checkRows = [
      Array.isArray(rawHeader) && rawHeader.length ? rawHeader : [""],
      ...bodyRows,
    ];
    if (validateTableRows(checkRows)) return false;
    const header = Array.isArray(rawHeader) ? rawHeader : [];
    const cols = Math.max(1, header.length, ...bodyRows.map((r) => r.length));
    model = {
      header: Array.from({ length: cols }, (_, i) => header[i] ?? `Column ${i + 1}`),
      align: Array.from({ length: cols }, () => ""),
      body: bodyRows.map((r) =>
        Array.from({ length: cols }, (_, i) => r[i] ?? ""),
      ),
    };
  } else {
    const cols = Math.max(1, Math.min(24, columns | 0 || 3));
    const count = Math.max(0, Math.min(200, rows | 0));
    model = {
      header: Array.from({ length: cols }, () => ""),
      align: Array.from({ length: cols }, () => ""),
      body: Array.from({ length: count }, () => Array.from({ length: cols }, () => "")),
    };
  }
  const text = serializeMarkdownTable(model);
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const line = doc.lineAt(from);
  let insert;
  let pos;
  let end;
  let tableFrom;
  if (line.text.trim() === "" && from >= line.from && to <= line.to) {
    // Replace the blank line; keep a blank line after the block.
    const after = line.to < doc.length ? doc.sliceString(line.to + 1, Math.min(doc.length, line.to + 2)) : "";
    insert = text + (line.to === doc.length ? "" : after.trim() === "" ? "\n" : "\n\n");
    pos = line.from;
    end = line.to;
    tableFrom = pos;
  } else {
    insert = `\n\n${text}\n`;
    pos = line.to;
    end = line.to;
    tableFrom = pos + 2;
  }
  view.dispatch({
    changes: { from: pos, to: end, insert },
    selection: { anchor: tableFrom + text.length },
    userEvent: "input.table",
  });
  pendingFocus.set(view, { from: tableFrom, r: 0, c: 0 });
  return true;
}

/**
 * True while [from, to) still covers a top-level Table node. Guards every
 * write: if the stored range drifted (or the table was re-parsed into
 * something else), we refuse to touch the document instead of spraying
 * table text into an unrelated range.
 * @param {EditorView} view @param {number} from @param {number} to
 */
function tableRangeIntact(view, from, to) {
  let node = syntaxTree(view.state).resolveInner(from, 1);
  while (node && node.name !== "Table") node = node.parent;
  return !!node && node.from === from && node.to === to;
}

/**
 * One controller per mounted table widget. Holds the latest block range and
 * source, the parsed model + cell spans, the rectangular selection, the
 * pending draft and any remote-edit conflict — everything React renders is
 * a snapshot of this object.
 */
export class TableController {
  /**
   * @param {EditorView} view
   * @param {{ text: string, from: number, to: number, editable?: boolean }} block
   */
  constructor(view, { text, from, to, editable = true }) {
    this.view = view;
    this.from = from;
    this.to = to;
    this.editable = editable;
    this.listeners = new Set();
    /** @type {{ undo: () => void, redo: () => void, stopCapturing?: () => void } | null} */
    this.undoManager = null;
    /** @type {HTMLElement | null} widget root element (set in toDOM) */
    this.dom = null;
    /** @type {{ unmount: () => void, render: (n: object) => void } | null} */
    this._root = null;
    /** @type {{ anchor: {r:number,c:number}, head: {r:number,c:number} }} */
    this.selection = { anchor: { r: 0, c: 0 }, head: { r: 0, c: 0 } };
    /** @type {{r:number,c:number} | null} */
    this.editing = null;
    /** @type {{r:number,c:number,text:string,base:string,baseRaw:string,shape:string} | null} */
    this.draft = null;
    /** @type {{kind:"cell"|"shape", r:number, c:number, remote?:string} | null} */
    this.conflict = null;
    /** @type {string | null} */
    this.message = null;
    /** @type {null | "import" | "export" | "source" | "help" | "delete"} */
    this.dialog = null;
    /**
     * Table source captured when a dialog opened — the expected-source
     * guard for replace/delete so a remote edit while the dialog sits open
     * refuses instead of overwriting.
     * @type {string | null}
     */
    this.dialogSource = null;
    /** @type {{ start: number, end: number } | null} retained textarea range for toolbar actions */
    this.retainedSel = null;
    /** @type {{ text: string }[]} drafts recovered from a torn-down widget */
    this.recovered = [];
    this.expanded = false;
    /** @type {(number|undefined)[]} session-only column widths in px */
    this.widths = [];
    /** @type {null | {focusCell:(r:number,c:number)=>void, focusDock:()=>void, wrapTextarea:(action:string)=>void}} */
    this.ui = null;
    this.disposed = false;
    this._msgTimer = null;
    this._wantFocus = null;
    this._snapshot = null;
    this.shape = "";
    this._setSource(text);
  }

  // ── store plumbing ─────────────────────────────────────────

  /** @param {() => void} fn @returns {() => void} */
  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => {
    if (!this._snapshot) this._buildSnapshot();
    return this._snapshot;
  };

  _buildSnapshot() {
    this._snapshot = {
      model: this.model,
      source: this.source,
      from: this.from,
      to: this.to,
      cols: this.cols,
      rows: this.rows,
      selection: {
        anchor: { ...this.selection.anchor },
        head: { ...this.selection.head },
      },
      sel: this.selRect(),
      draft: this.draft ? { r: this.draft.r, c: this.draft.c, text: this.draft.text } : null,
      editing: this.editing ? { ...this.editing } : null,
      conflict: this.conflict ? { ...this.conflict } : null,
      message: this.message,
      editable: this.editable,
      expanded: this.expanded,
      dialog: this.dialog,
      dialogSource: this.dialogSource,
      recovered: this.recovered.length ? [...this.recovered] : null,
      active: activeByView.get(this.view) === this,
      widths: [...this.widths],
    };
  }

  _emit() {
    this._buildSnapshot();
    for (const fn of this.listeners) fn();
  }

  /** @param {string} text */
  _setSource(text) {
    this.source = text;
    this.parsed = parseTableDocument(text);
    this.model = this.parsed?.model ?? { header: [""], align: [""], body: [] };
    this.cols = this.model.header.length;
    this.rows = this.model.body.length;
    this.shape = `${this.rows}x${this.cols}`;
    this._clampSelection();
  }

  /**
   * The widget moved or its text changed (local or remote edit). Re-parse,
   * refresh the live range, and — while a draft is open — detect whether a
   * remote change collides with it instead of silently overwriting.
   */
  updateBlock(text, from, to, editable) {
    if (this.disposed) return;
    this.from = from;
    this.to = to;
    const editableChanged = this.editable !== editable;
    this.editable = editable;
    if (editableChanged && !editable && this.draft) {
      // Losing write permission must not write: the draft stays buffered
      // read-only so its text can be copied out.
      this._notice(
        "Editing switched off — your draft text is kept in the cell so you can copy it.",
      );
    }
    if (text === this.source && !editableChanged) {
      this._emit();
      return;
    }
    this._setSource(text);
    if (this.draft) {
      const cell = this.parsed?.cells[this.draft.r]?.[this.draft.c];
      if (!cell || this.shape !== this.draft.shape) {
        this.conflict = { kind: "shape", r: this.draft.r, c: this.draft.c };
      } else if (!cell.missing && cell.raw !== this.draft.baseRaw) {
        this.conflict = {
          kind: "cell",
          r: this.draft.r,
          c: this.draft.c,
          remote: decodeTableCell(cell.raw),
        };
      } else if (cell.missing && this.draft.baseRaw !== "") {
        // The row was materialized remotely under the draft — its real
        // span now disagrees with the buffered base.
        this.conflict = {
          kind: "cell",
          r: this.draft.r,
          c: this.draft.c,
          remote: "",
        };
      }
    }
    this._emit();
  }

  _clampSelection() {
    const maxR = this.rows;
    const maxC = Math.max(0, this.cols - 1);
    for (const key of ["anchor", "head"]) {
      const p = this.selection[key];
      p.r = Math.min(Math.max(p.r, 0), maxR);
      p.c = Math.min(Math.max(p.c, 0), maxC);
    }
  }

  _rangeIntact() {
    return tableRangeIntact(this.view, this.from, this.to);
  }

  selRect() {
    return tableSelection(this.selection.anchor, this.selection.head);
  }

  _markActive() {
    const prev = activeByView.get(this.view);
    activeByView.set(this.view, this);
    // Emitted AFTER the swap so the previous table's snapshot already
    // reports active:false — never a stale "I'm active" repaint.
    if (prev && prev !== this && !prev.disposed) prev._emit();
  }

  _markInactive() {
    if (activeByView.get(this.view) === this) {
      activeByView.delete(this.view);
      this.retainedSel = null;
      this._emit();
    }
  }

  /** @param {string} text */
  _notice(text) {
    this.message = text;
    if (this._msgTimer) clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => {
      if (this.message === text) {
        this.message = null;
        this._emit();
      }
    }, MESSAGE_MS);
  }

  /** Transient status-line notice (same mechanism, public name). */
  flash(text) {
    this._notice(text);
    this._emit();
  }

  _canWrite() {
    return this.editable && this.view.state.facet(EditorView.editable);
  }

  /**
   * Dispatch a table-block change as one isolated Yjs undo step: split the
   * capture window around it so it never merges with adjacent typing. The
   * dispatch is synchronous — mutating commands only ever run from UI event
   * handlers; if one ever lands inside a view update, dispatch throws and
   * the caller fails with a notice instead of replaying a stale spec.
   * @param {object} spec
   */
  _dispatchUndoable(spec) {
    this.undoManager?.stopCapturing?.();
    try {
      this.view.dispatch(spec);
    } catch {
      this.undoManager?.stopCapturing?.();
      this._notice("The document is mid-update — try that again.");
      this._emit();
      return false;
    }
    this.undoManager?.stopCapturing?.();
    return true;
  }

  // ── selection ──────────────────────────────────────────────

  /**
   * @param {{r:number,c:number}} anchor @param {{r:number,c:number}} [head]
   * @param {{focus?: boolean}} [opts]
   */
  select(anchor, head = anchor, opts = {}) {
    this.selection = { anchor: { ...anchor }, head: { ...head } };
    this._clampSelection();
    this.retainedSel = null;
    if (opts.focus !== false) this._wantFocus = { ...this.selection.head };
    this._markActive();
    this._emit();
  }

  /** A grid cell received DOM focus — claim active-table status only. */
  noteGridFocus() {
    this._markActive();
    this._emit();
  }

  selectAll() {
    this.select({ r: 0, c: 0 }, { r: this.rows, c: this.cols - 1 });
  }

  /**
   * Focus the grid cell closest to a document position — the entry hook for
   * cursor/keyboard paths that land inside the (replaced) table range.
   * @param {number} pos absolute doc position
   */
  focusDocPosition(pos) {
    const cells = this.parsed?.cells;
    if (!cells) return;
    const rel = pos - this.from;
    let best = { r: 0, c: 0 };
    let bestDist = Infinity;
    for (let r = 0; r < cells.length; r += 1) {
      for (let c = 0; c < cells[r].length; c += 1) {
        const span = cells[r][c];
        if (rel >= span.from && rel <= span.to) {
          best = { r, c };
          bestDist = -1;
          break;
        }
        const mid = (span.from + span.to) / 2;
        const dist = Math.abs(rel - mid);
        if (dist < bestDist) {
          bestDist = dist;
          best = { r, c };
        }
      }
      if (bestDist === -1) break;
    }
    this._markActive();
    this.select(best, best);
  }

  // ── cell drafts ────────────────────────────────────────────

  /**
   * Open the textarea for a cell. `initial` seeds a replacement draft
   * (printable-key typing); otherwise the draft starts from the cell value.
   * An open draft on a different cell commits first — when that commit is
   * blocked by a remote-edit conflict the transition is refused so the
   * draft is never silently dropped or written over someone else's text.
   */
  startEdit(r, c, initial = null) {
    if (!this._canWrite()) {
      this.select({ r, c });
      return;
    }
    if (this.draft && (this.draft.r !== r || this.draft.c !== c)) {
      if (!this._commitDraftNow(null, 0)) return false;
    }
    const cell = this.parsed?.cells[r]?.[c];
    const current = tableCellValue(this.model, r, c);
    this.editing = { r, c };
    this.draft = {
      r,
      c,
      text: initial ?? current,
      base: current,
      baseRaw: cell?.missing ? "" : (cell?.raw ?? ""),
      shape: this.shape,
    };
    this.selection = { anchor: { r, c }, head: { r, c } };
    this.retainedSel = null;
    // The textarea focuses itself on mount — a queued cell-focus request
    // from the click/arrow that opened the editor would blur it right back.
    this._wantFocus = null;
    this._markActive();
    this._emit();
    return true;
  }

  /** @param {string} text */
  setDraft(text) {
    if (this.draft) {
      this.draft.text = text;
      this._emit();
    }
  }

  /**
   * Commit the draft into its cell's source span — nothing outside the span
   * is touched. `move` steers selection afterwards:
   *   down / up / next (Tab order, appends a body row past the last cell) /
   *   prev (Shift-Tab; before the first cell exits the table).
   * @param {null | "down" | "up" | "next" | "prev"} move
   */
  commitDraft(move = null) {
    if (this.disposed) return true;
    return this._commitDraftNow(move, 0);
  }

  /**
   * One commit attempt. Spans are recomputed from `this.parsed`/`this.from`
   * at call time, so when a blur lands during a CM view update the deferred
   * retry re-derives offsets against the settled document — never replaying
   * a stale change spec. A disposed controller pushes the draft text to the
   * view's recovery store instead of writing.
   * @param {null | "down" | "up" | "next" | "prev"} move
   * @param {number} attempt
   */
  _commitDraftNow(move, attempt) {
    const d = this.draft;
    if (!d) return true;
    if (this.disposed) {
      this._recoverDraftText(d.text);
      this.draft = null;
      this.editing = null;
      return true;
    }
    if (!this._canWrite() || !this._rangeIntact()) {
      this._notice("The table changed — your edit couldn't be written back.");
      this._emit();
      return false;
    }
    const appendedRow =
      move === "next" && d.r === this.rows && d.c === this.cols - 1;
    const cell = this.parsed?.cells[d.r]?.[d.c];
    if (!cell) {
      this._notice(
        "That cell isn't in the source row — use Table ▸ Markdown to edit this table's text.",
      );
      this._emit();
      return false;
    }
    const cellRaw = cell.missing ? "" : cell.raw;
    if (cellRaw !== d.baseRaw || this.shape !== d.shape) {
      this.conflict = {
        kind: this.shape !== d.shape ? "shape" : "cell",
        r: d.r,
        c: d.c,
        remote: decodeTableCell(cell.raw),
      };
      this._emit();
      return false;
    }
    const changes = this._cellChanges(d.r, d.c, d.text) ?? [];
    if (appendedRow) {
      const rowText = `| ${Array.from({ length: this.cols }, () => "").join(" | ")} |`;
      changes.push({ from: this.to, to: this.to, insert: `\n${rowText}` });
    }
    if (changes.length) {
      this.undoManager?.stopCapturing?.();
      try {
        this.view.dispatch({ changes, userEvent: "input.tableCell" });
      } catch {
        // Inside a view update (e.g. a blur while the DOM is being
        // rebuilt): retry once it settles. The re-entry recomputes spans,
        // and the baseRaw/shape guard above refuses if the table moved on.
        if (!this.disposed && attempt < 10) {
          setTimeout(() => this._commitDraftNow(move, attempt + 1), 0);
        }
        this.undoManager?.stopCapturing?.();
        // The retry recomputes spans and lands the text later — but the
        // draft hasn't landed NOW, so callers must not proceed as if it
        // had (a structural apply would race ahead of the write).
        return false;
      }
      this.undoManager?.stopCapturing?.();
    }
    this.draft = null;
    this.editing = null;
    this.conflict = null;
    this._moveAfterCommit(d, move);
    this._emit();
    return true;
  }

  /**
   * The change specs for writing `value` into cell (r, c). A normal cell is
   * a plain span replacement preserving padding. A `missing` cell (ragged
   * row) materializes ONLY its own row: pipe-separated blanks are appended
   * to the line end so the row reaches full column count — every other row
   * of the document stays byte-identical.
   * @returns {object[] | null}
   */
  _cellChanges(r, c, value) {
    const cell = this.parsed?.cells[r]?.[c];
    if (!cell) return null;
    const enc = encodeTableCell(value).trim();
    if (!cell.missing) {
      const lead = /^\s*/.exec(cell.raw)[0];
      const trail = /\s*$/.exec(cell.raw)[0];
      const insert =
        enc === "" ? (lead || trail ? " " : "") : lead + enc + trail;
      if (insert === cell.raw) return [];
      return [{ from: this.from + cell.from, to: this.from + cell.to, insert }];
    }
    const rowCells = this.parsed.cells[r];
    const realCount = rowCells.filter((x) => !x.missing).length;
    let at = cell.from;
    while (at > 0 && /[ \t\r]/.test(this.source[at - 1])) at -= 1;
    const closed = at > 0 && this.source[at - 1] === "|";
    let insert = closed ? "" : " |";
    for (let j = realCount; j < this.cols; j += 1) {
      insert += j === c ? ` ${enc} |` : "  |";
    }
    return [{ from: this.from + at, to: this.from + at, insert }];
  }

  /** Drop the draft, keep the cell selected. */
  cancelDraft() {
    this.draft = null;
    this.editing = null;
    this.conflict = null;
    this._wantFocus = { ...this.selection.head };
    this._emit();
  }

  /** @param {{r:number,c:number}} d @param {string|null} move */
  _moveAfterCommit(d, move) {
    const maxR = this.rows + (move === "next" && d.r === this.rows && d.c === this.cols - 1 ? 1 : 0);
    let target = { r: d.r, c: d.c };
    if (move === "down") target = { r: Math.min(d.r + 1, maxR), c: d.c };
    else if (move === "up") target = { r: Math.max(d.r - 1, 0), c: d.c };
    else if (move === "next") {
      if (d.c < this.cols - 1) target = { r: d.r, c: d.c + 1 };
      else if (d.r < this.rows) target = { r: d.r + 1, c: 0 };
      else target = { r: d.r + 1, c: 0 }; // appended row
    } else if (move === "prev") {
      if (d.c > 0) target = { r: d.r, c: d.c - 1 };
      else if (d.r > 0) target = { r: d.r - 1, c: this.cols - 1 };
      else {
        this.exit("before");
        return;
      }
    }
    this.selection = { anchor: { ...target }, head: { ...target } };
    this._wantFocus = { ...target };
  }

  /**
   * Write a value straight into a cell's source span (no draft) — used by
   * toolbar wraps and single-cell clipboard fills.
   */
  _commitCellValue(r, c, value) {
    const changes = this._cellChanges(r, c, value);
    if (!changes || !this._canWrite() || !this._rangeIntact()) {
      this._notice("That cell can't be written right now.");
      this._emit();
      return false;
    }
    if (!changes.length) return true;
    return this._dispatchUndoable({
      changes,
      userEvent: "input.tableCell",
    });
  }

  // ── structural edits ───────────────────────────────────────

  /**
   * Apply a model operation: flush any live draft first (a conflict blocks
   * the structure change rather than losing text), recompute from the
   * latest source, then dispatch the smallest replacement.
   * @param {(model: object) => object | null} mutate
   * @param {{ select?: {anchor:{r:number,c:number}, head?:{r:number,c:number}} }} [opts]
   */
  apply(mutate, opts = {}) {
    if (this.disposed) return false;
    if (!this._canWrite()) {
      this._notice("This file is read-only — table editing is off.");
      this._emit();
      return false;
    }
    if (this.draft && !this.commitDraft(null)) return false;
    if (!this._rangeIntact()) {
      this._notice("The table isn't where it was — undo or edit in Source mode.");
      this._emit();
      return false;
    }
    const cur = this.view.state.doc.sliceString(this.from, this.to);
    if (cur !== this.source) this._setSource(cur);
    const next = mutate(this.model);
    if (!next) return false;
    // Column widths follow the columns across structural moves.
    const moved = moveColumnWidths(this.widths, next);
    if (moved) this.widths = moved;
    const insert = serializeMarkdownTable(next);
    if (insert === cur) {
      if (opts.select) this.select(opts.select.anchor, opts.select.head);
      return true;
    }
    let pre = 0;
    const bound = Math.min(cur.length, insert.length);
    while (pre < bound && cur[pre] === insert[pre]) pre += 1;
    let suf = 0;
    while (
      suf < bound - pre &&
      cur[cur.length - 1 - suf] === insert[insert.length - 1 - suf]
    ) {
      suf += 1;
    }
    const ok = this._dispatchUndoable({
      changes: {
        from: this.from + pre,
        to: this.to - suf,
        insert: insert.slice(pre, insert.length - suf),
      },
      userEvent: "input.table",
    });
    if (!ok) return null;
    if (opts.select) this.select(opts.select.anchor, opts.select.head);
    else this._emit();
    return true;
  }

  /**
   * Replace the whole block with user-edited source (Markdown view) or an
   * import — guarded by the exact expected source so a remote change in
   * between is refused instead of overwritten.
   * @param {string} newSource @param {string} expectedSource
   * @returns {boolean}
   */
  replaceSource(newSource, expectedSource) {
    if (this.disposed) return false;
    if (!this._canWrite()) {
      this._notice("This file is read-only — table editing is off.");
      this._emit();
      return false;
    }
    if (this.draft && !this.commitDraft(null)) return false;
    if (!this._rangeIntact()) {
      this._notice("The table isn't where it was — undo or edit in Source mode.");
      this._emit();
      return false;
    }
    const cur = this.view.state.doc.sliceString(this.from, this.to);
    if (expectedSource != null && cur !== expectedSource) {
      this._notice(
        "The table changed since you opened this — close and try again.",
      );
      this._emit();
      return false;
    }
    // Paste-able sources can carry CRLF; the document is \n-normalized.
    newSource = newSource.replace(/\r\n?/g, "\n");
    if (!parseTableDocument(newSource)) {
      this._notice("That isn't a valid Markdown table.");
      this._emit();
      return false;
    }
    const ok = this._dispatchUndoable({
      changes: { from: this.from, to: this.to, insert: newSource },
      userEvent: "input.tableSource",
    });
    this._emit();
    return ok;
  }

  /**
   * Remove the whole table block (plus one trailing line break). The
   * delete-confirm dialog passes the source it captured on open, so remote
   * additions since then are rechecked and refuse instead of vanishing.
   * @param {string | null} [expectedSource]
   */
  deleteTable(expectedSource = null) {
    if (this.disposed || !this._canWrite() || !this._rangeIntact()) {
      this._notice("The table isn't where it was — close and try again.");
      this._emit();
      return false;
    }
    if (expectedSource != null) {
      const cur = this.view.state.doc.sliceString(this.from, this.to);
      if (cur !== expectedSource) {
        this._notice(
          "The table changed since you opened this — close and try again.",
        );
        this._emit();
        return false;
      }
    }
    const end = Math.min(this.to + 1, this.view.state.doc.length);
    const ok = this._dispatchUndoable({
      changes: { from: this.from, to: end, insert: "" },
      selection: { anchor: this.from },
      userEvent: "input.tableDelete",
    });
    if (!ok) return false;
    this._markInactive();
    return true;
  }

  /**
   * Leave the grid: commit any draft, then park the doc cursor OUTSIDE the
   * table text. A table sitting at the document start gets a blank
   * paragraph inserted before it so there's real prose space to land in;
   * the same applies after a table at EOF. Read-only tables never write —
   * the cursor just lands at the nearest side.
   * @param {"before" | "after"} [direction]
   */
  exit(direction = "before") {
    if (this.draft && !this.commitDraft(null)) return;
    const doc = this.view.state.doc;
    const writable = this._canWrite();
    let pos;
    if (direction === "before") {
      if (this.from === 0) {
        if (writable) {
          const ok = this._dispatchUndoable({
            changes: { from: 0, to: 0, insert: "\n\n" },
            selection: { anchor: 0 },
            userEvent: "input.tableExit",
          });
          if (!ok) return;
          pos = 0;
        } else {
          pos = 0;
        }
      } else {
        // The table's first line starts at `from`, preceded by a line
        // break — one step back lands the cursor on the line above the
        // table (a blank line when the block has the usual spacing), so
        // typing there writes prose, not table source.
        pos = this.from - 1;
      }
    } else {
      const tail = doc.sliceString(this.to, this.to + 1) === "\n" ? 1 : 0;
      pos = Math.min(this.to + tail, doc.length);
      if (pos >= doc.length && writable) {
        const ok = this._dispatchUndoable({
          changes: { from: doc.length, to: doc.length, insert: "\n\n" },
          selection: { anchor: doc.length + 2 },
          userEvent: "input.tableExit",
        });
        if (!ok) return;
        pos = doc.length + 2;
      }
    }
    try {
      this.view.dispatch({ selection: { anchor: pos } });
    } catch {
      /* a selection that can't move right now is not a failure */
    }
    this.view.focus();
    this._markInactive();
    this._emit();
  }

  /**
   * With a live draft, undo reverts the DRAFT to the cell's base content
   * (or cancels a still-pristine edit) — the previous document action is
   * left for the next undo, which goes to the shared Yjs manager.
   */
  undo() {
    if (this.draft) {
      if (this.draft.text === this.draft.base) {
        this.cancelDraft();
      } else {
        this.draft.text = this.draft.base;
        this.conflict = null;
      }
      this._emit();
      return;
    }
    this.undoManager?.undo?.();
    this._emit();
  }

  /** Redo belongs to the shared manager only while no draft is pending. */
  redo() {
    if (this.draft) {
      this._emit();
      return;
    }
    this.undoManager?.redo?.();
    this._emit();
  }

  /** @param {boolean} value */
  setExpanded(value) {
    this.expanded = value;
    this._wantFocus = { ...this.selection.head };
    this._emit();
  }

  /**
   * Open/close the active dialog. Opening commits a live draft first so the
   * captured dialogSource is authoritative, then freezes the table source —
   * replace/delete calls check against it so a remote edit while the dialog
   * sits open is refused, never overwritten.
   * @param {null | "import" | "export" | "source" | "help" | "delete"} name
   */
  setDialog(name) {
    if (name && !this.dialog) {
      if (this.draft && !this.commitDraft(null)) return;
      this.dialogSource =
        this.view.state.doc.sliceString(this.from, this.to);
    } else if (!name) {
      this.dialogSource = null;
      this._wantFocus = { ...this.selection.head };
    }
    this.dialog = name;
    this._emit();
  }

  /** @param {number} c @param {number|null} px */
  setWidth(c, px) {
    this.widths[c] = px ?? undefined;
    this._emit();
  }

  /** Approximate content-fit width — no layout reads needed. */
  fitColumn(c) {
    let longest = 0;
    for (let r = 0; r <= this.rows; r += 1) {
      longest = Math.max(longest, tableCellValue(this.model, r, c).length);
    }
    this.setWidth(c, Math.min(FIT_MAX_PX, Math.max(MIN_COL_PX, longest * 8 + 48)));
  }

  /** Fit every column inside the selection — not just the leftmost. */
  fitSelectedColumns() {
    const sel = this.selRect();
    for (let c = sel.left; c <= sel.right; c += 1) this.fitColumn(c);
  }

  /** Clear every selected cell — never a structural delete. */
  clearSelection() {
    const sel = this.selRect();
    this.apply((m) => clearTableCells(m, sel));
  }

  // ── clipboard ──────────────────────────────────────────────

  /** Selected rectangle as a raw-value grid (for the clipboard JSON). */
  selectionRows() {
    const sel = this.selRect();
    const rows = [];
    for (let r = sel.top; r <= sel.bottom; r += 1) {
      const row = [];
      for (let c = sel.left; c <= sel.right; c += 1) {
        row.push(tableCellValue(this.model, r, c));
      }
      rows.push(row);
    }
    return rows;
  }

  /** Selected rectangle as quoted TSV (for the clipboard). */
  selectionTSV() {
    return serializeDelimitedRows(this.selectionRows(), "\t");
  }

  /** Selected rectangle encoded for the in-app clipboard MIME. */
  selectionClipboardJSON() {
    return JSON.stringify({ version: 1, rows: this.selectionRows() });
  }

  /**
   * Paste an already-parsed rectangle at the selection's top-left cell —
   * the in-app clipboard path, where a one-column block still means rows.
   * The final padded size is checked BEFORE the model allocates it.
   * @param {string[][]} rows
   * @returns {boolean}
   */
  pasteRows(rows) {
    const invalid = validateTableRows(rows);
    if (invalid) {
      this._notice(invalid);
      this._emit();
      return false;
    }
    const sel = this.selRect();
    const width = Math.max(...rows.map((r) => r.length));
    // The FINAL padded table must fit the caps — not just the delta: a
    // modest paste into a large table can still cross the limit.
    const finalBody = Math.max(this.rows, sel.top + rows.length - 1);
    const finalCols = Math.max(this.cols, sel.left + width);
    if (
      finalCols > MAX_CLIPBOARD_COLS ||
      (finalBody + 1) * finalCols > MAX_CLIPBOARD_CELLS
    ) {
      this._notice(
        `That paste would make a ${finalCols}-column, ${(finalBody + 1).toLocaleString()}-row table — split the data up, or add it in smaller chunks.`,
      );
      this._emit();
      return false;
    }
    const single = rows.length === 1 && rows[0].length === 1;
    return (
      (single
        ? this.apply((m) => fillTableCells(m, sel, rows[0][0]), {
            select: { anchor: this.selection.anchor, head: this.selection.head },
          })
        : this.apply((m) => pasteTableRows(m, sel.top, sel.left, rows), {
            select: {
              anchor: { r: sel.top, c: sel.left },
              head: {
                r: sel.top + rows.length - 1,
                c: sel.left + width - 1,
              },
            },
          })) === true
    );
  }

  /**
   * Paste clipboard text at the selection's top-left cell. TSV/CSV and
   * Markdown tables expand the grid once; a single value fills the
   * selected range. Multi-line plain text lands one line per row.
   * @param {string} text
   * @returns {boolean}
   */
  pasteText(text) {
    const result = parseTableClipboard(text, "auto");
    if (result.error) {
      this._notice(result.error);
      this._emit();
      return false;
    }
    const rows = result.rows.map((row) => row.map(normalizeClipboardCell));
    const ok = this.pasteRows(rows);
    if (ok && result.normalizedLineBreaks) {
      this._notice(
        "Line breaks inside cells became spaces — Markdown table cells are single-line.",
      );
      this._emit();
    }
    return ok;
  }

  // ── row / column / table commands ──────────────────────────

  /** Selected body-row interval (header excluded), or null. */
  _rowInterval() {
    const sel = this.selRect();
    const lo = Math.max(sel.top, 1);
    const hi = Math.min(sel.bottom, this.rows);
    return lo <= hi ? [lo, hi] : null;
  }

  _colInterval() {
    const sel = this.selRect();
    return [sel.left, sel.right];
  }

  /** @param {"above"|"below"} where */
  insertRowCommand(where) {
    const sel = this.selRect();
    // Header-only selection (bottom 0): "below" inserts at the top of the
    // body (at=1), not after the first body row.
    const at = where === "above" ? Math.max(1, sel.top) : Math.max(1, sel.bottom + 1);
    this.apply((m) => insertTableRows(m, at, 1), {
      select: { anchor: { r: at, c: sel.left }, head: { r: at, c: sel.right } },
    });
  }

  /** @param {"left"|"right"} where */
  insertColCommand(where) {
    const sel = this.selRect();
    const at = where === "left" ? sel.left : sel.right + 1;
    this.apply((m) => insertTableCols(m, at, 1), {
      select: { anchor: { r: sel.top, c: at }, head: { r: sel.bottom, c: at } },
    });
  }

  appendRow() {
    return this.apply((m) => insertTableRows(m, this.rows + 1, 1), {
      select: { anchor: { r: this.rows + 1, c: 0 } },
    });
  }

  appendCol() {
    return this.apply((m) => insertTableCols(m, this.cols, 1), {
      select: { anchor: { r: 0, c: this.cols } },
    });
  }

  /**
   * Tab key on the selected (not editing) grid — the same cell order the
   * editor commits through: forward wraps rows, the final Tab appends one
   * body row, Shift-Tab before the first header cell exits the table.
   * @param {1|-1} dir
   */
  gridTab(dir) {
    const h = this.selection.head;
    if (dir > 0) {
      if (h.c < this.cols - 1) this.select({ r: h.r, c: h.c + 1 });
      else if (h.r < this.rows) this.select({ r: h.r + 1, c: 0 });
      else this.appendRow();
    } else {
      if (h.c > 0) this.select({ r: h.r, c: h.c - 1 });
      else if (h.r > 0) this.select({ r: h.r - 1, c: this.cols - 1 });
      else this.exit("before");
    }
  }

  /**
   * Copy the table's Markdown to the system clipboard. Success is reported
   * only after the write actually resolves — no API, no claim.
   */
  async copyMarkdown() {
    const text = this.exportText("markdown", false);
    if (!navigator.clipboard?.writeText) {
      this._notice(
        "Couldn't reach the clipboard — use Table ▸ Export and copy the text.",
      );
      this._emit();
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      this._notice(
        "Couldn't reach the clipboard — use Table ▸ Export and copy the text.",
      );
      this._emit();
      return false;
    }
    this._notice("Table Markdown copied.");
    this._emit();
    return true;
  }

  /** @param {-1|1} dir */
  moveRowCommand(dir) {
    const interval = this._rowInterval();
    if (!interval) {
      this._notice("Select a body row first — the header row stays put.");
      this._emit();
      return;
    }
    const [lo, hi] = interval;
    const ok = this.apply((m) => moveTableRows(m, lo, hi, dir), {
      select: {
        anchor: { r: lo + dir, c: this.selection.anchor.c },
        head: { r: hi + dir, c: this.selection.head.c },
      },
    });
    if (ok === false) {
      this._notice(dir < 0 ? "Already at the top." : "Already at the bottom.");
      this._emit();
    }
  }

  /** @param {-1|1} dir */
  moveColCommand(dir) {
    const [lo, hi] = this._colInterval();
    const ok = this.apply((m) => moveTableCols(m, lo, hi, dir), {
      select: {
        anchor: { r: this.selection.anchor.r, c: lo + dir },
        head: { r: this.selection.head.r, c: hi + dir },
      },
    });
    if (ok === false) {
      this._notice(
        dir < 0 ? "Already at the left edge." : "Already at the right edge.",
      );
      this._emit();
    }
  }

  duplicateRowCommand() {
    const interval = this._rowInterval();
    if (!interval) {
      this._notice("Select a body row first — the header row can't be duplicated here.");
      this._emit();
      return;
    }
    const [lo, hi] = interval;
    const count = hi - lo + 1;
    this.apply((m) => duplicateTableRows(m, lo, hi), {
      select: {
        anchor: { r: hi + 1, c: this.selection.anchor.c },
        head: { r: hi + count, c: this.selection.head.c },
      },
    });
  }

  duplicateColCommand() {
    const [lo, hi] = this._colInterval();
    const count = hi - lo + 1;
    this.apply((m) => duplicateTableCols(m, lo, hi), {
      select: {
        anchor: { r: this.selection.anchor.r, c: hi + 1 },
        head: { r: this.selection.head.r, c: hi + count },
      },
    });
  }

  clearRowCommand() {
    const sel = this.selRect();
    this.apply((m) => clearTableCells(m, { ...sel, left: 0, right: this.cols - 1 }));
  }

  clearColCommand() {
    const sel = this.selRect();
    this.apply((m) => clearTableCells(m, { ...sel, top: 0, bottom: this.rows }));
  }

  deleteRowCommand() {
    const interval = this._rowInterval();
    if (!interval) {
      this._notice("The header row can't be deleted — clear it instead.");
      this._emit();
      return;
    }
    const [lo, hi] = interval;
    this.apply((m) => deleteTableRows(m, lo, hi), {
      select: {
        anchor: { r: Math.max(0, lo - 1), c: this.selection.anchor.c },
      },
    });
  }

  deleteColCommand() {
    const [lo, hi] = this._colInterval();
    if (this.cols <= 1 || hi - lo + 1 >= this.cols) {
      this._notice(
        "A table needs at least one column — delete the table instead.",
      );
      this._emit();
      return;
    }
    this.apply((m) => deleteTableCols(m, lo, hi), {
      select: {
        anchor: { r: this.selection.anchor.r, c: Math.max(0, lo - 1) },
      },
    });
  }

  /** @param {""|"left"|"center"|"right"} align */
  alignCommand(align) {
    const [lo, hi] = this._colInterval();
    this.apply((m) => setTableAlign(m, lo, hi, align), {
      select: { anchor: this.selection.anchor, head: this.selection.head },
    });
  }

  /** Sort by the single selected column — anything wider is refused. */
  sortAllowed() {
    const sel = this.selRect();
    return sel.left === sel.right;
  }

  /** @param {1|-1} dir */
  sortCommand(dir) {
    if (!this.sortAllowed()) {
      this._notice("Sort needs exactly one column selected.");
      this._emit();
      return;
    }
    const c = this.selRect().left;
    const ok = this.apply((m) => sortTableRows(m, c, dir));
    if (ok === true) {
      this._notice(
        `Rows sorted by column ${c + 1} (${dir > 0 ? "A→Z" : "Z→A"}) — the header row stays put.`,
      );
      this._emit();
    }
  }

  /**
   * Paste imported rows: `mode` = "insert" (at the selection's top-left) or
   * "replace" (whole table).
   * @param {string[][]} rows @param {boolean} firstRowHeadings
   * @param {"insert"|"replace"} mode
   */
  applyImport(rows, firstRowHeadings, mode) {
    const invalid = validateTableRows(rows);
    if (invalid) {
      this._notice(invalid);
      this._emit();
      return false;
    }
    // Both modes guard against a remote change since the dialog opened —
    // "Paste at selection" needs this early check because it never goes
    // through replaceSource's expected-source compare.
    if (this.dialogSource !== null && this.source !== this.dialogSource) {
      this.flash(
        "The table changed since you opened this — close and try again.",
      );
      return false;
    }
    if (mode === "replace") {
      const cols = Math.max(...rows.map((r) => r.length));
      const header = firstRowHeadings
        ? rows[0]
        : Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);
      const bodyRows = firstRowHeadings ? rows.slice(1) : rows;
      const model = {
        header: Array.from({ length: cols }, (_, i) => header[i] ?? ""),
        align: Array.from({ length: cols }, () => ""),
        body: bodyRows.map((r) =>
          Array.from({ length: cols }, (_, i) => r[i] ?? ""),
        ),
      };
      return (
        this.replaceSource(
          serializeMarkdownTable(model),
          this.dialogSource ?? this.source,
        ) === true
      );
    }
    return this.pasteRows(rows);
  }

  /**
   * Export the table. @param {"markdown"|"csv"|"tsv"} format
   * @param {boolean} safe spreadsheet-formula guard for csv/tsv
   * @returns {string}
   */
  exportText(format, safe) {
    if (format === "markdown") return this.source;
    const rows = [this.model.header, ...this.model.body];
    return serializeDelimitedRows(rows, format === "csv" ? "," : "\t", safe);
  }

  // ── toolbar integration ────────────────────────────────────

  /**
   * A formatting action while this table owns focus. Priority: a live
   * textarea (its real selection is wrapped), then a selection retained
   * from a textarea that just blurred toward the dock, then every cell in
   * the selected rectangle — not just the head. Block-level actions are
   * refused with a notice instead of touching a stale document selection.
   * @param {string} action
   */
  toolbarAction(action) {
    if (action === "table") return false; // table creation stays global
    if (!this._canWrite()) {
      this._notice("This file is read-only — table editing is off.");
      this._emit();
      return true;
    }
    if (!CELL_ACTIONS.has(action)) {
      this._notice(
        `${ACTION_LABELS[action] ?? "That formatting"} isn't available inside a table — it would apply to a cell, not the document.`,
      );
      this._emit();
      return true;
    }
    if (this.editing && this.ui?.wrapTextarea) {
      this.ui.wrapTextarea(action);
      return true;
    }
    const range = this.retainedSel;
    this.retainedSel = null;
    if (range) {
      const { r, c } = this.selection.head;
      const value = tableCellValue(this.model, r, c);
      const res = applyMarkdownAction(
        value,
        Math.min(range.start, value.length),
        Math.min(range.end, value.length),
        action,
      );
      if (res.text !== value) this._commitCellValue(r, c, res.text);
      return true;
    }
    const sel = this.selRect();
    /** @type {{r:number, c:number, text:string}[]} */
    const edits = [];
    let hasMissing = false;
    for (let r = sel.top; r <= sel.bottom; r += 1) {
      for (let c = sel.left; c <= sel.right; c += 1) {
        if (this.parsed?.cells[r]?.[c]?.missing) hasMissing = true;
        const value = tableCellValue(this.model, r, c);
        const res = applyMarkdownAction(value, 0, value.length, action);
        if (res.text !== value) edits.push({ r, c, text: res.text });
      }
    }
    if (!edits.length) return true;
    if (hasMissing) {
      // Ragged rows need their source materialized — one structural write.
      this.apply((m) => {
        let next = m;
        for (const e of edits) next = setTableCell(next, e.r, e.c, e.text);
        return next;
      });
      return true;
    }
    const changes = [];
    for (const e of edits) {
      const cellChanges = this._cellChanges(e.r, e.c, e.text);
      if (cellChanges) changes.push(...cellChanges);
    }
    if (changes.length) {
      this._dispatchUndoable({ changes, userEvent: "input.tableCell" });
    }
    return true;
  }

  /**
   * Conflict resolution: "mine" force-commits the draft over the remote
   * value, "theirs" discards the draft, "copy" copies the draft text —
   * and KEEPS the draft: copying is not resolving. A failed or missing
   * clipboard API leaves the draft selectable so nothing is lost.
   * @param {"mine"|"theirs"|"copy"} choice
   * @returns {Promise<boolean> | boolean}
   */
  resolveConflict(choice) {
    const d = this.draft;
    if (!this.conflict || !d) {
      this.conflict = null;
      this._emit();
      return true;
    }
    if (choice === "copy") {
      const write = navigator.clipboard?.writeText;
      if (!write) {
        this._notice(
          "Copy failed — your draft is still here; select and copy it manually.",
        );
        this._emit();
        return false;
      }
      return write
        .call(navigator.clipboard, d.text)
        .then(() => {
          this._notice("Your draft text was copied — pick how to continue.");
          this._emit();
          return true;
        })
        .catch(() => {
          this._notice(
            "Copy failed — your draft is still here; select and copy it manually.",
          );
          this._emit();
          return false;
        });
    }
    if (choice === "theirs") {
      this.draft = null;
      this.editing = null;
      this.conflict = null;
      this._wantFocus = { ...this.selection.head };
      this._emit();
      return true;
    }
    // "mine": re-base the draft onto the current span, then commit.
    const cell = this.parsed?.cells[d.r]?.[d.c];
    if (!cell) {
      this._notice(
        "That cell no longer exists — use “Copy my text” and pick “Use updated”.",
      );
      this._emit();
      return false;
    }
    d.baseRaw = cell.missing ? "" : cell.raw;
    d.shape = this.shape;
    this.conflict = null;
    return this.commitDraft(null);
  }

  // ── React bridge ───────────────────────────────────────────

  /** @param {TableController["ui"]} ui */
  attachUI(ui) {
    this.ui = ui;
  }

  /** Cell to focus after the next render (consumed by the component). */
  takeFocusRequest() {
    const want = this._wantFocus;
    this._wantFocus = null;
    return want;
  }

  /**
   * Stash a textarea's selection range before it blurs toward a dock
   * control — the next toolbarAction applies to that range, once.
   * @param {number} start @param {number} end
   */
  retainSelection(start, end) {
    this.retainedSel = { start, end };
  }

  /**
   * Move a doomed draft's text to the editor's recovery sink when one is
   * registered — the host's recovery panel survives view teardown and
   * mode flips, so the text is reachable even with no grid left. Without
   * a handler (bare test controllers) the view-level store keeps the
   * "next grid offers it back" fallback.
   * @param {string} text
   */
  _recoverDraftText(text) {
    if (!text) return;
    const handler = recoveryHandlerByView.get(this.view);
    if (handler) {
      queueMicrotask(() => handler(text));
      return;
    }
    const list = draftRecovery.get(this.view) ?? [];
    list.push({ text });
    draftRecovery.set(this.view, list);
  }

  /** Pull any drafts recovered from earlier torn-down widgets. */
  takeRecoveredDrafts() {
    const list = draftRecovery.get(this.view);
    if (!list?.length) return false;
    draftRecovery.delete(this.view);
    this.recovered.push(...list);
    this._emit();
    return true;
  }

  async copyRecovered(index = this.recovered.length - 1) {
    const item = this.recovered[index];
    if (!item) return false;
    if (!navigator.clipboard?.writeText) {
      this._notice("Couldn't reach the clipboard — the text is below; copy it manually.");
      this._emit();
      return false;
    }
    try {
      await navigator.clipboard.writeText(item.text);
    } catch {
      this._notice("Couldn't reach the clipboard — the text is below; copy it manually.");
      this._emit();
      return false;
    }
    this.recovered.splice(index, 1);
    this._notice("Recovered text copied.");
    this._emit();
    return true;
  }

  /** @param {number} [index] */
  dismissRecovered(index = this.recovered.length - 1) {
    this.recovered.splice(index, 1);
    this._emit();
  }

  /** Note that focus left the grid for good (into the CM doc or away). */
  noteExternalFocus(target) {
    if (target instanceof Node && this.dom?.contains(target)) return;
    if (
      target instanceof HTMLElement &&
      target.closest("[data-slot='markdown-toolbar'], .md-table-dialog, [data-slot='dropdown-menu'], [data-slot='dialog-overlay'], [data-slot='tooltip-popup']")
    ) {
      // Toolbar/dock/dialog interaction — the table keeps its selection so
      // formatting keeps targeting the cell that was being edited.
      return;
    }
    if (target instanceof HTMLElement && target.closest(".cm-content")) {
      this._markInactive();
      this._emit();
      return;
    }
    // Anywhere else (body, panels) — stay active; the table remains the
    // formatting target until the user works elsewhere in the document.
  }

  dispose() {
    this.disposed = true;
    // A draft that outlives its widget is never written post-disposal —
    // park its text in the view's recovery store for the next grid.
    if (this.draft) this._recoverDraftText(this.draft.text);
    this.draft = null;
    this.editing = null;
    if (this._msgTimer) clearTimeout(this._msgTimer);
    this.listeners.clear();
    controllersByView.get(this.view)?.delete(this);
    this._markInactive();
  }
}

export class TableWidget extends WidgetType {
  /** @type {string} */ text;
  /** @type {number} */ from;
  /** @type {number} */ to;
  /** @type {boolean} */ canEdit;
  /**
   * @param {string} text @param {number} from @param {number} to
   * @param {boolean} [canEdit]
   */
  constructor(text, from, to, canEdit = true) {
    super();
    // `editable` is WidgetType's own getter — keep ours named canEdit.
    Object.assign(this, { text, from, to, canEdit });
  }
  eq(other) {
    // eq true means "reuse the DOM as-is" — updateDOM is skipped. So this
    // must cover identity, not just type: if the doc changed (the table
    // moved, its text changed, or write permission flipped), eq must fail
    // so updateDOM refreshes the controller's stored range. A stale range
    // once made Add row/column rewrite the wrong slice of the document.
    return (
      other instanceof TableWidget &&
      other.text === this.text &&
      other.from === this.from &&
      other.to === this.to &&
      other.canEdit === this.canEdit
    );
  }
  /** @param {EditorView} view */
  toDOM(view) {
    const wrap = /** @type {HTMLElement & {_tableController?: TableController}} */ (
      document.createElement("div")
    );
    wrap.className = "md-table cm-lp-tablewrap";
    const ctrl = new TableController(view, {
      text: this.text,
      from: this.from,
      to: this.to,
      editable: this.canEdit,
    });
    ctrl.undoManager = undoManagerByView.get(view) ?? null;
    ctrl.dom = wrap;
    wrap._tableController = ctrl;
    let set = controllersByView.get(view);
    if (!set) {
      set = new Set();
      controllersByView.set(view, set);
    }
    set.add(ctrl);
    const root = createRoot(wrap);
    ctrl._root = root;
    queueMicrotask(() => {
      if (!ctrl.disposed) {
        ctrl.takeRecoveredDrafts();
        root.render(createElement(MarkdownTableEditor, { controller: ctrl }));
      }
    });
    const pending = pendingFocus.get(view);
    if (pending && pending.from === this.from) {
      pendingFocus.delete(view);
      ctrl.select({ r: pending.r, c: pending.c });
    }
    return wrap;
  }
  /** @param {HTMLElement} dom @param {EditorView} view */
  updateDOM(dom, view) {
    const wrap = /** @type {typeof dom & {_tableController?: TableController}} */ (dom);
    const ctrl = wrap._tableController;
    if (!ctrl || ctrl.disposed) return false;
    ctrl.undoManager = undoManagerByView.get(view) ?? ctrl.undoManager;
    ctrl.updateBlock(this.text, this.from, this.to, this.canEdit);
    const pending = pendingFocus.get(view);
    if (pending && pending.from === this.from) {
      pendingFocus.delete(view);
      ctrl.select({ r: pending.r, c: pending.c });
    }
    return true;
  }
  /** @param {HTMLElement} dom */
  destroy(dom) {
    const wrap = /** @type {typeof dom & {_tableController?: TableController}} */ (dom);
    const ctrl = wrap._tableController;
    // No writes during/after teardown — dispose() parks any live draft in
    // the view's recovery store so the next grid can hand it back.
    ctrl?.dispose();
    const root = ctrl?._root;
    // React refuses a synchronous unmount during a CM view update — defer.
    if (root) queueMicrotask(() => root.unmount());
  }
  ignoreEvent() {
    return true;
  }
}
