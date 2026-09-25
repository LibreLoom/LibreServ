import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
import FileViewer from "./FileViewer.jsx";
import { FileSourceProvider } from "../../lib/fileSource.jsx";

vi.mock("@libreloom/ui/context/ToastContext.jsx", () => ({
  ToastProvider: ({ children }) => children,
  useToast: () => ({
    toasts: [],
    addToast: vi.fn(),
    dismissToast: vi.fn(),
    pauseToast: vi.fn(),
    resumeToast: vi.fn(),
    clearToasts: vi.fn(),
  }),
}));

// EuroOfficeHost pulls in auth/theme contexts, sockets, and the DocsAPI
// script load; the fullscreen chrome tests only need to know the editor
// subtree exists. The mock also captures props so tests can drive the
// save-state callbacks and the missing-pack report the real host fires.
const officeMocks = vi.hoisted(() => ({
  editorProps: /** @type {Record<string, any>} */ ({}),
}));
vi.mock("./office/EuroOfficeHost.jsx", () => ({
  default: (props) => {
    officeMocks.editorProps = props;
    return <div data-testid="office-editor" />;
  },
}));

// FormBuilder owns react-query + fetch — the frame tests only need to know
// the form subtree mounted. The mock captures props like the office mock.
const formMocks = vi.hoisted(() => ({
  editorProps: /** @type {Record<string, any>} */ ({}),
}));
vi.mock("./forms/FormBuilder.jsx", () => ({
  default: (props) => {
    formMocks.editorProps = props;
    return <div data-testid="form-builder" />;
  },
}));

// DiagramEditor probes the pack, fetches the file, and owns the draw.io
// iframe handshake — the fullscreen chrome tests only need the subtree to
// mount. The mock captures props like the office mock does.
const diagramMocks = vi.hoisted(() => ({
  editorProps: /** @type {Record<string, any>} */ ({}),
}));
vi.mock("./diagram/DiagramEditor.jsx", () => ({
  default: (props) => {
    diagramMocks.editorProps = props;
    return <div data-testid="diagram-editor" />;
  },
}));

/** Fullscreen exit animation duration (file-viewer-out, 250ms) + slack. */
const EXIT_WAIT_MS = 300;

/** The mounted CodeMirror view — stashed on the editor host element. */
function cmView() {
  const host = document.querySelector("[data-slot$='-editor-surface']");
  if (!host) throw new Error("no editor surface mounted");
  return /** @type {any} */ (host).__cmView;
}

function cmText() {
  return cmView().state.doc.toString();
}

/** Replace the whole document through the real CM dispatch path. */
async function cmReplace(text) {
  await act(async () => {
    cmView().dispatch({
      changes: { from: 0, to: cmView().state.doc.length, insert: text },
    });
  });
}

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

