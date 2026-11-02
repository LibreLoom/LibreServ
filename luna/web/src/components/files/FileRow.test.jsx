import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import FileRow from "./FileRow.jsx";

const api = new Proxy({}, { get: () => vi.fn() });

function renderRow() {
  return render(
    <MemoryRouter>
      <ul>
        <FileRow
          entry={{ name: "a.txt", kind: "file", caps: "" }}
          path=""
          fileRoot={false}
          striped={false}
          isSelected={false}
          isDrop={false}
          isPicker={false}
          pickerMode={false}
          pickSelected={false}
          multiSelect={false}
          linkNavigation
          canDragRow={false}
          dropEnabled={false}
          trashView={false}
          dense={false}
          hasShare={false}
          enableDownload={false}
          renderRowActions={undefined}
          surface="secondary"
          hasCopy
          hasMove
          hasRename
          hasDelete
          api={api}
          folderHref={() => "/"}
          fileHref={() => "/"}
          driveId="d1"
        />
      </ul>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("FileRow", () => {
  it("shows every action inline on wide screens", () => {
    renderRow();
    expect(screen.getByRole("button", { name: "Copy a.txt" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions for a.txt" })).not.toBeInTheDocument();
  });

  it("collapses actions into one lightning button on phones", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    renderRow();
    expect(screen.queryByRole("button", { name: "Copy a.txt" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Actions for a.txt" }));
    expect(await screen.findByText("Rename")).toBeInTheDocument();
  });
});
