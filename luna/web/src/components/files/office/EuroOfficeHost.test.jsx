import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import EuroOfficeHost from "./EuroOfficeHost.jsx";
import { FileSourceProvider, driveSource } from "../../../lib/fileSource.jsx";
import {
  createEuroOfficeSession,
  ensureOfficeBundle,
  loadEuroOfficeDocsApi,
  EuroOfficeUnavailableError,
  saveEuroOfficeDocument,
} from "./euroOfficeApi.js";
import { CollabSocket } from "./collabSocket.js";

// The DocsAPI/editor boundary is stubbed: the DocEditor class is a fake that
// records its config, and the api helpers are spied so the test can see which
// source the host hands to session/content/save plumbing.
const apiMocks = vi.hoisted(() => ({
  editors: /** @type {any[]} */ ([]),
}));

vi.mock("./euroOfficeApi.js", async (importOriginal) => {
  const real = /** @type {any} */ (await importOriginal());
  class FakeDocEditor {
    /**
     * @param {string} _id
     * @param {any} config
     */
    constructor(_id, config) {
      apiMocks.editors.push(config);
      // DocsAPI replaces the placeholder with a frame; the fake just marks it.
      const node = document.getElementById(_id);
      if (node) node.dataset.fakeEditor = "1";
    }
    destroyEditor() {}
  }
  return {
    ...real,
    createEuroOfficeSession: vi.fn(),
    ensureOfficeBundle: vi.fn(async () => ({ converted: false })),
    loadEuroOfficeDocsApi: vi.fn(async () => ({ DocEditor: FakeDocEditor })),
    watchEuroOfficeFocus: vi.fn(() => () => {}),
    watchEuroOfficeChanges: vi.fn(() => () => {}),
    watchEuroOfficeSaved: vi.fn(() => () => {}),
    watchEuroOfficeSocket: vi.fn(() => () => {}),
    patchEuroOfficeDownloadAs: vi.fn(),
    patchEuroOfficeReconnect: vi.fn(),
    patchEuroOfficeSaveState: vi.fn(),
    saveEuroOfficeDocument: vi.fn(async () => ({})),
    requestEuroOfficeSaveLock: vi.fn(async () => true),
    releaseEuroOfficeSaveLock: vi.fn(),
    restoreEuroOfficeEditing: vi.fn(),
    emitEuroOfficeSaved: vi.fn(),
  };
});

vi.mock("./collabSocket.js", () => ({
  CollabSocket: vi.fn(function () {
    return { onMessage: null, connect: vi.fn(), close: vi.fn() };
  }),
}));

