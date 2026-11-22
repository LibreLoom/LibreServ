import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import SqliteEditor from "./SqliteEditor.jsx";
import { MAX_DATABASE_BYTES } from "./sqliteModel.js";

function mount(bytes) {
  return render(
    <ToastProvider>
      <SqliteEditor
        name="answers.sqlite"
        sessionKey="answers-1"
        canWrite
        initialBytes={bytes}
        revision={4}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    </ToastProvider>,
  );
}

describe("SqliteEditor size cap", () => {
  it("refuses a database over 16 MiB without opening a worker", async () => {
    mount(new Uint8Array(MAX_DATABASE_BYTES + 1));

    expect(
      await screen.findByText(/too large to edit here/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Use the Responses view/i)).toBeInTheDocument();
    expect(screen.queryByText(/Opening database/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^SQL$/)).not.toBeInTheDocument();
  });

  it("lets a database exactly at the cap through to the editor", async () => {
    // The editor itself will fail in jsdom (no Worker), which is fine: the
    // point is that the size gate did not fire.
    mount(new Uint8Array(MAX_DATABASE_BYTES));
    expect(
      await screen.findByText(/browser can't run the database editor|couldn't open this database/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/too large to edit here/i)).not.toBeInTheDocument();
  });
});
