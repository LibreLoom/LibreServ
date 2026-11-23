import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import { SqliteEditorSession } from "./SqliteEditor.jsx";

vi.mock("./sqliteClient.js", () => {
  const tables = [
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
    createSqliteClient: () => ({
      open: async () => ({ tables }),
      schema: async () => ({ tables }),
      exec: async (sql) => {
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
    }),
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

  it("collapses the SQL editor and brings it back", async () => {
    mountSession();
    await screen.findByText("Party");

    fireEvent.click(
      screen.getByRole("button", { name: "Hide SQL editor" }),
    );
    const body = document.getElementById("sqlite-sql-editor-body");
    expect(body).toHaveAttribute("aria-hidden", "true");
    expect(body).toHaveAttribute("inert");
    expect(
      screen.queryByRole("button", { name: "Run" }),
    ).not.toBeInTheDocument();

    const show = screen.getByRole("button", { name: "Show SQL editor" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(show);
    expect(body).not.toHaveAttribute("aria-hidden");
    expect(body).not.toHaveAttribute("inert");
    expect(
      screen.getByRole("button", { name: "Run" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Hide SQL editor" }),
    ).toHaveAttribute("aria-expanded", "true");
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
