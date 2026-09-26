import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { fireEvent, screen, within } from "@testing-library/react";
import { markdownLivePreview } from "./markdownLivePreview.js";

const TABLE_DOC = "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\nafter";

function mount(doc) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ extensions: [GFM] }), markdownLivePreview()],
    }),
  });
}

async function settled(view) {
  await vi.waitFor(() => {
    view.requestMeasure();
    if (!view.dom.querySelector(".md-table-grid")) {
      throw new Error("table not rendered yet");
    }
  });
}

/** Open a menu by its trigger label and return the option labels. */
async function openMenu(view, label) {
  fireEvent.click(within(view.dom).getByRole("button", { name: label }));
  const menu = await vi.waitFor(() => {
    const el = document.querySelector("[data-slot='dropdown-menu']");
    if (!(el instanceof HTMLElement)) throw new Error("menu not open");
    return el;
  });
  return within(menu)
    .getAllByRole("option")
    .map((o) => o.textContent);
}

async function choose(label) {
  fireEvent.click(screen.getByRole("option", { name: label }));
  // The dropdown plays a short close animation before unmounting.
  await vi.waitFor(() => {
    if (document.querySelector("[data-slot='dropdown-menu']")) {
      throw new Error("menu still open");
    }
  });
}

function table(view) {
  const doc = view.state.doc.toString();
  return doc.slice(doc.indexOf("|"), doc.lastIndexOf("|") + 1);
}

describe("column menu (header cells)", () => {
  it("offers Nextcloud's column actions", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    expect(await openMenu(view, "Column 1 options")).toEqual([
      "Align left",
      "Align center",
      "Align right",
      "Sort A → Z",
      "Sort Z → A",
      "Add column left",
      "Add column right",
      "Delete this column",
    ]);
    await choose("Align center");
    expect(table(view)).toBe("| A | B |\n| :---: | --- |\n| 1 | 2 |\n| 3 | 4 |");
    view.destroy();
  });

  it("sorts body rows by the column, header fixed", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    await openMenu(view, "Column 2 options");
    await choose("Sort Z → A");
    expect(table(view)).toBe("| A | B |\n| --- | --- |\n| 3 | 4 |\n| 1 | 2 |");
    view.destroy();
  });

  it("adds a column left or right and opens its heading cell", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    await openMenu(view, "Column 1 options");
    await choose("Add column right");
    expect(table(view)).toBe(
      "| A |  | B |\n| --- | --- | --- |\n| 1 |  | 2 |\n| 3 |  | 4 |",
    );
    await vi.waitFor(() => {
      expect(document.activeElement?.closest("[data-cell]")?.getAttribute("data-cell")).toBe("0,1");
    });
    await openMenu(view, "Column 1 options");
    await choose("Add column left");
    expect(table(view).split("\n")[0]).toBe("|  | A |  | B |");
    view.destroy();
  });

  it("deletes a column, and never offers to delete the only one", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    await openMenu(view, "Column 1 options");
    await choose("Delete this column");
    expect(table(view)).toBe("| B |\n| --- |\n| 2 |\n| 4 |");
    expect(await openMenu(view, "Column 1 options")).not.toContain("Delete this column");
    view.destroy();
  });
});

describe("row menu (body rows)", () => {
  it("adds rows above and below, and deletes a row", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    expect(await openMenu(view, "Row 1 options")).toEqual([
      "Add row above",
      "Add row below",
      "Delete this row",
    ]);
    await choose("Add row below");
    expect(table(view)).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |\n|  |  |\n| 3 | 4 |");
    await openMenu(view, "Row 1 options");
    await choose("Add row above");
    expect(table(view)).toBe(
      "| A | B |\n| --- | --- |\n|  |  |\n| 1 | 2 |\n|  |  |\n| 3 | 4 |",
    );
    await openMenu(view, "Row 4 options");
    await choose("Delete this row");
    expect(table(view)).toBe("| A | B |\n| --- | --- |\n|  |  |\n| 1 | 2 |\n|  |  |");
    view.destroy();
  });

  it("the header row has the table menu instead of a row menu", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    expect(within(view.dom).queryByRole("button", { name: "Row 0 options" })).toBeNull();
    expect(await openMenu(view, "Table options")).toEqual(["Delete this table"]);
    await choose("Delete this table");
    expect(view.state.doc.toString()).toBe("intro\n\nafter");
    view.destroy();
  });
});

describe("add strips", () => {
  it("Add column appends a column; Add row appends a row", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    fireEvent.click(within(view.dom).getByRole("button", { name: "Add column" }));
    expect(table(view)).toBe(
      "| A | B |  |\n| --- | --- | --- |\n| 1 | 2 |  |\n| 3 | 4 |  |",
    );
    fireEvent.click(within(view.dom).getByRole("button", { name: "Add row" }));
    expect(table(view).split("\n").at(-1)).toBe("|  |  |  |");
    await vi.waitFor(() => {
      expect(document.activeElement?.closest("[data-cell]")?.getAttribute("data-cell")).toBe("3,0");
    });
    view.destroy();
  });
});
