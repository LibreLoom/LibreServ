import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@libreloom/ui/context/ThemeContext.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { AuthProvider } from "../../context/AuthContext";
import { FileOpsProvider } from "../../context/FileOpsContext.jsx";
import DriveFileExplorer from "./DriveFileExplorer.jsx";
import FileOpsDock from "./fileOps/FileOpsDock.jsx";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/** An XHR that answers every upload with success, so only the name check can park a file. */
function stubXhr() {
  class FakeXhr {
    constructor() {
      /** @type {any} */
      this.onload = null;
      this.upload = {};
      this.status = 200;
      this.responseText = "{}";
    }
    open() {}
    setRequestHeader() {}
    send() {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
}

function renderExplorer() {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith("/api/v1/auth/me")) return json({ id: "u1", username: "max", role: "admin" });
    if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: true });
    if (u.endsWith("/api/v1/setup")) return json({ setup_completed: true });
    if (u.endsWith("/api/v1/drives")) return json([{ id: "d1", label: "Photos", state: "mounted" }]);
    if (u.endsWith("/api/v1/connect/status")) return json({ connect_active: true });
    if (u.includes("/api/v1/drives/d1/files?path=Trip")) {
      return json([{ name: "a.txt", kind: "file", size: 1, hidden: false }]);
    }
    if (u.includes("/api/v1/drives/d1/files?path=")) {
      return json([{ name: "Trip", kind: "dir", size: 0, hidden: false }]);
    }
    return json([]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider>
      <ToastProvider>
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <FileOpsProvider>
              <AuthProvider>
                <DriveFileExplorer driveId="d1" driveLabel="Photos" isAdmin />
                <FileOpsDock />
              </AuthProvider>
            </FileOpsProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe("DriveFileExplorer uploads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (/** @type {any} */ (HTMLInputElement.prototype)).webkitdirectory;
  });

  it("shows a decision row for a clash in a picked folder while the other file goes through", async () => {
    Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", { configurable: true, writable: true, value: false });
    stubXhr();
    renderExplorer();
    const input = await screen.findByLabelText("Add a folder");
    const inFolder = (name) => {
      const f = new File(["x"], name);
      Object.defineProperty(f, "webkitRelativePath", { value: `Trip/${name}` });
      return f;
    };
    fireEvent.change(input, { target: { files: [inFolder("a.txt"), inFolder("b.txt")] } });

    const dock = await screen.findByRole("region", { name: "File tasks" });
    expect(await within(dock).findByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(within(dock).getByRole("button", { name: "Keep both" })).toBeInTheDocument();
    expect(within(dock).getByRole("button", { name: "Skip" })).toBeInTheDocument();
    // The clash is not an error toast and not a page notice.
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
