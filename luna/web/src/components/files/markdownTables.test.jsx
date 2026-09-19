import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { markdownLivePreview } from "./markdownLivePreview.js";
import {
  parseMarkdownTable,
  serializeMarkdownTable,
  splitTableLine,
  tableControllers,
} from "./markdownTables.js";

const TABLE_DOC = "intro\n\n| A | B |\n| --- | ---: |\n| 1 | 2 |\n\nafter";

describe("markdownTables helpers", () => {
  it("splits rows on unescaped pipes, keeping raw inline source", () => {
    expect(splitTableLine("| a | b |")).toEqual(["a", "b"]);
    expect(splitTableLine("a | b")).toEqual(["a", "b"]);
    expect(splitTableLine("| a \\| x | b |")).toEqual(["a \\| x", "b"]);
    expect(splitTableLine("|  |")).toEqual([""]);
  });

  it("parses header, alignment and body; pads ragged rows", () => {
    const m = parseMarkdownTable(
      "| A | B |\n| :--- | ---: |\n| 1 | 2 |\n| 3 |\n",
    );
    expect(m.header).toEqual(["A", "B"]);
    expect(m.align).toEqual(["left", "right"]);
    expect(m.body).toEqual([
      ["1", "2"],
      ["3", ""],
    ]);
  });

  it("serializes back to a normalized pipe table, escaping pipes", () => {
    const text = serializeMarkdownTable({
      header: ["A", "B"],
      align: ["center", ""],
      body: [["x | y", "2"]],
    });
    expect(text).toBe(
      "| A | B |\n| :---: | --- |\n| x \\| y | 2 |",
    );
  });
});

function mount(doc, cursor = 0, editable = true) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        EditorView.editable.of(editable),
        markdown({ extensions: [GFM] }),
        markdownLivePreview(),
      ],
    }),
  });
}

/** Wait for the parse + the queued React mount of the grid. */
async function settled(view) {
  await vi.waitFor(() => {
    view.requestMeasure();
    if (!view.dom.querySelector(".md-table-grid")) {
      throw new Error("table grid not rendered yet");
    }
  });
}

/** The live controller for the mounted grid. */
function controller(view) {
  const ctrls = tableControllers(view);
  if (!ctrls.length) throw new Error("no table controller mounted");
  return ctrls[0];
}

/** Dispatch a key on a grid cell (grid keys live on the scroll container). */
function keyOnCell(view, r, c, key, init = {}) {
  const cell = view.dom.querySelector(`[data-cell="${r},${c}"]`);
  if (!cell) throw new Error(`no cell ${r},${c}`);
  cell.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
  );
}

