import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import FileViewer from "./FileViewer.jsx";

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

  it("toggles full view and back", async () => {
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
    expect(screen.getByRole("button", { name: "Normal size" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Normal size" }));
    expect(screen.getByRole("button", { name: "Full view" })).toBeInTheDocument();
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

    expect(screen.getByText(/Could not load this photo/i)).toBeInTheDocument();
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
  });
});
