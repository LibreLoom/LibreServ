/**
 * CodeMirror side of the Markdown table editor, modeled on Nextcloud Text's
 * table node view: a top-level `Table` syntax node is replaced by a plain
 * HTML table whose cells are typed into directly. React
 * (MarkdownTableEditor.jsx) renders the table, the per-column and per-row
 * menus and the add-row / add-column strips; `TableController` below owns
 * every document write.
 *
 * Cell typing replaces only the changed characters inside that cell's
 * source span, so collab merges stay character-level and the file remains
 * honest pipe-table text. Structural edits (rows, columns, alignment, sort)
 * re-serialize the table and dispatch a prefix/suffix-reduced replacement.
 * Raw pipes stay reachable through the editor's Source mode.
 */

import { EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import MarkdownTableEditor from "./MarkdownTableEditor.jsx";
import { applyMarkdownAction } from "../../lib/markdown.js";
import {
  deleteTableCol,
  deleteTableRow,
  encodeTableCell,
  insertTableCol,
  insertTableRow,
  parseMarkdownTable,
  parseTableDocument,
  serializeMarkdownTable,
  setTableAlign,
  sortTableRows,
  splitTableLine,
  tableCellValue,
} from "./markdownTableModel.js";

export { parseMarkdownTable, serializeMarkdownTable, splitTableLine, encodeTableCell };

/** Inline marks a cell can hold — block actions have no meaning inside one. */
const CELL_ACTIONS = new Set(["bold", "italic", "strikethrough", "code", "link"]);

/** @type {WeakMap<EditorView, Set<TableController>>} */
const controllersByView = new WeakMap();
/** @type {WeakMap<EditorView, { undo: () => void, redo: () => void, stopCapturing?: () => void }>} */
const undoManagerByView = new WeakMap();
/**
 * Focus hand-off across widget mounts: insertMarkdownTable stashes the cell
 * to focus once the new table's React root renders.
 * @type {WeakMap<EditorView, { from: number, r: number, c: number }>}
 */
const pendingFocus = new WeakMap();

/**
 * Wire the Yjs undo manager the editor created into the table widgets, so
 * Ctrl+Z inside a cell undoes document history (cell typing included).
 * @param {EditorView} view @param {object} undoManager
 */
export function registerTableUndoManager(view, undoManager) {
  undoManagerByView.set(view, undoManager);
  for (const ctrl of controllersByView.get(view) ?? []) ctrl.undoManager = undoManager;
}

/**
 * Live controllers for a view — used by the entry hook (focus a cell when
 * the document cursor lands inside a table range) and by tests.
 * @param {EditorView} view @returns {TableController[]}
 */
export function tableControllers(view) {
  return [...(controllersByView.get(view) ?? [])];
}

/**
 * Route a toolbar action at the table cell being typed in. Inline marks
 * wrap the cell's selected text; anything else (headings, lists, a nested
 * table) is swallowed, as in Nextcloud — a cell holds one line of inline
 * Markdown. A document selection touching a table's source (the caret
 * parked at a table edge, a menu that took focus from the cell) is also
 * refused — a heading there would rewrite a table row. Returns false when
 * the action belongs to the document.
 * @param {EditorView} view @param {string} action
 */
export function runActiveTableAction(view, action) {
  const ta = document.activeElement;
  if (ta instanceof HTMLTextAreaElement && view.dom.contains(ta)) {
    const wrap = /** @type {(HTMLElement & { _tableController?: TableController }) | null} */ (
      ta.closest(".md-table")
    );
    const ctrl = wrap?._tableController;
    if (ctrl && !ctrl.disposed && ctrl.editing) {
      if (CELL_ACTIONS.has(action)) ctrl.formatEditingCell(action, ta);
      return true;
    }
  }
  const { from, to } = view.state.selection.main;
  return tableControllers(view).some(
    (ctrl) => !ctrl.disposed && to >= ctrl.from && from <= ctrl.to,
  );
}

/**
 * Insert a new table as its own block at the selection and focus its first
 * header cell — Nextcloud's `insertTable`: three columns, a header row and
 * two body rows.
 * @param {EditorView} view
 * @param {{ columns?: number, rows?: number }} [opts]
 */
export function insertMarkdownTable(view, { columns = 3, rows = 2 } = {}) {
  if (!view.state.facet(EditorView.editable)) return false;
  const cols = Math.max(1, columns | 0);
  const text = serializeMarkdownTable({
    header: Array.from({ length: cols }, () => ""),
    align: Array.from({ length: cols }, () => ""),
    body: Array.from({ length: Math.max(0, rows | 0) }, () =>
      Array.from({ length: cols }, () => ""),
    ),
  });
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const line = doc.lineAt(from);
  let insert;
  let pos;
  let tableFrom;
  if (line.text.trim() === "" && from >= line.from && to <= line.to) {
    // Replace the blank line; keep a blank line after the block.
    const after = line.to < doc.length ? doc.sliceString(line.to + 1, line.to + 2) : "";
    insert = text + (line.to === doc.length ? "" : after.trim() === "" ? "\n" : "\n\n");
    pos = line.from;
    tableFrom = pos;
  } else {
    // After a text line: one blank line before, and one after unless the
    // next line is already blank.
    const nextBlank =
      line.number < doc.lines && doc.line(line.number + 1).text.trim() === "";
    insert = `\n\n${text}${line.to === doc.length || nextBlank ? "" : "\n"}`;
    pos = line.to;
    tableFrom = pos + 2;
  }
  // Set before dispatching: a small document parses synchronously, so the
  // widget can mount inside the dispatch itself.
  pendingFocus.set(view, { from: tableFrom, r: 0, c: 0 });
  view.dispatch({
    changes: { from: pos, to: line.to, insert },
    selection: { anchor: tableFrom + text.length },
    userEvent: "input.table",
  });
  return true;
}

/**
 * True while [from, to) still covers a top-level Table node. Guards every
 * write: if the stored range drifted, we refuse to touch the document
 * instead of spraying table text into an unrelated range.
 * @param {EditorView} view @param {number} from @param {number} to
 */
function tableRangeIntact(view, from, to) {
  let node = syntaxTree(view.state).resolveInner(from, 1);
  while (node && node.name !== "Table") node = node.parent;
  return !!node && node.from === from && node.to === to;
}

/**
 * One controller per mounted table widget: the latest block range and
 * source, the parsed model + cell spans, and the cell being typed in.
 * Everything React renders is a snapshot of this object.
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
    /**
     * The cell being typed in. `text` is what the textarea shows — it can
     * differ from the stored value by trailing spaces or a pipe's escape,
     * so it is kept here instead of re-derived from the model every render.
     * @type {{ r: number, c: number, text: string } | null}
     */
    this.editing = null;
    /** @type {{ start: number, end: number } | null} caret to restore after a format */
    this.caret = null;
    this.disposed = false;
    this._wantFocus = null;
    this._snapshot = null;
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
      rows: this.rows,
      cols: this.cols,
      editable: this.editable,
      editing: this.editing ? { ...this.editing } : null,
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
  }

  /**
   * The widget moved or its text changed (local or remote edit). Re-parse
   * and refresh the live range. The open cell keeps its textarea text
   * unless the stored value really changed underneath it (a peer's edit,
   * an undo) — then the textarea follows the document.
   */
  updateBlock(text, from, to, editable) {
    if (this.disposed) return;
    this.from = from;
    this.to = to;
    this.editable = editable;
    if (text !== this.source) this._setSource(text);
    const e = this.editing;
    if (e) {
      if (!editable || e.r > this.rows || e.c >= this.cols) {
        this.editing = null;
      } else {
        const stored = tableCellValue(this.model, e.r, e.c);
        if (encodeTableCell(e.text).trim() !== stored) e.text = stored;
      }
    }
    this._emit();
  }

  _canWrite() {
    return (
      !this.disposed &&
      this.editable &&
      this.view.state.facet(EditorView.editable) &&
      tableRangeIntact(this.view, this.from, this.to)
    );
  }

  // ── cell typing ────────────────────────────────────────────

  /**
   * Put the caret in a cell (click, Tab, arrows). Read-only tables never
   * open a cell.
   */
  edit(r, c) {
    if (!this.editable) return;
    if (this.editing?.r === r && this.editing?.c === c) return;
    this.editing = { r, c, text: tableCellValue(this.model, r, c) };
    this.caret = null;
    this._parkDocCaret(r, c);
    this._emit();
  }

  /**
   * Keep the document caret on the open cell's source: toolbar actions
   * that arrive after a menu took focus then still see "inside a table"
   * instead of the caret's last spot in the prose, and collaborators see
   * where you are typing.
   */
  _parkDocCaret(r, c) {
    const cell = this.parsed?.cells[r]?.[c];
    if (!cell) return;
    const pos = this.from + cell.from;
    const park = () => {
      if (this.disposed || this.view.state.selection.main.head === pos) return;
      if (pos > this.view.state.doc.length) return;
      this.view.dispatch({ selection: { anchor: pos } });
    };
    try {
      park();
    } catch {
      // Opened from inside a view update (a widget claiming focus while it
      // mounts) — park once the update settles.
      queueMicrotask(() => {
        try {
          park();
        } catch {
          /* the table moved on; nothing to park */
        }
      });
    }
  }

  /** The textarea lost focus to something outside the table's cells. */
  stopEditing() {
    if (!this.editing) return;
    this.editing = null;
    this._emit();
  }

  /**
   * Write the open cell's new text straight into the document — every
   * keystroke, like typing anywhere else in the file. Only the changed
   * characters inside the cell span are replaced.
   * @param {string} text
   */
  setCellText(text) {
    const e = this.editing;
    if (!e) return;
    // Cells are single-line: pasted line breaks become spaces.
    e.text = text.replace(/\r\n|\r|\n/g, " ");
    if (this._canWrite()) {
      const change = this._cellChange(e.r, e.c, e.text);
      if (change) this.view.dispatch({ changes: change, userEvent: "input.tableCell" });
    }
    this._emit();
  }

  /**
   * The minimal change writing `value` into cell (r, c). A normal cell
   * keeps its padding and replaces only the differing middle. A `missing`
   * cell (ragged row) appends pipe-separated blanks to its own line so the
   * row reaches full width — no other row is touched.
   * @returns {{ from: number, to: number, insert: string } | null}
   */
  _cellChange(r, c, value) {
    const cell = this.parsed?.cells[r]?.[c];
    if (!cell) return null;
    const enc = encodeTableCell(value).trim();
    if (!cell.missing) {
      const lead = /^\s*/.exec(cell.raw)[0];
      const trail = /\s*$/.exec(cell.raw)[0];
      const next = enc === "" ? (lead || trail ? " " : "") : lead + enc + trail;
      const cur = cell.raw;
      if (next === cur) return null;
      let pre = 0;
      const bound = Math.min(cur.length, next.length);
      while (pre < bound && cur[pre] === next[pre]) pre += 1;
      let suf = 0;
      while (
        suf < bound - pre &&
        cur[cur.length - 1 - suf] === next[next.length - 1 - suf]
      ) {
        suf += 1;
      }
      return {
        from: this.from + cell.from + pre,
        to: this.from + cell.to - suf,
        insert: next.slice(pre, next.length - suf),
      };
    }
    if (enc === "") return null;
    const realCount = this.parsed.cells[r].filter((x) => !x.missing).length;
    let at = cell.from;
    while (at > 0 && /[ \t\r]/.test(this.source[at - 1])) at -= 1;
    let insert = at > 0 && this.source[at - 1] === "|" ? "" : " |";
    for (let j = realCount; j < this.cols; j += 1) {
      insert += j === c ? ` ${enc} |` : "  |";
    }
    return { from: this.from + at, to: this.from + at, insert };
  }

  /**
   * Toolbar / Ctrl+B on the open cell: wrap the textarea's selection.
   * @param {string} action @param {HTMLTextAreaElement} ta
   */
  formatEditingCell(action, ta) {
    if (!this.editing) return;
    const res = applyMarkdownAction(ta.value, ta.selectionStart, ta.selectionEnd, action);
    this.caret = { start: res.start, end: res.end };
    this.setCellText(res.text);
  }

  /**
   * Keyboard motion out of the open cell, as in Nextcloud: Tab walks cells
   * and leaves the table after the last one; Enter/arrows step rows and
   * leave the table past either edge.
   * @param {"next"|"prev"|"up"|"down"} dir
   */
  move(dir) {
    const e = this.editing;
    if (!e) return;
    let { r, c } = e;
    if (dir === "next") {
      if (c < this.cols - 1) c += 1;
      else if (r < this.rows) [r, c] = [r + 1, 0];
      else return this.exit("after");
    } else if (dir === "prev") {
      if (c > 0) c -= 1;
      else if (r > 0) [r, c] = [r - 1, this.cols - 1];
      else return undefined;
    } else if (dir === "down") {
      if (r < this.rows) r += 1;
      else return this.exit("after");
    } else if (dir === "up") {
      if (r > 0) r -= 1;
      else return this.exit("before");
    }
    this.focusCell(r, c);
    return undefined;
  }

  /** Ask the table to focus a cell on its next render. */
  focusCell(r, c) {
    this._wantFocus = { r, c };
    this.edit(r, c);
    this._emit();
  }

  /** Cell to focus after the next render (consumed by the component). */
  takeFocusRequest() {
    const want = this._wantFocus;
    this._wantFocus = null;
    return want;
  }

  /** Caret a format action left in the open cell (consumed on render). */
  takeCaret() {
    const caret = this.caret;
    this.caret = null;
    return caret;
  }

  /**
   * Focus the cell closest to a document position — the entry hook for
   * cursor/keyboard paths that land inside the (replaced) table range.
   * @param {number} pos absolute doc position
   */
  focusDocPosition(pos) {
    const cells = this.parsed?.cells;
    if (!cells || !this.editable) return;
    const rel = pos - this.from;
    let best = { r: 0, c: 0 };
    let bestDist = Infinity;
    for (let r = 0; r < cells.length; r += 1) {
      for (let c = 0; c < cells[r].length; c += 1) {
        const span = cells[r][c];
        const dist =
          rel >= span.from && rel <= span.to
            ? -1
            : Math.abs(rel - (span.from + span.to) / 2);
        if (dist < bestDist) {
          bestDist = dist;
          best = { r, c };
        }
      }
    }
    this.focusCell(best.r, best.c);
  }

  undo() {
    this.undoManager?.undo?.();
  }

  redo() {
    this.undoManager?.redo?.();
  }

  // ── structure (the table / column / row menus) ────────────

  /**
   * Apply a model operation: recompute from the latest block text, then
   * dispatch the smallest replacement as its own undo step.
   * @param {(model: object) => object | null} mutate
   * @param {{ r: number, c: number }} [focus] cell to put the caret in after
   */
  apply(mutate, focus) {
    if (!this._canWrite()) return false;
    const cur = this.view.state.doc.sliceString(this.from, this.to);
    if (cur !== this.source) this._setSource(cur);
    const next = mutate(this.model);
    if (!next) return false;
    const insert = serializeMarkdownTable(next);
    if (insert !== cur) {
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
      this.undoManager?.stopCapturing?.();
      this.view.dispatch({
        changes: {
          from: this.from + pre,
          to: this.to - suf,
          insert: insert.slice(pre, insert.length - suf),
        },
        userEvent: "input.table",
      });
      this.undoManager?.stopCapturing?.();
    }
    if (focus) this.focusCell(focus.r, focus.c);
    return true;
  }

  /** @param {number} r row to insert before (r-space) */
  addRowBefore(r) {
    const at = Math.max(1, r);
    return this.apply((m) => insertTableRow(m, at), { r: at, c: 0 });
  }

  /** @param {number} r row to insert after (r-space; 0 = under the header) */
  addRowAfter(r) {
    return this.apply((m) => insertTableRow(m, r + 1), { r: r + 1, c: 0 });
  }

  /** @param {number} r */
  deleteRow(r) {
    return this.apply((m) => deleteTableRow(m, r));
  }

  /** @param {number} c */
  addColumnBefore(c) {
    return this.apply((m) => insertTableCol(m, c), { r: 0, c });
  }

  /** @param {number} c */
  addColumnAfter(c) {
    return this.apply((m) => insertTableCol(m, c + 1), { r: 0, c: c + 1 });
  }

  /** @param {number} c */
  deleteColumn(c) {
    return this.apply((m) => deleteTableCol(m, c));
  }

  /** @param {number} c @param {""|"left"|"center"|"right"} align */
  setAlign(c, align) {
    return this.apply((m) => setTableAlign(m, c, align));
  }

  /** @param {number} c @param {1|-1} dir */
  sortColumn(c, dir) {
    return this.apply((m) => sortTableRows(m, c, dir));
  }

  /**
   * Remove the whole table block, and the blank line after it when there is
   * one above too — the paragraphs around it end up one blank line apart.
   */
  deleteTable() {
    if (!this._canWrite()) return false;
    const doc = this.view.state.doc;
    const at = (i) => (i >= 0 && i < doc.length ? doc.sliceString(i, i + 1) : "");
    let end = this.to;
    if (at(end) === "\n") end += 1;
    if (at(this.from - 1) === "\n" && at(end) === "\n") end += 1;
    this.undoManager?.stopCapturing?.();
    this.view.dispatch({
      changes: { from: this.from, to: end, insert: "" },
      selection: { anchor: this.from },
      userEvent: "input.tableDelete",
    });
    this.undoManager?.stopCapturing?.();
    this.view.focus();
    return true;
  }

  /**
   * Leave the table and park the document cursor outside its text. A table
   * at the very start or end of the file gets a blank line on that side so
   * there is somewhere to type that isn't table source.
   * @param {"before" | "after"} direction
   */
  exit(direction) {
    this.editing = null;
    const doc = this.view.state.doc;
    const writable = this._canWrite();
    let pos;
    /** @type {object | undefined} */
    let changes;
    if (direction === "before") {
      if (this.from === 0 && writable) changes = { from: 0, insert: "\n\n" };
      pos = Math.max(0, this.from - 1);
    } else {
      const tail = doc.sliceString(this.to, this.to + 1) === "\n" ? 1 : 0;
      pos = Math.min(this.to + tail, doc.length);
      if (pos >= doc.length && writable) {
        changes = { from: doc.length, insert: "\n\n" };
        pos = doc.length + 2;
      }
    }
    this.view.dispatch({
      changes,
      selection: { anchor: pos },
      userEvent: changes ? "input.tableExit" : "select",
    });
    this.view.focus();
    this._emit();
  }

  dispose() {
    this.disposed = true;
    this.editing = null;
    this.listeners.clear();
    controllersByView.get(this.view)?.delete(this);
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
    // must cover identity, not just type: if the table moved, its text
    // changed, or write permission flipped, updateDOM has to refresh the
    // controller's stored range or later writes land in the wrong place.
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
    wrap.className = "md-table";
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
      if (!ctrl.disposed) root.render(createElement(MarkdownTableEditor, { controller: ctrl }));
    });
    this._claimPendingFocus(view, ctrl);
    return wrap;
  }
  /** @param {HTMLElement} dom @param {EditorView} view */
  updateDOM(dom, view) {
    const ctrl = /** @type {typeof dom & {_tableController?: TableController}} */ (dom)
      ._tableController;
    if (!ctrl || ctrl.disposed) return false;
    ctrl.undoManager = undoManagerByView.get(view) ?? ctrl.undoManager;
    ctrl.updateBlock(this.text, this.from, this.to, this.canEdit);
    this._claimPendingFocus(view, ctrl);
    return true;
  }
  /** @param {EditorView} view @param {TableController} ctrl */
  _claimPendingFocus(view, ctrl) {
    const pending = pendingFocus.get(view);
    if (pending && pending.from === this.from) {
      pendingFocus.delete(view);
      ctrl.focusCell(pending.r, pending.c);
    }
  }
  /** @param {HTMLElement} dom */
  destroy(dom) {
    const ctrl = /** @type {typeof dom & {_tableController?: TableController}} */ (dom)
      ._tableController;
    ctrl?.dispose();
    const root = ctrl?._root;
    // React refuses a synchronous unmount during a CM view update — defer.
    if (root) queueMicrotask(() => root.unmount());
  }
  ignoreEvent() {
    return true;
  }
}