vi.mock("@libreloom/ui/hooks/useTheme.jsx", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

/** @param {Record<string, any>} [over] */
function session(over = {}) {
  return {
    key: "k1",
    title: "Report.docx",
    file_type: "docx",
    document_type: "word",
    can_write: true,
    token: "jwt-1",
    bundle_url: "/s/office-bundle/k1",
    document_url: "/doc",
    user: { id: "u1", name: "Max" },
    ...over,
  };
}

function lastEditor() {
  return apiMocks.editors[apiMocks.editors.length - 1];
}

describe("EuroOfficeHost source plumbing", () => {
  beforeEach(() => {
    apiMocks.editors.length = 0;
    vi.mocked(createEuroOfficeSession).mockReset().mockResolvedValue(session());
    vi.mocked(ensureOfficeBundle).mockClear();
    vi.mocked(loadEuroOfficeDocsApi).mockClear();
    vi.mocked(CollabSocket).mockClear();
  });

  it("opens a member session through the drive source and mounts edit mode", async () => {
    render(
      <EuroOfficeHost driveId="d1" path="docs/Report.docx" canWrite />,
    );
    await waitFor(() => expect(lastEditor()).toBeTruthy());
    expect(vi.mocked(createEuroOfficeSession)).toHaveBeenCalledWith(
      "d1",
      "docs/Report.docx",
      driveSource,
    );
    expect(vi.mocked(ensureOfficeBundle)).toHaveBeenCalledWith(
      "d1",
      "docs/Report.docx",
      expect.objectContaining({ key: "k1" }),
      driveSource,
    );
    expect(lastEditor().editorConfig.mode).toBe("edit");
    expect(lastEditor().token).toBe("jwt-1");
    expect(vi.mocked(CollabSocket)).toHaveBeenCalled();
  });

  it("opens a guest session through the share source without a presence socket", async () => {
    const source = /** @type {any} */ ({
      ...driveSource,
      kind: "share",
      guest: true,
      collab: false,
      token: "tok",
      officeSession: vi.fn(async () => session({ user: { id: "guest:1", name: "Guest" } })),
      downloadHref: () => "/s/tok/file?download=1",
    });
    vi.mocked(createEuroOfficeSession).mockResolvedValue(
      session({ user: { id: "guest:1", name: "Guest" } }),
    );
    render(
      <FileSourceProvider source={source}>
        <EuroOfficeHost driveId="tok" path="Report.docx" canWrite />
      </FileSourceProvider>,
    );
    await waitFor(() => expect(lastEditor()).toBeTruthy());
    expect(vi.mocked(createEuroOfficeSession)).toHaveBeenCalledWith(
      "tok",
      "Report.docx",
      source,
    );
    expect(vi.mocked(ensureOfficeBundle)).toHaveBeenCalledWith(
      "tok",
      "Report.docx",
      expect.objectContaining({ key: "k1" }),
      source,
    );
    // The session's guest identity wins — not any ambient signed-in user.
    expect(lastEditor().editorConfig.user.id).toBe("guest:1");
    expect(vi.mocked(CollabSocket)).not.toHaveBeenCalled();
  });

  it("mounts view mode and skips save wiring when the session is read-only", async () => {
    vi.mocked(createEuroOfficeSession).mockResolvedValue(session({ can_write: false }));
    const onRegisterSave = vi.fn();
    render(
      <EuroOfficeHost
        driveId="d1"
        path="docs/Report.docx"
        canWrite
        onRegisterSave={onRegisterSave}
      />,
    );
    await waitFor(() => expect(lastEditor()).toBeTruthy());
    expect(lastEditor().editorConfig.mode).toBe("view");
    expect(lastEditor().document.permissions.edit).toBe(false);
    expect(onRegisterSave).not.toHaveBeenCalled();
  });

  it("reports a missing pack through onUnavailable", async () => {
    vi.mocked(loadEuroOfficeDocsApi).mockRejectedValueOnce(new EuroOfficeUnavailableError());
    const onUnavailable = vi.fn();
    render(
      <EuroOfficeHost driveId="d1" path="docs/Report.docx" onUnavailable={onUnavailable} />,
    );
    await waitFor(() => expect(onUnavailable).toHaveBeenCalled());
  });

  it("stays unsaved when an edit lands while a save is uploading", async () => {
    const onSaveStateChange = vi.fn();
    const onRegisterSave = vi.fn();
    render(
      <EuroOfficeHost
        driveId="d1"
        path="docs/Report.docx"
        canWrite
        onSaveStateChange={onSaveStateChange}
        onRegisterSave={onRegisterSave}
      />,
    );
    await waitFor(() => expect(onRegisterSave).toHaveBeenCalledWith(expect.any(Function)));
    const save = onRegisterSave.mock.calls.at(-1)[0];
    const edit = () => lastEditor().events.onDocumentStateChange({ data: true });

    /** @type {() => void} */
    let finishUpload = () => {};
    vi.mocked(saveEuroOfficeDocument).mockImplementationOnce(
      () => new Promise((resolve) => { finishUpload = () => resolve({ bytes: 0 }); }),
    );
    act(edit);
    let saving;
    act(() => { saving = save(); });
    await waitFor(() => expect(vi.mocked(saveEuroOfficeDocument)).toHaveBeenCalled());
    act(edit); // typed after the document was serialized
    onSaveStateChange.mockClear();
    await act(async () => { finishUpload(); await saving; });
    expect(onSaveStateChange).not.toHaveBeenCalledWith(false);
  });

  it("reports saved when nothing changed during the save", async () => {
    const onSaveStateChange = vi.fn();
    const onRegisterSave = vi.fn();
    render(
      <EuroOfficeHost
        driveId="d1"
        path="docs/Report.docx"
        canWrite
        onSaveStateChange={onSaveStateChange}
        onRegisterSave={onRegisterSave}
      />,
    );
    await waitFor(() => expect(onRegisterSave).toHaveBeenCalledWith(expect.any(Function)));
    const save = onRegisterSave.mock.calls.at(-1)[0];
    act(() => lastEditor().events.onDocumentStateChange({ data: true }));
    await act(async () => { await save(); });
    expect(onSaveStateChange).toHaveBeenLastCalledWith(false);
  });
});
