import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileSourceProvider } from "../../lib/fileSource.jsx";
import SqliteFileEditor from "./SqliteFileEditor.jsx";

const sessionMock = vi.hoisted(() => ({
  props: /** @type {any} */ (null),
}));

vi.mock("./forms/sqlite/SqliteEditor.jsx", () => ({
  SqliteEditorSession: (props) => {
    sessionMock.props = props;
    return (
      <div
        data-testid="session"
        data-revision={props.revision}
        data-readonly={String(!props.canWrite)}
      >
        {props.initialBytes.byteLength} bytes
      </div>
    );
  },
}));

function makeSource(overrides = {}) {
  return {
    fetchBytes: vi.fn(async (..._args) => new Uint8Array([1, 2, 3]).buffer),
    stat: vi.fn(async (..._args) => ({ modified: 100, size: 3 })),
    saveFile: vi.fn(async (..._args) => ({})),
    ...overrides,
  };
}

function renderEditor(source, props = {}) {
  return render(
    <FileSourceProvider source={source}>
      <SqliteFileEditor
        driveId="d1"
        path="db/luna-demo.sqlite"
        name="luna-demo.sqlite"
        onRegisterSave={() => {}}
        onSaveStateChange={() => {}}
        {...props}
      />
    </FileSourceProvider>,
  );
}

describe("SqliteFileEditor", () => {
  it("loads the file and gives the session its revision", async () => {
    const source = makeSource();
    renderEditor(source, { canWrite: false });

    const session = await screen.findByTestId("session");
    expect(session).toHaveTextContent("3 bytes");
    expect(session.dataset.revision).toBe("100:3");
    expect(session.dataset.readonly).toBe("true");
    expect(source.fetchBytes).toHaveBeenCalledWith("d1", "db/luna-demo.sqlite");
  });

  it("shows the server's message when the file cannot be read", async () => {
    const source = makeSource({
      fetchBytes: vi.fn(async () => {
        throw new Error("This database is locked.");
      }),
    });
    renderEditor(source);
    expect(await screen.findByText("This database is locked.")).toBeInTheDocument();
  });

  it("refuses to save over a file that changed on the drive", async () => {
    const source = makeSource();
    source.stat
      .mockResolvedValueOnce({ modified: 100, size: 3 })
      .mockResolvedValueOnce({ modified: 200, size: 3 });
    const onSaved = vi.fn();
    renderEditor(source, { onSaved });

    await screen.findByTestId("session");
    await expect(
      sessionMock.props.onSave(new Uint8Array([9]), "100:3"),
    ).rejects.toMatchObject({ status: 409 });
    expect(source.saveFile).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("saves the bytes and returns the new revision", async () => {
    const source = makeSource();
    source.stat
      .mockResolvedValueOnce({ modified: 100, size: 3 })
      .mockResolvedValueOnce({ modified: 100, size: 3 })
      .mockResolvedValueOnce({ modified: 101, size: 4 });
    const onSaved = vi.fn();
    renderEditor(source, { onSaved });

    await screen.findByTestId("session");
    const result = await sessionMock.props.onSave(new Uint8Array([9]), "100:3");
    expect(result).toEqual({ revision: "101:4" });
    expect(source.saveFile).toHaveBeenCalledTimes(1);
    const blob = /** @type {Blob} */ (source.saveFile.mock.calls[0][3]);
    expect(blob.type).toBe("application/vnd.sqlite3");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([9]));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