describe("table grid in live preview", () => {
  it("renders an interactive grid (not inputs) for a top-level table", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const cells = [...view.dom.querySelectorAll("[data-cell]")];
    expect(cells).toHaveLength(4);
    expect(cells[0].textContent).toBe("A");
    expect(cells[3].textContent).toBe("2");
    // Status line reports body rows and the selected coordinate.
    expect(view.dom.querySelector(".md-table-status")?.textContent).toContain(
      "2 columns · 1 row",
    );
    view.destroy();
  });

  it("keeps the grid visible when the document cursor enters the table", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const inside = TABLE_DOC.indexOf("| 1 |") + 2;
    view.dispatch({ selection: { anchor: inside } });
    await new Promise((r) => setTimeout(r, 30));
    // Still a grid — entering the range no longer flips to raw source.
    expect(view.dom.querySelector(".md-table-grid")).toBeTruthy();
    expect(view.dom.querySelector(".cm-lp-tablesrc")).toBeNull();
    view.destroy();
  });

  it("a document cursor landing inside focuses the matching grid cell", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const inside = TABLE_DOC.indexOf("| 1 |") + 2; // inside body cell 1
    view.dispatch({ selection: { anchor: inside } });
    await vi.waitFor(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active.dataset.cell !== "1,0") {
        throw new Error("cell not focused");
      }
    });
    view.destroy();
  });

  it("commits a cell edit into exactly its source span", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.startEdit(1, 0);
    ctrl.setDraft("one");
    ctrl.commitDraft();
    const doc = view.state.doc.toString();
    expect(doc).toBe("intro\n\n| A | B |\n| --- | ---: |\n| one | 2 |\n\nafter");
    view.destroy();
  });

  it("typing a printable key starts a replacement draft", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 1, c: 1 });
    keyOnCell(view, 1, 1, "x");
    await vi.waitFor(() => {
      const ta = /** @type {HTMLTextAreaElement | null} */ (
        view.dom.querySelector("textarea.md-table-editor")
      );
      if (!ta || ta.value !== "x") throw new Error("no replacement draft");
    });
    view.destroy();
  });

  it("Enter opens the editor; Enter commits and selects the cell below", async () => {
    const doc = "| A |\n| --- |\n| 1 |\n| 2 |\n\nend";
    const view = mount(doc, doc.length);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 });
    keyOnCell(view, 0, 0, "Enter");
    await vi.waitFor(() => {
      if (!ctrl.editing) throw new Error(`no editing state; head=${JSON.stringify(ctrl.selection.head)} editable=${ctrl.editable}`);
      if (!view.dom.querySelector("textarea.md-table-editor")) {
        throw new Error("editor not open");
      }
    });
    const ta = /** @type {HTMLTextAreaElement} */ (
      view.dom.querySelector("textarea.md-table-editor")
    );
    // Bypass React's value tracker so the input event reports the new text.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
      ?.set?.call(ta, "A2");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(view.state.doc.toString()).toContain("| A2 |");
    expect(ctrl.selection.head).toEqual({ r: 1, c: 0 });
    view.destroy();
  });

  it("Escape cancels the draft without touching the document", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.startEdit(1, 0);
    ctrl.setDraft("discarded");
    const ta = await vi.waitFor(() => {
      const el = view.dom.querySelector("textarea.md-table-editor");
      if (!el) throw new Error("no editor");
      return /** @type {HTMLTextAreaElement} */ (el);
    });
    ta.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(view.state.doc.toString()).toBe(TABLE_DOC);
    expect(ctrl.draft).toBeNull();
    view.destroy();
  });

  it("Escape on the selected grid leaves the table after it", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 });
    keyOnCell(view, 0, 0, "Escape");
    // Cursor parks on the blank line right after the table.
    expect(view.state.selection.main.head).toBe(TABLE_DOC.indexOf("after") - 1);
    view.destroy();
  });

  it("exiting before a table at the document start inserts a landing paragraph", async () => {
    const doc = "| A |\n| --- |\n| 1 |";
    const view = mount(doc, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 });
    ctrl.exit("before");
    const text = view.state.doc.toString();
    // A blank paragraph now precedes the table; the cursor sits in it, so
    // typing lands OUTSIDE the table source.
    expect(text.startsWith("\n\n| A |")).toBe(true);
    expect(view.state.selection.main.head).toBe(0);
    view.dispatch({ changes: { from: 0, to: 0, insert: "text " } });
    expect(view.state.doc.toString()).toBe("text \n\n| A |\n| --- |\n| 1 |");
    view.destroy();
  });

  it("exiting after a table at EOF appends a paragraph to land in", async () => {
    const doc = "start\n\n| A |\n| --- |\n| 1 |";
    const view = mount(doc, doc.length);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 });
    ctrl.exit("after");
    const text = view.state.doc.toString();
    expect(text.endsWith("| 1 |\n\n")).toBe(true);
    expect(view.state.selection.main.head).toBe(text.length);
    view.destroy();
  });

  it("read-only exit never mutates the document", async () => {
    const doc = "| A |\n| --- |\n| 1 |";
    const view = mount(doc, 0, false);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 });
    ctrl.exit("before");
    ctrl.exit("after");
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it("an open draft on another cell blocks the switch until it resolves", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.startEdit(1, 0);
    ctrl.setDraft("mine");
    // A remote same-cell change while the draft is open => conflict, and a
    // click on another cell must not drop or overwrite the draft.
    const from = TABLE_DOC.indexOf("| 1 |") + 2;
    view.dispatch({ changes: { from, to: from + 1, insert: "remote" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(ctrl.conflict?.kind).toBe("cell");
    expect(ctrl.startEdit(1, 1)).toBe(false);
    expect(ctrl.draft?.text).toBe("mine");
    expect(ctrl.editing).toEqual({ r: 1, c: 0 });
    view.destroy();
  });

  it("undo inside a draft reverts the draft first, not the last table edit", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.appendRow();
    expect(view.state.doc.toString()).toContain("|  |  |");
    ctrl.startEdit(1, 0);
    ctrl.setDraft("changed");
    ctrl.undo();
    // The draft reverts to the cell's base — the appended row survives.
    expect(ctrl.draft?.text).toBe("1");
    expect(view.state.doc.toString()).toContain("|  |  |");
    ctrl.undo();
    expect(ctrl.draft).toBeNull();
    expect(ctrl.editing).toBeNull();
    view.destroy();
  });

  it("editing a padded ragged-row cell materializes only its own row", async () => {
    const doc =
      "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 |\n| 5 | 6 | 7 |";
    const view = mount(doc, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.startEdit(2, 2);
    ctrl.setDraft("added");
    ctrl.commitDraft();
    const text = view.state.doc.toString();
    expect(text).toContain("| 4 |  | added |");
    expect(text).toContain("| 1 | 2 | 3 |");
    expect(text).toContain("| 5 | 6 | 7 |");
    view.destroy();
  });

  it("a dialog's captured source refuses a replace after a remote change", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.setDialog("source");
    expect(ctrl.dialogSource).toBe("| A | B |\n| --- | ---: |\n| 1 | 2 |");
    // Peer edits a cell while the dialog is open.
    const from = TABLE_DOC.indexOf("| 1 |") + 2;
    view.dispatch({ changes: { from, to: from + 1, insert: "9" } });
    await new Promise((r) => setTimeout(r, 30));
    const ok = ctrl.replaceSource("| X |\n| --- |", ctrl.dialogSource);
    expect(ok).toBe(false);
    expect(view.state.doc.toString()).toContain("| 9 |");
    view.destroy();
  });

  it("moving a column carries its width along", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.setWidth(1, 320);
    ctrl.select({ r: 0, c: 1 });
    ctrl.moveColCommand(-1);
    expect(ctrl.widths[0]).toBe(320);
    expect(ctrl.widths[1]).toBeUndefined();
    view.destroy();
  });

  it("deleting the whole selected column range refuses with a notice", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.selectAll();
    ctrl.deleteColCommand();
    expect(view.state.doc.toString()).toBe(TABLE_DOC);
    expect(ctrl.getSnapshot().message).toContain("at least one column");
    view.destroy();
  });

  it("sort needs a single selected column", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.selectAll();
    ctrl.sortCommand(1);
    expect(view.state.doc.toString()).toBe(TABLE_DOC);
    expect(ctrl.getSnapshot().message).toContain("one column");
    view.destroy();
  });

  it("only the active table shows its selection; switching emits the previous one", async () => {
    const doc = `${TABLE_DOC}\n\n| X |\n| --- |\n| 9 |\n`;
    const view = mount(doc, 0);
    await settled(view);
    const ctrls = tableControllers(view);
    expect(ctrls.length).toBe(2);
    const [first, second] = ctrls;
    expect(first.getSnapshot().active).toBe(false);
    expect(second.getSnapshot().active).toBe(false);
    first.select({ r: 0, c: 0 });
    expect(first.getSnapshot().active).toBe(true);
    second.select({ r: 0, c: 0 });
    expect(second.getSnapshot().active).toBe(true);
    // The first table was emitted inactive — not left stale.
    expect(first.getSnapshot().active).toBe(false);
    view.destroy();
  });

  it("multi-line single-column paste lands one line per row", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 1, c: 0 });
    ctrl.pasteText("x\ny\nz");
    const doc = view.state.doc.toString();
    expect(doc).toContain("| x | 2 |");
    expect(doc).toContain("| y |");
    expect(doc).toContain("| z |");
    view.destroy();
  });

  it("a composing (IME) Enter does not commit the draft", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.startEdit(1, 0);
    ctrl.setDraft("half-composed");
    const ta = await vi.waitFor(() => {
      const el = view.dom.querySelector("textarea.md-table-editor");
      if (!el) throw new Error("no editor");
      return /** @type {HTMLTextAreaElement} */ (el);
    });
    ta.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Process", bubbles: true }),
    );
    expect(view.state.doc.toString()).toBe(TABLE_DOC);
    expect(ctrl.draft?.text).toBe("half-composed");
    view.destroy();
  });

  it("Tab on the last cell appends exactly one row and selects its first cell", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 1, c: 1 });
    ctrl.gridTab(1);
    const doc = view.state.doc.toString();
    expect(doc).toContain("| 1 | 2 |\n|  |  |");
    expect(ctrl.selection.head).toEqual({ r: 2, c: 0 });
    view.destroy();
  });

  it("header-only tables still work: last-header Tab appends a body row", async () => {
    const doc = "| A | B |\n| --- | --- |\n\nrest";
    const view = mount(doc, doc.length);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 1 });
    ctrl.gridTab(1);
    expect(view.state.doc.toString()).toContain("| --- | --- |\n|  |  |");
    expect(ctrl.selection.head).toEqual({ r: 1, c: 0 });
    view.destroy();
  });

  it("Shift+arrow extends a rectangular selection", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 });
    keyOnCell(view, 0, 0, "ArrowRight", { shiftKey: true });
    keyOnCell(view, 0, 1, "ArrowDown", { shiftKey: true });
    expect(ctrl.selRect()).toEqual({ top: 0, bottom: 1, left: 0, right: 1 });
    view.destroy();
  });

  it("single-value paste fills the whole selected range", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 }, { r: 1, c: 1 });
    ctrl.pasteText("x");
    const doc = view.state.doc.toString();
    expect(doc).toContain("| x | x |");
    expect(doc).toContain("| x | x |");
    view.destroy();
  });

  it("rectangular TSV paste expands the grid and preserves empties", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 1, c: 0 });
    ctrl.pasteText("p\tq\tr\nx\t\t\ny");
    const doc = view.state.doc.toString();
    // Grew to 3 columns and 3 body rows; the middle empty cell survived.
    expect(doc).toContain("| p | q | r |");
    expect(doc).toContain("| x |  |  |");
    expect(doc).toContain("| y |  |  |");
    view.destroy();
  });

  it("structural ops: insert/move/duplicate/delete rows and columns", async () => {
    const doc = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";
    const view = mount(doc, 0);
    await settled(view);
    const ctrl = controller(view);

    ctrl.select({ r: 1, c: 0 });
    ctrl.insertRowCommand("below");
    expect(view.state.doc.toString()).toContain("| 1 | 2 |\n|  |  |\n| 3 | 4 |");

    ctrl.select({ r: 1, c: 0 });
    ctrl.moveRowCommand(1);
    expect(view.state.doc.toString()).toContain("|  |  |\n| 1 | 2 |");

    ctrl.select({ r: 2, c: 0 });
    ctrl.duplicateRowCommand();
    expect(view.state.doc.toString()).toContain("| 1 | 2 |\n| 1 | 2 |");

    ctrl.select({ r: 0, c: 1 });
    ctrl.insertColCommand("left");
    expect(view.state.doc.toString()).toContain("| A |  | B |");

    ctrl.select({ r: 4, c: 0 });
    ctrl.deleteRowCommand();
    expect(view.state.doc.toString()).not.toContain("| 3 | 4 |");
    view.destroy();
  });

  it("numeric sort keeps whole rows together and the header fixed", async () => {
    const doc =
      "| N | name |\n| --- | --- |\n| 10 | ten |\n| 2 | two |\n| 1 | one |\n";
    const view = mount(doc, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 1, c: 0 });
    ctrl.sortCommand(1);
    const text = view.state.doc.toString();
    const i1 = text.indexOf("| 1 | one |");
    const i2 = text.indexOf("| 2 | two |");
    const i10 = text.indexOf("| 10 | ten |");
    expect(i1).toBeGreaterThan(-1);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i10);
    expect(text.indexOf("| N | name |")).toBeLessThan(i1);
    view.destroy();
  });

  it("alignment repaints the divider row with the same shape", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 });
    ctrl.alignCommand("center");
    const doc = view.state.doc.toString();
    expect(doc).toContain("| :---: | ---: |");
    view.destroy();
  });

  it("the sole remaining column cannot be deleted", async () => {
    const doc = "| A |\n| --- |\n| 1 |\n";
    const view = mount(doc, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 1, c: 0 });
    ctrl.deleteColCommand();
    expect(view.state.doc.toString()).toBe(doc);
    expect(ctrl.getSnapshot().message).toContain("at least one column");
    view.destroy();
  });

  it("deletes the whole table only through the explicit confirm", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.deleteTable();
    const doc = view.state.doc.toString();
    expect(doc).not.toContain("| A | B |");
    expect(doc).toContain("intro");
    expect(doc).toContain("after");
    view.destroy();
  });

  it("tracks the table position after edits above it (no stale-range writes)", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    view.dispatch({ changes: { from: 0, insert: "prefix\n" } });
    await new Promise((r) => setTimeout(r, 30));
    const ctrl = controller(view);
    ctrl.appendRow();
    const doc = view.state.doc.toString();
    expect(doc).toContain("prefix\nintro");
    expect(doc).toContain("| A | B |");
    expect(doc).toContain("|  |  |");
    expect(doc).toContain("after");
    view.destroy();
  });

  it("refuses to write when the stored range no longer covers a table", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    // Simulate a drifted range pointing at plain text.
    const doc = view.state.doc.toString();
    ctrl.from = doc.indexOf("after");
    ctrl.to = ctrl.from + 5;
    ctrl.appendRow();
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it("a remote same-cell change surfaces a conflict instead of overwriting", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.startEdit(1, 0);
    ctrl.setDraft("mine");
    // Simulate a collab peer editing the same cell underneath the draft.
    const from = TABLE_DOC.indexOf("| 1 |") + 2;
    view.dispatch({
      changes: { from, to: from + 1, insert: "remote" },
      userEvent: "input",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(ctrl.conflict?.kind).toBe("cell");
    // Not written over.
    expect(view.state.doc.toString()).toContain("| remote | 2 |");
    ctrl.resolveConflict("mine");
    expect(view.state.doc.toString()).toContain("| mine | 2 |");
    view.destroy();
  });

  it("a remote shape change blocks the draft commit until resolved", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.startEdit(1, 0);
    ctrl.setDraft("mine");
    // Peer appends a body row — the grid shape no longer matches the draft.
    const rowEnd = TABLE_DOC.indexOf("| 1 | 2 |") + "| 1 | 2 |".length;
    view.dispatch({
      changes: { from: rowEnd, insert: "\n| 5 | 6 |" },
      userEvent: "input",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(ctrl.conflict).toBeTruthy();
    ctrl.commitDraft();
    expect(view.state.doc.toString()).not.toContain("mine");
    view.destroy();
  });

  it("a remote edit to a different cell merges without a conflict", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.startEdit(1, 0);
    ctrl.setDraft("mine");
    const from = TABLE_DOC.indexOf("| A |") + 2;
    view.dispatch({
      changes: { from, to: from + 1, insert: "Z" },
      userEvent: "input",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(ctrl.conflict).toBeNull();
    expect(ctrl.commitDraft()).toBe(true);
    const doc = view.state.doc.toString();
    expect(doc).toContain("| Z | B |");
    expect(doc).toContain("| mine | 2 |");
    view.destroy();
  });

  it("source replacement is refused when the expected source is stale", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    const ok = ctrl.replaceSource(
      "| X |\n| --- |\n| 9 |",
      "| A | B |\n| --- | ---: |\n| 1 | 2 |stale-marker",
    );
    expect(ok).toBe(false);
    expect(view.state.doc.toString()).toBe(TABLE_DOC);
    // And a matching expectation applies.
    expect(
      ctrl.replaceSource(
        "| X |\n| --- |\n| 9 |",
        "| A | B |\n| --- | ---: |\n| 1 | 2 |",
      ),
    ).toBe(true);
    expect(view.state.doc.toString()).toContain("| X |");
    view.destroy();
  });

  it("invalid source cannot replace the table", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    expect(ctrl.replaceSource("not a table at all", null)).toBe(false);
    expect(view.state.doc.toString()).toBe(TABLE_DOC);
    view.destroy();
  });

  it("read-only permission disables the live widget's editing", async () => {
    const view = mount(TABLE_DOC, 0, false);
    await settled(view);
    const ctrl = controller(view);
    expect(ctrl.editable).toBe(false);
    // Selecting still works, editing doesn't.
    ctrl.select({ r: 1, c: 0 });
    ctrl.startEdit(1, 0);
    expect(ctrl.editing).toBeNull();
    expect(ctrl.appendRow()).toBe(false);
    expect(view.state.doc.toString()).toBe(TABLE_DOC);
    view.destroy();
  });

  it("exit('before') a mid-document table lands outside its source", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    const tableFrom = TABLE_DOC.indexOf("| A |");
    ctrl.select({ r: 0, c: 0 });
    ctrl.exit("before");
    const head = view.state.selection.main.head;
    expect(head).toBeLessThan(tableFrom);
    view.dispatch({ changes: { from: head, insert: "outside" } });
    const doc = view.state.doc.toString();
    expect(doc).toContain("| A | B |\n| --- | ---: |\n| 1 | 2 |");
    expect(doc.indexOf("outside")).toBeLessThan(doc.indexOf("| A |"));
    view.destroy();
  });

  it("Insert row below with the header selected lands at the body's top", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 });
    ctrl.insertRowCommand("below");
    expect(view.state.doc.toString()).toContain(
      "| --- | ---: |\n|  |  |\n| 1 | 2 |",
    );
    view.destroy();
  });

  it("applyImport refuses when the table changed since the dialog opened", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 1, c: 0 });
    ctrl.setDialog("import");
    const from = TABLE_DOC.indexOf("| 1 |") + 2;
    view.dispatch({ changes: { from, to: from + 1, insert: "9" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(ctrl.applyImport([["x", "y"]], false, "insert")).toBe(false);
    const doc = view.state.doc.toString();
    expect(doc).toContain("| 9 |");
    expect(doc).not.toContain("| x | y |");
    expect(ctrl.getSnapshot().message).toContain("changed since you opened");
    view.destroy();
  });

  it("paste refuses malformed rows and a result over the cell cap", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 1, c: 0 });
    expect(ctrl.pasteRows([null])).toBe(false);
    expect(ctrl.getSnapshot().message).toBeTruthy();
    expect(view.state.doc.toString()).toBe(TABLE_DOC);
    view.destroy();
  });

  it("a paste is refused when the FINAL table would exceed the cap", async () => {
    const wide = `|${" h |".repeat(200)}`;
    const doc = [
      wide,
      `|${" --- |".repeat(200)}`,
      ...Array.from({ length: 5 }, () => wide),
    ].join("\n");
    const view = mount(doc, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 5, c: 0 });
    // The 100×100 input is within bounds and the growth delta is under the
    // cap — but the finished 105×200 table is not.
    const rows = Array.from({ length: 100 }, () =>
      Array.from({ length: 100 }, () => "p"),
    );
    expect(ctrl.pasteRows(rows)).toBe(false);
    expect(ctrl.getSnapshot().message).toMatch(/row table/);
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });
});