describe("FileViewer text editor (fullscreen)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockTextFetch(body = "hello") {
    const fetchMock = vi.fn(async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || "GET").toUpperCase();
      if (u.includes("/files/content") && method === "GET") {
        return new Response(body, { status: 200, headers: { "Content-Type": "text/plain" } });
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
    return fetchMock;
  }

  it("opens a writable text file in the fullscreen editor, not the modal", async () => {
    mockTextFetch();
    render(
      <FileViewer open driveId="d1" path="notes/note.txt" onClose={() => {}} />,
    );

    await screen.findByLabelText("Contents of note.txt");
    expect(
      document.querySelector('[data-slot="file-viewer-overlay"]'),
    ).toBeInTheDocument();
    // The rail carries the editor chrome — no modal footer.
    expect(
      document.querySelector('[data-slot="editor-rail"]'),
    ).toBeInTheDocument();
  });

  it("saves an existing text file with overwrite=1", async () => {
    const fetchMock = mockTextFetch();

    render(
      <FileViewer
        open
        driveId="d1"
        path="notes/note.txt"
        onClose={() => {}}
      />,
    );

    await screen.findByLabelText("Contents of note.txt");
    await waitFor(() => expect(cmText()).toBe("hello"));

    // Save sits in the rail — disabled until the editor registers its
    // thunk and reports a dirty draft.
    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).toBeDisabled();

    await cmReplace("hello world");
    await waitFor(() => expect(saveBtn).toBeEnabled());
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const upload = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes("/files/upload") && (init?.method || "GET").toUpperCase() === "POST"
      );
      expect(upload).toBeTruthy();
      expect(String(upload[0])).toContain("overwrite=1");
    });

    await waitFor(() => expect(saveBtn).toBeDisabled());

    await cmReplace("hello world again");
    await waitFor(() => expect(saveBtn).toBeEnabled());
  });

  it("keeps Save disabled while the draft matches the file on Luna", async () => {
    mockTextFetch();

    render(
      <FileViewer
        open
        driveId="d1"
        path="notes/note.txt"
        onClose={() => {}}
      />,
    );

    await screen.findByLabelText("Contents of note.txt");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("autosaves once typing pauses, like the office editor", async () => {
    const fetchMock = mockTextFetch();

    render(
      <FileViewer
        open
        driveId="d1"
        path="notes/note.txt"
        onClose={() => {}}
      />,
    );

    await screen.findByLabelText("Contents of note.txt");
    await waitFor(() => expect(cmText()).toBe("hello"));
    const saveBtn = screen.getByRole("button", { name: "Save" });

    await act(async () => {
      cmView().dispatch({ changes: { from: 5, insert: " world" } });
    });

    // Under the idle threshold the tick notices the dirty doc but holds.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/files/upload")),
    ).toBe(false);

    // Past the ~2s idle pause the tick saves and the rail button goes clean.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1800));
    });
    const upload = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes("/files/upload") &&
      (init?.method || "GET").toUpperCase() === "POST",
    );
    expect(upload).toBeTruthy();
    await waitFor(() => expect(saveBtn).toBeDisabled());
  }, 10_000);

  it("guards a dirty close and saves before closing", async () => {
    const fetchMock = mockTextFetch();
    const onClose = vi.fn();

    render(
      <FileViewer
        open
        driveId="d1"
        path="notes/note.txt"
        onClose={onClose}
      />,
    );

    await screen.findByLabelText("Contents of note.txt");
    await cmReplace("changed");

    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(screen.getByText("Document Unsaved")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save and close" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url, init]) =>
          String(url).includes("/files/upload") &&
          (init?.method || "GET").toUpperCase() === "POST"),
      ).toBe(true);
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps a read-only text file in the preview modal", async () => {
    mockTextFetch();

    render(
      <FileViewer
        open
        driveId="d1"
        path="notes/note.txt"
        onClose={() => {}}
        canWrite={false}
      />,
    );

    const editor = await screen.findByLabelText("Contents of note.txt");
    expect(editor).toHaveAttribute("readonly");
    expect(
      document.querySelector('[data-slot="file-viewer-overlay"]'),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
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

  it("opens .md straight into the fullscreen editor with Write/Source/Read", async () => {
    mockMarkdownFetch();

    render(
      <FileViewer
        open
        driveId="d1"
        path="docs/roadmap.md"
        onClose={() => {}}
      />,
    );

    await screen.findByLabelText("Contents of roadmap.md");
    await waitFor(() =>
      expect(cmText()).toBe("# Title\n\nSome **bold** text"),
    );
    expect(
      document.querySelector('[data-slot="file-viewer-overlay"]'),
    ).toBeInTheDocument();
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Read" }));

    expect(screen.queryByLabelText("Contents of roadmap.md")).not.toBeInTheDocument();
    const preview = screen.getByLabelText("Preview of roadmap.md");
    expect(preview.querySelector("h1")).toHaveTextContent("Title");
    expect(preview.querySelector("strong")).toHaveTextContent("bold");

    fireEvent.click(screen.getByRole("radio", { name: "Write" }));
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

    await screen.findByLabelText("Contents of roadmap.md");
    const saveBtn = screen.getByRole("button", { name: "Save" });
    await cmReplace("# Updated");
    await waitFor(() => expect(saveBtn).toBeEnabled());
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const upload = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes("/files/upload") && (init?.method || "GET").toUpperCase() === "POST"
      );
      expect(upload).toBeTruthy();
      expect(String(upload[0])).toContain("overwrite=1");
    });
    await waitFor(() => expect(saveBtn).toBeDisabled());
  });

  it("keeps a read-only .md in the modal preview", async () => {
    mockMarkdownFetch();

    render(
      <FileViewer
        open
        driveId="d1"
        path="docs/roadmap.md"
        onClose={() => {}}
        canWrite={false}
      />,
    );

    // Read-only opens on the rendered preview; Source shows the raw text.
    const preview = await screen.findByLabelText("Preview of roadmap.md");
    expect(preview.querySelector("h1")).toHaveTextContent("Title");
    expect(
      document.querySelector('[data-slot="file-viewer-overlay"]'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    expect(screen.getByLabelText("Contents of roadmap.md")).toHaveTextContent(
      "# Title",
    );
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

    await screen.findByLabelText("Contents of roadmap.md");
    await waitFor(() =>
      expect(cmText()).toBe("# Title\n\nSome **bold** text"),
    );
    await act(async () => {
      cmView().dispatch({ selection: { anchor: 0 } });
    });
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(cmText()).toBe("- # Title\n\nSome **bold** text");
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

  /** Simulate the DocsAPI script failing to load — the missing pack. */
  function reportEuroOfficeMissing() {
    act(() => officeMocks.editorProps.onUnavailable());
  }

  async function findFullscreenOverlay() {
    await waitFor(() => {
      expect(document.querySelector('[data-slot="file-viewer-overlay"]')).toBeInTheDocument();
    });
    return document.querySelector('[data-slot="file-viewer-overlay"]');
  }

  it("routes the verified office formats to the fullscreen office editor", async () => {
    // View-only formats (xlsm, ppt) still open fullscreen — EuroOffice is
    // their only renderer; they just can't save.
    const { rerender } = render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={() => {}} />,
    );
    await findFullscreenOverlay();
    expect(screen.getByTestId("office-editor")).toBeInTheDocument();

    for (const path of [
      "docs/sheet.xlsm",
      "docs/deck.ppsx",
      "docs/form.docxf",
      "docs/legacy.xls",
      "docs/old.ppt",
    ]) {
      rerender(
        <FileViewer open driveId="d1" path={path} onClose={() => {}} />,
      );
      await findFullscreenOverlay();
      expect(screen.getByTestId("office-editor")).toBeInTheDocument();
    }
  });

  it("opens pdf in its own modal preview — never EuroOffice", async () => {
    // The bundled x2t can't read pdf at all (verified in
    // office/x2tFormats.test.js), so pdf routes to the built-in viewer in
    // the preview modal, pack or no pack.
    const realCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock-pdf");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
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
      expect(
        document.querySelector('[data-slot="file-viewer-overlay"]'),
      ).not.toBeInTheDocument();
    } finally {
      URL.createObjectURL = realCreateObjectURL;
    }
  });

  it("previews csv in the modal table viewer, not the office editor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("/files/content")) {
          return new Response("Name,Qty\nApples,4\nPears,2\n", { status: 200 });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    render(
      <FileViewer open driveId="d1" path="docs/budget.csv" onClose={() => {}} />,
    );
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Apples")).toBeInTheDocument();
    expect(screen.queryByTestId("office-editor")).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="file-viewer-overlay"]'),
    ).not.toBeInTheDocument();
  });

  it("opens nothing for formats with no implemented support", async () => {
    // No fullscreen overlay, no office editor, no fake preview pane — these
    // never reach FileViewer from the browser (openableKind returns null),
    // but a stale deep link must not mount the office editor either.
    for (const path of ["mesh.stl", "old.doc", "deck.key", "clip.mkv"]) {
      const { unmount } = render(
        <FileViewer open driveId="d1" path={`f/${path}`} onClose={() => {}} />,
      );
      await act(async () => {});
      expect(
        document.querySelector('[data-slot="file-viewer-overlay"]'),
        path,
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("office-editor"), path).not.toBeInTheDocument();
      unmount();
    }
  });

  it("shows the OfficeEditor missing card when the pack is absent", async () => {
    // EuroOfficeHost is mocked — the real OfficeEditor renders its own
    // "can't open office files" card when the host reports missing.
    render(
      <FileViewer open driveId="d1" path="docs/scan.xlsx" onClose={() => {}} />,
    );
    await findFullscreenOverlay();
    reportEuroOfficeMissing();
    expect(
      await screen.findByText(/can't open office files/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("office-editor")).not.toBeInTheDocument();
  });

  it("animates in on open and animates out before unmount", async () => {
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

  it("keeps the mounted editor and its real path through the exit animation", async () => {
    // Regression: the parent clears viewerPath on close, so `path` arrives
    // as "". The exiting overlay must keep the editor it was showing —
    // re-running on an empty path flashed a bogus "cannot open this file
    // type" card (or mounted a text editor on "") for the last 250ms.
    const onClose = vi.fn();
    const { rerender } = render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );
    await findFullscreenOverlay();
    expect(officeMocks.editorProps.path).toBe("docs/report.docx");

    rerender(<FileViewer open={false} driveId="d1" path="" onClose={onClose} />);

    expect(document.querySelector('[data-slot="file-viewer-overlay"]')).toHaveClass("file-viewer-exit");
    expect(screen.getByTestId("office-editor")).toBeInTheDocument();
    expect(officeMocks.editorProps.path).toBe("docs/report.docx");

    await waitForExitAnimation();
    expect(document.querySelector('[data-slot="file-viewer-overlay"]')).not.toBeInTheDocument();
  });

  it("offers a Save button in the rail that tracks editor save state", async () => {
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
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={() => {}} canWrite={false} />,
    );
    await findFullscreenOverlay();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("closes straight away without the modal when there are no unsaved changes", async () => {
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
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={() => {}} />,
    );
    await findFullscreenOverlay();

    const rail = document.querySelector('[data-slot="editor-rail"]');
    expect(rail).toBeInTheDocument();
    expect(within(/** @type {HTMLElement} */ (rail)).getByText("report.docx")).toBeInTheDocument();
    expect(within(/** @type {HTMLElement} */ (rail)).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(within(/** @type {HTMLElement} */ (rail)).getByRole("button", { name: "Close editor" })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="editor-topbar"]')).not.toBeInTheDocument();
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
    const onClose = vi.fn();
    render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={onClose} />,
    );
    await findFullscreenOverlay();

    expect(document.querySelector('[data-slot="editor-rail"]')).not.toBeInTheDocument();
    const topbar = document.querySelector('[data-slot="editor-topbar"]');
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

describe("FileViewer fullscreen diagram overlay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function findFullscreenOverlay() {
    await waitFor(() => {
      expect(document.querySelector('[data-slot="file-viewer-overlay"]')).toBeInTheDocument();
    });
    return document.querySelector('[data-slot="file-viewer-overlay"]');
  }

  it("opens .drawio files in the fullscreen diagram editor", async () => {
    const { rerender } = render(
      <FileViewer open driveId="d1" path="diagrams/flow.drawio" onClose={() => {}} />,
    );
    await findFullscreenOverlay();
    expect(screen.getByTestId("diagram-editor")).toBeInTheDocument();
    expect(diagramMocks.editorProps.path).toBe("diagrams/flow.drawio");

    // The embedded-preview variants are diagrams, not image previews.
    for (const path of ["diagrams/arch.drawio.svg", "diagrams/arch.drawio.png"]) {
      rerender(
        <FileViewer open driveId="d1" path={path} onClose={() => {}} />,
      );
      await findFullscreenOverlay();
      expect(screen.getByTestId("diagram-editor"), path).toBeInTheDocument();
      expect(diagramMocks.editorProps.path, path).toBe(path);
    }
  });

  it("still opens diagram files fullscreen without write permission", async () => {
    render(
      <FileViewer
        open
        driveId="d1"
        path="diagrams/flow.drawio"
        canWrite={false}
        onClose={() => {}}
      />,
    );
    await findFullscreenOverlay();
    expect(screen.getByTestId("diagram-editor")).toBeInTheDocument();
    expect(diagramMocks.editorProps.canWrite).toBe(false);
    // Read-only session: no Save affordance in the rail.
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("shows the same live presence line in the frame as EuroOffice", async () => {
    const { rerender } = render(
      <FileViewer open driveId="d1" path="docs/report.docx" onClose={() => {}} />,
    );
    await findFullscreenOverlay();
    act(() => officeMocks.editorProps.onPresenceChange("Live · Sam"));
    expect(document.querySelector('[data-slot="editor-presence"]')).toHaveTextContent(
      "Live · Sam",
    );

    rerender(
      <FileViewer open driveId="d1" path="diagrams/flow.drawio" onClose={() => {}} />,
    );
    await findFullscreenOverlay();
    // A different file starts with a blank presence line until its editor reports.
    expect(document.querySelector('[data-slot="editor-presence"]')).not.toBeInTheDocument();
    act(() => diagramMocks.editorProps.onPresenceChange("Opening this diagram…"));
    expect(document.querySelector('[data-slot="editor-presence"]')).toHaveTextContent(
      "Opening this diagram…",
    );
    act(() => diagramMocks.editorProps.onPresenceChange("Live · Sam"));
    expect(document.querySelector('[data-slot="editor-presence"]')).toHaveTextContent(
      "Live · Sam",
    );
  });
});

describe("FileViewer conversion hints", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubDriveFetch() {
    const calls = { uploads: /** @type {FormData[]} */ ([]) };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, options) => {
        const u = String(url);
        if (u.includes("/files/upload")) {
          calls.uploads.push(/** @type {FormData} */ (options?.body));
          return new Response("{}", { status: 200 });
        }
        if (u.includes("/files/content")) {
          return new Response("Name,Qty\nApples,4\nPears,2\n", { status: 200 });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    return calls;
  }

  it("shows the convert hint and converts csv → xlsx on click", async () => {
    const calls = stubDriveFetch();
    const onOpenPath = vi.fn();
    const onSaved = vi.fn();
    render(
      <FileViewer
        open
        driveId="d1"
        path="docs/budget.csv"
        onClose={() => {}}
        onSaved={onSaved}
        onOpenPath={onOpenPath}
      />,
    );

    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(
      screen.getByText(/converting it to a/i),
    ).toBeInTheDocument();
    expect(screen.getByText(".xlsx")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Convert & open/ }));
    await waitFor(() => expect(onOpenPath).toHaveBeenCalledWith("docs/budget.xlsx"));
    expect(onSaved).toHaveBeenCalled();
    expect(calls.uploads).toHaveLength(1);
    const uploaded = calls.uploads[0].get("file");
    expect(uploaded).toBeInstanceOf(File);
    expect(/** @type {File} */ (uploaded).name).toBe("budget.xlsx");
  });

  it("picks a free name when the converted copy already exists", async () => {
    // A taken name makes the upload answer 409 — the retry uses the next one.
    const onOpenPath = vi.fn();
    let uploadAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("/files/upload")) {
          uploadAttempts += 1;
          return uploadAttempts === 1
            ? new Response(
                JSON.stringify({ error: "A file with this name is already here." }),
                { status: 409 },
              )
            : new Response("{}", { status: 200 });
        }
        if (u.includes("/files/content")) {
          return new Response("a,b\n1,2\n", { status: 200 });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    render(
      <FileViewer
        open
        driveId="d1"
        path="docs/budget.csv"
        onClose={() => {}}
        onOpenPath={onOpenPath}
      />,
    );
    const button = await screen.findByRole("button", { name: /Convert & open/ });
    fireEvent.click(button);
    await waitFor(() =>
      expect(onOpenPath).toHaveBeenCalledWith("docs/budget (2).xlsx"),
    );
    expect(uploadAttempts).toBe(2);
  });

  it("surfaces the server's upload error instead of a dead-end message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("/files/upload")) {
          return new Response(
            JSON.stringify({ error: "This drive is full." }),
            { status: 507 },
          );
        }
        if (u.includes("/files/content")) {
          return new Response("a,b\n1,2\n", { status: 200 });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    render(
      <FileViewer open driveId="d1" path="docs/budget.csv" onClose={() => {}} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Convert & open/ }),
    );
    expect(await screen.findByText("This drive is full.")).toBeInTheDocument();
  });

  it("hints pdf → docx without a convert button", async () => {
    const realCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock-pdf");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
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
      expect(screen.getByText(/converting it to a/i)).toBeInTheDocument();
      expect(screen.getByText(".docx")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Convert & open/ }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Download/ })).toBeInTheDocument();
      // The corner X and the footer button both read "Close" — either works.
      expect(
        screen.getAllByRole("button", { name: "Close" }).length,
      ).toBeGreaterThan(0);
    } finally {
      URL.createObjectURL = realCreateObjectURL;
    }
  });

  it("shows the cannot-open card with a convert hint for office-adjacent types", async () => {
    render(
      <FileViewer open driveId="d1" path="docs/old.doc" onClose={() => {}} />,
    );
    expect(
      await screen.findByText(/cannot open this kind of file/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/converting it to a/i)).toBeInTheDocument();
    expect(screen.getByText(".docx")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Convert & open/ }),
    ).not.toBeInTheDocument();
  });

  it("hides the convert button without write access", async () => {
    stubDriveFetch();
    render(
      <FileViewer
        open
        driveId="d1"
        path="docs/budget.csv"
        onClose={() => {}}
        canWrite={false}
      />,
    );
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByText(/converting it to a/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Convert & open/ }),
    ).not.toBeInTheDocument();
  });
});

