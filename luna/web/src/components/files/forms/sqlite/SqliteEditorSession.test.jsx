import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
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
  it("loads the table the person just chose instead of staying on the spinner", async () => {
    mountSession();
    expect(await screen.findByText("Party")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^members,/i }));
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.queryByText(/Loading rows/)).not.toBeInTheDocument();
  });
});
