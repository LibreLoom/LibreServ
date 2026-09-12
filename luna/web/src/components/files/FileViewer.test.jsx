import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
import FileViewer from "./FileViewer.jsx";

// OfficeEditor mounts EuroOfficeHost (auth/theme contexts, sockets, DocsAPI);
// the fullscreen chrome tests only need to know the editor subtree exists.
// The mock also captures props so tests can drive the save-state callbacks the
// real EuroOfficeHost would fire.
const officeMocks = vi.hoisted(() => ({
  editorProps: /** @type {Record<string, any>} */ ({}),
}));
vi.mock("./office/OfficeEditor.jsx", () => ({
  default: (props) => {
    officeMocks.editorProps = props;
    return <div data-testid="office-editor" />;
  },
}));

/** Fullscreen exit animation duration (file-viewer-out, 250ms) + slack. */
const EXIT_WAIT_MS = 300;

async function waitForExitAnimation() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, EXIT_WAIT_MS));
  });
}

/** @type {typeof Image | undefined} */
let OriginalImage;

function mockImageLoader(behavior = "load") {
  OriginalImage = globalThis.Image;
  // @ts-expect-error test mock
  globalThis.Image = vi.fn(function MockImage() {
    /** @type {(() => void) | null} */
    this.onload = null;
    /** @type {(() => void) | null} */
    this.onerror = null;
    let _src = "";
    Object.defineProperty(this, "src", {
      get: () => _src,
      set: (value) => {
        _src = value;
        queueMicrotask(() => {
          if (behavior === "load") this.onload?.();
          else this.onerror?.();
        });
      },
    });
  });
}