describe("FileViewer guest office bridge", () => {
  /** Minimal share-shaped source — the office path never calls its fetches. */
  function guestSource(overrides = {}) {
    return /** @type {any} */ ({
      kind: "share",
      guest: true,
      collab: false,
      token: "tok",
      isFile: true,
      fetch: vi.fn(async () => new Response("x")),
      contentHref: () => "/s/tok/file",
      downloadHref: () => "/s/tok/file?download=1",
      ...overrides,
    });
  }

  it("mounts the real office frame for a view-only link guest", async () => {
    render(
      <FileSourceProvider source={guestSource()}>
        <FileViewer
          open
          driveId="tok"
          path="Report.docx"
          canWrite={false}
          onClose={() => {}}
        />
      </FileSourceProvider>,
    );
    expect(await screen.findByTestId("office-editor")).toBeInTheDocument();
    expect(officeMocks.editorProps.canWrite).toBe(false);
  });

  it("mounts the real office frame for a full link guest with write", async () => {
    render(
      <FileSourceProvider source={guestSource()}>
        <FileViewer
          open
          driveId="tok"
          path="Report.docx"
          canWrite
          onClose={() => {}}
        />
      </FileSourceProvider>,
    );
    expect(await screen.findByTestId("office-editor")).toBeInTheDocument();
    expect(officeMocks.editorProps.canWrite).toBe(true);
  });
});

