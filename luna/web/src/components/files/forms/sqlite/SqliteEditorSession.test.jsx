import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import { SqliteEditorSession } from "./SqliteEditor.jsx";

vi.mock("./sqliteClient.js", () => {
  const baseTables = [
    {
      name: "events",
      columns: [
        { name: "id", type: "INTEGER", pk: 1, notNull: false, generated: false, hidden: false },
        { name: "title", type: "TEXT", pk: 0, notNull: false, generated: false, hidden: false },
      ],
      primaryKey: ["id"],
      rowCount: 1,
    },
    {
      name: "members",
      columns: [
        { name: "id", type: "INTEGER", pk: 1, notNull: false, generated: false, hidden: false },
        { name: "name", type: "TEXT", pk: 0, notNull: false, generated: false, hidden: false },
      ],
      primaryKey: ["id"],
      rowCount: 1,
    },
  ];
  return {
    createSqliteClient: () => {
      const tables = structuredClone(baseTables);
      return {
        open: async () => ({ tables: structuredClone(tables) }),
        schema: async () => ({ tables: structuredClone(tables) }),
        exec: async (sql) => {
          const renamed = sql.match(
            /^ALTER TABLE "((?:[^"]|"")+)" RENAME TO "((?:[^"]|"")+)"/,
          );
          if (renamed) {
            const from = renamed[1].replaceAll('""', '"');
            const to = renamed[2].replaceAll('""', '"');
            const table = tables.find((entry) => entry.name === from);
            if (table) table.name = to;
            return { columns: [], rows: [], rowCount: 0, changes: 1, truncated: false };
          }
          const dropped = sql.match(/^DROP TABLE "((?:[^"]|"")+)"/);
          if (dropped) {
            const name = dropped[1].replaceAll('""', '"');
            const index = tables.findIndex((entry) => entry.name === name);
            if (index >= 0) tables.splice(index, 1);
            return { columns: [], rows: [], rowCount: 0, changes: 1, truncated: false };
          }
          if (/COUNT\(/i.test(sql)) {
            return { columns: ["count"], rows: [[1]], rowCount: 1, changes: 0, truncated: false };
          }
          if (sql.includes('"members"')) {
            return {
              columns: ["id", "name"],
              rows: [[1, "Ada"]],
              rowCount: 1,
              changes: 0,
              truncated: false,
            };
          }
          return {
            columns: ["id", "title"],
            rows: [[1, "Party"]],
            rowCount: 1,
            changes: 0,
            truncated: false,
          };
        },
        exportBytes: async () => new Uint8Array([1]),
        dispose: () => {},
      };
    },
  };
});

function mountSession() {
  return render(
    <ToastProvider>
      <Toaster />
      <SqliteEditorSession
        canWrite
        initialBytes={new Uint8Array([1, 2, 3])}
        revision={1}
        onSave={vi.fn()}
        onReload={vi.fn()}
        frame={{ onRegisterSave: vi.fn(), onSaveStateChange: vi.fn() }}
      />
    </ToastProvider>,
  );
}

describe("SqliteEditorSession table switching", () => {
  it("opens the New table dialog from the plus button", async () => {
    mountSession();
    await screen.findByText("Party");
    fireEvent.click(screen.getByRole("button", { name: "New table" }));
    expect(await screen.findByRole("heading", { name: "New table" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Table name"), {
      target: { value: "notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create table" }));
    expect(await screen.findByText("Table created")).toBeInTheDocument();
  });

  it("does not pop the tables card in when the editor opens", async () => {
    mountSession();
    await screen.findByText("Party");

    expect(
      screen.getByRole("navigation", { name: "Tables" }).className,
    ).not.toContain("pop-in");
  });

  it("explains what SQL is from the SQL header", async () => {
    mountSession();
    await screen.findByText("Party");

    fireEvent.click(screen.getByRole("button", { name: "About SQL" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /language for reading and changing a database/i,
    );
  });

  it("starts with the SQL editor folded and opens it on demand", async () => {
    mountSession();
    await screen.findByText("Party");

    const body = document.getElementById("sqlite-sql-editor-body");
    expect(body).toHaveAttribute("aria-hidden", "true");
    expect(body).toHaveAttribute("inert");
    expect(body?.querySelector(".cm-content")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Run" }),
    ).not.toBeInTheDocument();

    const show = screen.getByRole("button", { name: "Show SQL editor" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(show);
    expect(body).not.toHaveAttribute("aria-hidden");
    expect(body).not.toHaveAttribute("inert");
    await waitFor(() => expect(body?.querySelector(".cm-content")).toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "Run" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide SQL editor" }));
    expect(body).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.queryByRole("button", { name: "Run" }),
    ).not.toBeInTheDocument();
  });

  it("renames a table from its row menu", async () => {
    mountSession();
    await screen.findByText("Party");

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for table events" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename table" }));

    const input = await screen.findByLabelText("Table name");
    expect(input).toHaveValue("events");
    fireEvent.change(input, { target: { value: "gatherings" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename table" }));

    expect(await screen.findByText("Table renamed")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /^gatherings,/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^events,/i }),
    ).not.toBeInTheDocument();
  });

  it("deletes a table after confirming, and moves to another table", async () => {
    mountSession();
    await screen.findByText("Party");

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for table events" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete table" }));
    expect(
      await screen.findByText(/Every row in it is removed/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete table" }));

    expect(await screen.findByText("Table deleted")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /^members,/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^events,/i }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("Ada")).toBeInTheDocument();
  });

  it("explains cell editing from the table header", async () => {
    mountSession();
    await screen.findByText("Party");

    fireEvent.click(
      screen.getByRole("button", { name: "About editing cells" }),
    );
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /Double-click a cell to edit it/i,
    );
  });

  it("collapses the table list and gives focus to the way back", async () => {
    mountSession();
    expect(await screen.findByText("Party")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide tables" }));
    expect(
      screen.queryByRole("button", { name: /^members,/i }),
    ).not.toBeInTheDocument();
    const show = screen.getByRole("button", { name: "Show tables" });
    await waitFor(() => expect(show).toHaveFocus());

    fireEvent.click(show);
    expect(
      await screen.findByRole("button", { name: /^members,/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Hide tables" })).toHaveFocus(),
    );
  });

  it("loads the table the person just chose instead of staying on the spinner", async () => {
    mountSession();
    expect(await screen.findByText("Party")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^members,/i }));
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.queryByText(/Loading rows/)).not.toBeInTheDocument();
  });
});