describe("FileViewer image preview", () => {
  beforeEach(() => {
    mockImageLoader("load");
  });

  afterEach(() => {
    if (OriginalImage) globalThis.Image = OriginalImage;
    vi.restoreAllMocks();
  });

  it("shows loading spinner then the photo after preload completes", async () => {
    render(
      <FileViewer
        open
        driveId="drive-1"
        path="/Photos/vacation.jpg"
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();

    await act(async () => {
      await Promise.resolve();
    });

    const img = screen.getByRole("img", { name: "vacation.jpg" });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "/api/v1/drives/drive-1/files/content?path=%2FPhotos%2Fvacation.jpg");
    expect(screen.queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();
  });

  it("toggles full view and back via the exit button", async () => {
    render(
      <FileViewer
        open
        driveId="drive-1"
        path="/Photos/vacation.jpg"
        onClose={() => {}}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const expand = screen.getByRole("button", { name: "Full view" });
    fireEvent.click(expand);

    const exitBtn = screen.getByRole("button", { name: "Exit full view" });
    expect(exitBtn).toBeInTheDocument();
    expect(document.querySelector('[data-slot="file-viewer-fullview"]')).toHaveClass("file-viewer-enter");
    expect(screen.queryByRole("button", { name: "Normal size" })).not.toBeInTheDocument();

    fireEvent.click(exitBtn);
    // Exit animation keeps the overlay mounted until it finishes.
    expect(document.querySelector('[data-slot="file-viewer-fullview"]')).toHaveClass("file-viewer-exit");
    expect(screen.getByRole("button", { name: "Exit full view" })).toBeInTheDocument();

    await waitForExitAnimation();
    expect(screen.queryByRole("button", { name: "Exit full view" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Full view" })).toBeInTheDocument();
  });

  it("returns from full view to normal view on Escape without closing modal", async () => {
    const onClose = vi.fn();
    render(
      <FileViewer
        open
        driveId="drive-1"
        path="/Photos/vacation.jpg"
        onClose={onClose}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Full view" }));
    expect(screen.getByRole("button", { name: "Exit full view" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector('[data-slot="file-viewer-fullview"]')).toHaveClass("file-viewer-exit");

    await waitForExitAnimation();
    expect(screen.queryByRole("button", { name: "Exit full view" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Full view" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("manages focus when entering and exiting full view", async () => {
    render(
      <FileViewer
        open
        driveId="drive-1"
        path="/Photos/vacation.jpg"
        onClose={() => {}}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const fullViewBtn = screen.getByRole("button", { name: "Full view" });
    fireEvent.click(fullViewBtn);

    const exitBtn = screen.getByRole("button", { name: "Exit full view" });
    expect(document.activeElement).toBe(exitBtn);

    fireEvent.click(exitBtn);
    expect(document.activeElement).toBe(fullViewBtn);
  });

  it("closes the modal when Escape is pressed in normal view", async () => {
    const onClose = vi.fn();
    render(
      <FileViewer
        open
        driveId="drive-1"
        path="/Photos/vacation.jpg"
        onClose={onClose}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("supports full view for videos", async () => {
    render(
      <FileViewer
        open
        driveId="drive-1"
        path="/Videos/clip.mp4"
        onClose={() => {}}
      />,
    );

    const fullViewBtn = screen.getByRole("button", { name: "Full view" });
    fireEvent.click(fullViewBtn);

    expect(screen.getByRole("button", { name: "Exit full view" })).toBeInTheDocument();
    // Video in full view
    const video = document.querySelector('video[src="/api/v1/drives/drive-1/files/content?path=%2FVideos%2Fclip.mp4"]');
    expect(video).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Exit full view" }));
    await waitForExitAnimation();
    expect(screen.queryByRole("button", { name: "Exit full view" })).not.toBeInTheDocument();
  });

  it("shows an error message when the photo fails to load", async () => {
    mockImageLoader("error");

    render(
      <FileViewer
        open
        driveId="drive-1"
        path="/Photos/broken.jpg"
        onClose={() => {}}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/Luna couldn't show this photo/i)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("FileViewer text save", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves an existing text file with overwrite=1", async () => {
    const fetchMock = vi.fn(async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || "GET").toUpperCase();
      if (u.includes("/files/content") && method === "GET") {
        return new Response("hello", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      if (u.includes("/files/upload") && method === "POST") {
        return new Response(JSON.stringify({ name: "note.txt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <FileViewer
        open
        driveId="d1"
        path="notes/note.txt"
        onClose={() => {}}
      />,
    );

    const editor = await screen.findByLabelText("Contents of note.txt");
    expect(editor).toHaveValue("hello");
    fireEvent.change(editor, { target: { value: "hello world" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => {
      const upload = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes("/files/upload") && (init?.method || "GET").toUpperCase() === "POST"
      );
      expect(upload).toBeTruthy();
      expect(String(upload[0])).toContain("overwrite=1");
    });

    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();

    fireEvent.change(editor, { target: { value: "hello world again" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("shows Saved when text matches saved content on load", async () => {
    const fetchMock = vi.fn(async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || "GET").toUpperCase();
      if (u.includes("/files/content") && method === "GET") {
        return new Response("hello", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response("{}", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <FileViewer
        open
        driveId="d1"
        path="notes/note.txt"
        onClose={() => {}}
      />,
    );

    await screen.findByLabelText("Contents of note.txt");
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
  });
});

describe("FileViewer markdown editor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockMarkdownFetch(body = "# Title\n\nSome **bold** text") {
    const fetchMock = vi.fn(async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || "GET").toUpperCase();
      if (u.includes("/files/content") && method === "GET") {
        return new Response(body, { status: 200, headers: { "Content-Type": "text/markdown" } });
      }
      if (u.includes("/files/upload") && method === "POST") {
        return new Response(JSON.stringify({ name: "roadmap.md" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("toggles between Edit and Preview for .md files", async () => {
    mockMarkdownFetch();

    render(
      <FileViewer
        open
        driveId="d1"
        path="docs/roadmap.md"
        onClose={() => {}}
      />,
    );

    const editor = await screen.findByLabelText("Contents of roadmap.md");
    expect(editor).toHaveValue("# Title\n\nSome **bold** text");
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Preview" }));

    expect(screen.queryByLabelText("Contents of roadmap.md")).not.toBeInTheDocument();
    const preview = screen.getByLabelText("Preview of roadmap.md");
    expect(preview.querySelector("h1")).toHaveTextContent("Title");
    expect(preview.querySelector("strong")).toHaveTextContent("bold");

    fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
    expect(screen.getByLabelText("Contents of roadmap.md")).toBeInTheDocument();
  });

  it("saves markdown through the same upload path", async () => {
    const fetchMock = mockMarkdownFetch();

    render(
      <FileViewer
        open
        driveId="d1"
        path="docs/roadmap.md"
        onClose={() => {}}
      />,
    );

    const editor = await screen.findByLabelText("Contents of roadmap.md");
    fireEvent.change(editor, { target: { value: "# Updated" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => {
      const upload = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes("/files/upload") && (init?.method || "GET").toUpperCase() === "POST"
      );
      expect(upload).toBeTruthy();
      expect(String(upload[0])).toContain("overwrite=1");
    });
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
  });

  it("inserts markdown syntax from the formatting toolbar", async () => {
    mockMarkdownFetch();

    render(
      <FileViewer
        open
        driveId="d1"
        path="docs/roadmap.md"
        onClose={() => {}}
      />,
    );

    const editor = await screen.findByLabelText("Contents of roadmap.md");
    /** @type {HTMLTextAreaElement} */ (editor).setSelectionRange(0, 0);
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(editor).toHaveValue("- # Title\n\nSome **bold** text");
  });

  it("keeps the plain textarea for non-markdown text files", async () => {
    mockMarkdownFetch();

    render(
      <FileViewer
        open
        driveId="d1"
        path="notes/note.txt"
        onClose={() => {}}
      />,
    );

    await screen.findByLabelText("Contents of note.txt");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });
});

describe("FileViewer fullscreen office overlay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mockEuroOfficePresent() {
    vi.stubGlobal("fetch", vi.fn(async (url) =>
      String(url).includes("/eurooffice/")
        ? new Response("/* DocsAPI */", {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          })
        : new Response("{}", { status: 404 }),
    ));
  }

  async function findFullscreenOverlay() {
    await waitFor(() => {
      expect(document.querySelector('[data-slot="file-viewer-overlay"]')).toBeInTheDocument();
    });
    return document.querySelector('[data-slot="file-viewer-overlay"]');
  }

  it("routes pdf and other EuroOffice formats to the office editor", async () => {
    mockEuroOfficePresent();
    const { rerender } = render(
      <FileViewer open driveId="d1" path="docs/report.pdf" onClose={() => {}} />,
    );
    await findFullscreenOverlay();
    expect(screen.getByTestId("office-editor")).toBeInTheDocument();

    for (const path of [
      "docs/sheet.xlsm",
      "docs/deck.ppsx",
      "docs/diagram.vsdx",
      "docs/book.epub",
      "docs/scan.djvu",
    ]) {
      rerender(
        <FileViewer open driveId="d1" path={path} onClose={() => {}} />,
      );
      await findFullscreenOverlay();
      expect(screen.getByTestId("office-editor")).toBeInTheDocument();
    }
  });

  it("falls back to the browser pdf preview when EuroOffice is missing", async () => {
    const realCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock-pdf");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("/eurooffice/")) {
          return new Response("<!doctype html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        if (u.includes("/files/content")) {
          return new Response("%PDF-1.4 fake", { status: 200 });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    try {
      render(
        <FileViewer open driveId="d1" path="docs/report.pdf" onClose={() => {}} />,
      );
      expect(await screen.findByTitle("PDF preview")).toBeInTheDocument();
      expect(screen.queryByTestId("office-editor")).not.toBeInTheDocument();
      expect(screen.queryByText(/EuroOffice is not on this Luna/)).not.toBeInTheDocument();
    } finally {
      URL.createObjectURL = realCreateObjectURL;
    }
  });

  it("keeps office formats without a fallback viewer on the OfficeEditor missing state", async () => {
    // OfficeEditor is mocked — assert the phase prop it receives rather than
    // its internal "EuroOffice is not on this Luna" card.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<!doctype html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    );
    render(
      <FileViewer open driveId="d1" path="docs/scan.djvu" onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(officeMocks.editorProps.phase).toBe("missing");
    });
    expect(screen.getByTestId("office-editor")).toBeInTheDocument();
  });

  it("animates in once EuroOffice is ready and animates out before unmount", async () => {
    mockEuroOfficePresent();
    const onClose = vi.fn();
    const { rerender } = render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );

    const overlay = await findFullscreenOverlay();
    expect(overlay).toHaveClass("file-viewer-enter");
    expect(screen.getByTestId("office-editor")).toBeInTheDocument();

    // The close button asks the parent to close; unmount waits for the exit.
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <FileViewer open={false} driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );

    const closing = document.querySelector('[data-slot="file-viewer-overlay"]');
    expect(closing).toBeInTheDocument();
    expect(closing).toHaveClass("file-viewer-exit");

    await waitForExitAnimation();
    expect(document.querySelector('[data-slot="file-viewer-overlay"]')).not.toBeInTheDocument();
  });

  it("runs the exit animation when Escape closes the fullscreen editor", async () => {
    mockEuroOfficePresent();
    const onClose = vi.fn();
    const { rerender } = render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );

    await findFullscreenOverlay();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <FileViewer open={false} driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );

    expect(document.querySelector('[data-slot="file-viewer-overlay"]')).toHaveClass("file-viewer-exit");
    await waitForExitAnimation();
    expect(document.querySelector('[data-slot="file-viewer-overlay"]')).not.toBeInTheDocument();
  });

  it("offers a Save button in the rail that tracks editor save state", async () => {
    mockEuroOfficePresent();
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={() => {}} />,
    );
    await findFullscreenOverlay();

    // Nothing registered or dirty yet — Save stays disabled, no status text.
    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).toBeDisabled();
    expect(screen.queryAllByText(/Saved|Unsaved/)).toHaveLength(0);

    // The editor registers its save thunk once the writable session is up.
    const runSave = vi.fn(async () => {});
    act(() => officeMocks.editorProps.onRegisterSave(runSave));
    expect(saveBtn).toBeDisabled(); // still nothing to save

    // Unsaved edits (onDocumentStateChange data === true) enable Save; the
    // button inverts to bg-primary while dirty — the state reads on the
    // button itself, with the wording kept in its tooltip.
    act(() => officeMocks.editorProps.onSaveStateChange(true));
    expect(saveBtn).toBeEnabled();
    expect(saveBtn.className).toContain("bg-primary");
    saveBtn.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Unsaved changes");

    fireEvent.click(saveBtn);
    await waitFor(() => expect(runSave).toHaveBeenCalledTimes(1));

    // "All changes saved" (data === false) flips back to the muted ghost.
    act(() => officeMocks.editorProps.onSaveStateChange(false));
    expect(saveBtn).toBeDisabled();
    expect(saveBtn.className).toContain("bg-transparent");
  });

  it("keeps Save enabled after a failed save attempt so the user can retry", async () => {
    mockEuroOfficePresent();
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={() => {}} />,
    );
    await findFullscreenOverlay();

    const runSave = vi.fn(async () => {
      throw new Error("EuroOffice couldn't save this file.");
    });
    act(() => officeMocks.editorProps.onRegisterSave(runSave));
    act(() => officeMocks.editorProps.onSaveStateChange(true));

    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);
    await waitFor(() => expect(runSave).toHaveBeenCalledTimes(1));

    // The failure surfaces in the Save button's tooltip; the button stays
    // enabled (inverted) so the user can retry. (Hover, not focus — a click
    // suppresses the next focus-open by design in Tooltip.)
    fireEvent.pointerEnter(saveBtn);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "EuroOffice couldn't save this file.",
    );
    expect(saveBtn).toBeEnabled();
    expect(saveBtn.className).toContain("bg-primary");
  });

  it("hides the save control in view-only mode", async () => {
    mockEuroOfficePresent();
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={() => {}} canWrite={false} />,
    );
    await findFullscreenOverlay();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("closes straight away without the modal when there are no unsaved changes", async () => {
    mockEuroOfficePresent();
    const onClose = vi.fn();
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );
    await findFullscreenOverlay();

    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Document Unsaved")).not.toBeInTheDocument();
  });

  it("intercepts a dirty close with the modal; Cancel keeps editing", async () => {
    mockEuroOfficePresent();
    const onClose = vi.fn();
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );
    await findFullscreenOverlay();

    act(() => officeMocks.editorProps.onSaveStateChange(true));
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));

    expect(screen.getByText("Document Unsaved")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByText("Document Unsaved")).not.toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="file-viewer-overlay"]')).toBeInTheDocument();
  });

  it("closes via Close anyway without saving", async () => {
    mockEuroOfficePresent();
    const onClose = vi.fn();
    const runSave = vi.fn(async () => {});
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );
    await findFullscreenOverlay();

    act(() => officeMocks.editorProps.onRegisterSave(runSave));
    act(() => officeMocks.editorProps.onSaveStateChange(true));
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));

    fireEvent.click(screen.getByRole("button", { name: "Close anyway" }));
    expect(runSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("saves then closes via Save and close", async () => {
    mockEuroOfficePresent();
    const onClose = vi.fn();
    const runSave = vi.fn(async () => {});
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );
    await findFullscreenOverlay();

    act(() => officeMocks.editorProps.onRegisterSave(runSave));
    act(() => officeMocks.editorProps.onSaveStateChange(true));
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));

    fireEvent.click(screen.getByRole("button", { name: "Save and close" }));
    await waitFor(() => expect(runSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps the modal open and shows the error when Save and close fails", async () => {
    mockEuroOfficePresent();
    const onClose = vi.fn();
    const runSave = vi.fn(async () => {
      throw new Error("EuroOffice couldn't save this file.");
    });
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );
    await findFullscreenOverlay();

    act(() => officeMocks.editorProps.onRegisterSave(runSave));
    act(() => officeMocks.editorProps.onSaveStateChange(true));
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));

    fireEvent.click(screen.getByRole("button", { name: "Save and close" }));
    await waitFor(() => expect(runSave).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(screen.getAllByText("EuroOffice couldn't save this file.")).not.toHaveLength(0),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Document Unsaved")).toBeInTheDocument();
  });

  it("intercepts a dirty Escape with the modal, and modal Escape cancels", async () => {
    mockEuroOfficePresent();
    const onClose = vi.fn();
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );
    await findFullscreenOverlay();

    act(() => officeMocks.editorProps.onSaveStateChange(true));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.getByText("Document Unsaved")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // ModalCard listens on document; Escape there cancels the modal only.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByText("Document Unsaved")).not.toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("asks the browser to guard tab close only while unsaved", async () => {
    mockEuroOfficePresent();
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={() => {}} />,
    );
    await findFullscreenOverlay();

    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    act(() => officeMocks.editorProps.onSaveStateChange(true));
    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    act(() => officeMocks.editorProps.onSaveStateChange(false));
    const savedEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(savedEvent);
    expect(savedEvent.defaultPrevented).toBe(false);
  });

  it("lays out a book-spine rail on desktop with the filename, Save, and Close", async () => {
    mockEuroOfficePresent();
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={() => {}} />,
    );
    await findFullscreenOverlay();

    const rail = document.querySelector('[data-slot="office-rail"]');
    expect(rail).toBeInTheDocument();
    expect(within(/** @type {HTMLElement} */ (rail)).getByText("report.docx")).toBeInTheDocument();
    expect(within(/** @type {HTMLElement} */ (rail)).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(within(/** @type {HTMLElement} */ (rail)).getByRole("button", { name: "Close editor" })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="office-topbar"]')).not.toBeInTheDocument();
  });

  it("uses a compact bar plus an options menu on mobile viewports", async () => {
    // Same convention as UsersPage.test.jsx — matchMedia decides the chrome.
    vi.stubGlobal("matchMedia", (query) => ({
      matches: !String(query).includes("min-width: 768px"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    mockEuroOfficePresent();
    const onClose = vi.fn();
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );
    await findFullscreenOverlay();

    expect(document.querySelector('[data-slot="office-rail"]')).not.toBeInTheDocument();
    const topbar = document.querySelector('[data-slot="office-topbar"]');
    expect(topbar).toBeInTheDocument();
    expect(within(/** @type {HTMLElement} */ (topbar)).getByText("report.docx")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Editor options" }));
    const menu = await screen.findByRole("menu", { name: "Editor options" });

    // Save is present but disabled while there is nothing to save.
    expect(within(menu).getByRole("menuitem", { name: /^Save/ })).toBeDisabled();

    // Once the session registers its save thunk and reports unsaved edits,
    // Save is enabled and the item annotates the last-saved state.
    act(() => officeMocks.editorProps.onRegisterSave(vi.fn(async () => {})));
    act(() => officeMocks.editorProps.onSaveStateChange(true));
    expect(within(menu).getByRole("menuitem", { name: /^Save/ })).toBeEnabled();
    expect(within(menu).getByText("Unsaved changes")).toBeInTheDocument();

    // Close still funnels through the unsaved-changes guard.
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Close editor" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Document Unsaved")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close anyway" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the mobile menu on Escape without closing the editor", async () => {
    vi.stubGlobal("matchMedia", (query) => ({
      matches: !String(query).includes("min-width: 768px"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    mockEuroOfficePresent();
    const onClose = vi.fn();
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );
    await findFullscreenOverlay();

    fireEvent.click(screen.getByRole("button", { name: "Editor options" }));
    expect(await screen.findByRole("menu", { name: "Editor options" })).toBeInTheDocument();

    // The menu owns Escape while open; the editor stays mounted.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Editor options" })).not.toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="file-viewer-overlay"]')).toBeInTheDocument();
  });
});