describe("FileViewer form overlay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function findFullscreenOverlay() {
    await waitFor(() => {
      expect(document.querySelector('[data-slot="file-viewer-overlay"]')).toBeInTheDocument();
    });
  }

  it("mounts the form builder fullscreen for members, write or read-only", async () => {
    const { rerender } = render(
      <FileViewer open driveId="d1" path="forms/rsvp.lunaform" onClose={() => {}} />,
    );
    await findFullscreenOverlay();
    expect(screen.getByTestId("form-builder")).toBeInTheDocument();
    expect(formMocks.editorProps.canWrite).toBe(true);

    rerender(
      <FileViewer
        open
        driveId="d1"
        path="forms/rsvp.lunaform"
        canWrite={false}
        onClose={() => {}}
      />,
    );
    await findFullscreenOverlay();
    expect(screen.getByTestId("form-builder")).toBeInTheDocument();
    expect(formMocks.editorProps.canWrite).toBe(false);
  });

  it("mounts the form builder for a view link guest", async () => {
    const source = {
      kind: "share",
      guest: true,
      collab: false,
      token: "tok",
      isFile: true,
      capsBits: 1,
      fetch: vi.fn(async () => new Response("x")),
      contentHref: () => "/s/tok/file",
      downloadHref: () => "/s/tok/file?download=1",
    };
    render(
      <FileSourceProvider source={/** @type {any} */ (source)}>
        <FileViewer
          open
          driveId="tok"
          path="rsvp.lunaform"
          canWrite={false}
          onClose={() => {}}
        />
      </FileSourceProvider>,
    );
    await findFullscreenOverlay();
    expect(screen.getByTestId("form-builder")).toBeInTheDocument();
    expect(formMocks.editorProps.canWrite).toBe(false);
  });

  it("mounts the diagram frame for a view link guest", async () => {
    const source = {
      kind: "share",
      guest: true,
      collab: false,
      token: "tok",
      isFile: true,
      capsBits: 1,
      fetch: vi.fn(async () => new Response("x")),
      contentHref: () => "/s/tok/file",
      downloadHref: () => "/s/tok/file?download=1",
    };
    render(
      <FileSourceProvider source={/** @type {any} */ (source)}>
        <FileViewer
          open
          driveId="tok"
          path="flow.drawio"
          canWrite={false}
          onClose={() => {}}
        />
      </FileSourceProvider>,
    );
    await findFullscreenOverlay();
    expect(screen.getByTestId("diagram-editor")).toBeInTheDocument();
    expect(diagramMocks.editorProps.canWrite).toBe(false);
  });
});
