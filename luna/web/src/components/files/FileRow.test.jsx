import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import FileRow from "./FileRow.jsx";

const api = new Proxy({}, { get: () => vi.fn() });

function renderRow(overrides = {}) {
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
          {...overrides}
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

  // The explorer supplies its own action row. On a phone that row used to
  // render in full, squeezing the file name to nothing.
  it("collapses an explorer row's actions into the lightning button on phones", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    renderRow({
      renderRowActions: () => <button type="button">Explorer action</button>,
      renderRowSheetActions: (_ctx, close) => (
        <button type="button" onClick={close}>Sheet action</button>
      ),
    });
    expect(screen.queryByText("Explorer action")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Actions for a.txt" }));
    expect(await screen.findByText("Sheet action")).toBeInTheDocument();
  });

  it("keeps an explorer row's actions inline on wide screens", () => {
    renderRow({ renderRowActions: () => <button type="button">Explorer action</button> });
    expect(screen.getByText("Explorer action")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions for a.txt" })).not.toBeInTheDocument();
  });
});
