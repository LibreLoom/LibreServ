import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import PublicSharePage from "./PublicSharePage";

// Chunked uploads go through XHR (`putBinaryProgress`), which jsdom can't
// reach a server with; resolve it like a complete chunk would.
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal()),
  putBinaryProgress: vi.fn(async (_path, _body) => ({ received: 3 })),
}));

// EuroOfficeHost owns the DocsAPI script load + x2t worker — outside jsdom's
// reach. Stub it so a docx link can prove it mounts the editor frame.
vi.mock("../components/files/office/EuroOfficeHost.jsx", () => ({
  default: () => <div data-testid="office-editor" />,
}));

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Meta for `/s/{token}` then entries for `/s/{token}/list`. */
function folderMock({ caps = "view", entries = [] } = {}) {
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/list")) {
      return json({ entries });
    }
    return json({ kind: "folder", name: "photos", caps });
  });
}

/** @param {{ client?: QueryClient }} [opts] */
function renderPage({ client } = {}) {
  const qc = client || new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ToastProvider>
      <Toaster />
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/s/abc"]}>
          <Routes>
            <Route path="/s/:token" element={<PublicSharePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ToastProvider>,
  );
}

function NavButtons() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/s/def")}>switch link</button>
      <button onClick={() => navigate("/s/abc?file=report.pdf")}>open file deep link</button>
    </>
  );
}

/** @param {{ client?: QueryClient }} [opts] */
function renderWithNav({ client } = {}) {
  const qc = client || new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ToastProvider>
      <Toaster />
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/s/abc"]}>
          <Routes>
            <Route
              path="/s/:token"
              element={<><PublicSharePage /><NavButtons /></>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ToastProvider>,
  );
}

describe("PublicSharePage", () => {
  it("asks for the link password in plain language", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(
      { error: "This link needs its password." },
      401,
    )));
    renderPage();
    expect(await screen.findByText(/This link is locked/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Password for this link/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Open$/i })).toBeInTheDocument();
  });

  it("lists a shared folder and offers downloads", async () => {
    vi.stubGlobal("fetch", folderMock({
      entries: [
        { name: "beach.jpg", kind: "file", size: 12, hidden: false },
        { name: "album", kind: "dir", size: 0, hidden: false },
      ],
    }));
    renderPage();
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.getByText("album")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download beach\.jpg/i })).toHaveAttribute(
      "href",
      "/s/abc/file?path=beach.jpg&download=1",
    );
  });

  it("sends the link password in a header, not the URL", async () => {
    const fetchMock = vi.fn(async (url, options = {}) => {
      const headers = options.headers || {};
      if (headers["X-Share-Password"] === "secret") {
        if (String(url).includes("/list")) return json({ entries: [] });
        return json({ kind: "folder", name: "photos", caps: "view" });
      }
      return json({ error: "This link needs its password." }, 401);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    expect(await screen.findByText(/This link is locked/i)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Password for this link/i), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Open$/i }));
    await waitFor(() => {
      const withHeader = fetchMock.mock.calls.filter(
        ([, opts]) => opts?.headers?.["X-Share-Password"] === "secret",
      );
      expect(withHeader.length).toBeGreaterThan(0);
      expect(withHeader.every(([url]) => !String(url).includes("password="))).toBe(true);
    });
  });

  it("opens the real viewer on a file link, with upload-to-replace on full access", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/list")) {
        return json({ entries: [{ name: "report.pdf", kind: "file", size: 1024, hidden: false }] });
      }
      return json({ kind: "file", caps: "full", name: "report.pdf", size: 1024 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    // The file opens in the same viewer the drive UI uses — not a card.
    expect((await screen.findAllByText("report.pdf")).length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("meta=1"))).toBe(true);
    expect(screen.getByRole("dialog", { name: /report\.pdf/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Download$/i }))
      .toHaveAttribute("href", "/s/abc/file?download=1");
    // Upload on a file link replaces the shared file server-side.
    expect(screen.getByRole("button", { name: /^Upload$/i })).toBeInTheDocument();
  });

  it("view-only file links open read-only — no upload affordance", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/list")) {
        return json({ entries: [{ name: "report.pdf", kind: "file", size: 1024, hidden: false }] });
      }
      return json({ kind: "file", caps: "view", name: "report.pdf", size: 1024 });
    }));
    renderPage();
    expect(await screen.findByRole("dialog", { name: /report\.pdf/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Upload$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Download$/i }))
      .toHaveAttribute("href", "/s/abc/file?download=1");
  });

  it("renders an upload-only drop box as a bare upload surface", async () => {
    const calls = /** @type {string[]} */ ([]);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      return json({ kind: "dropbox", caps: "upload", name: "Uploads" });
    }));
    renderPage();
    expect(await screen.findByText("Upload files")).toBeInTheDocument();
    expect(screen.getByText(/Choose files or drop them here/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Add files")).toBeInTheDocument();
    // No explorer affordances: nothing to list, sort, create, or download.
    expect(screen.queryByRole("button", { name: /^New$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Download/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Find in this folder")).not.toBeInTheDocument();
    // View-blind links never even ask for a listing.
    expect(calls.every((u) => !u.includes("/list"))).toBe(true);
  });

  it("shows upload and New controls on view+upload folder links", async () => {
    vi.stubGlobal("fetch", folderMock({
      caps: "view+upload",
      entries: [{ name: "beach.jpg", kind: "file", size: 12, hidden: false }],
    }));
    renderPage();
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New/i })).toBeInTheDocument();
  });

  it("hides upload controls on view-only folder links", async () => {
    vi.stubGlobal("fetch", folderMock({
      caps: "view",
      entries: [{ name: "beach.jpg", kind: "file", size: 12, hidden: false }],
    }));
    renderPage();
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upload/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New/i })).not.toBeInTheDocument();
  });

  it("shows rename and trash on a full-access folder link", async () => {
    vi.stubGlobal("fetch", folderMock({
      caps: "full",
      entries: [{ name: "beach.jpg", kind: "file", size: 12, hidden: false }],
    }));
    renderPage();
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Rename beach\.jpg/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Move beach\.jpg to trash/i })).toBeInTheDocument();
  });

  it("renames through the link, never the drive API", async () => {
    const calls = /** @type {any[]} */ ([]);
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push([String(url), (init.method || "GET").toUpperCase()]);
      const u = String(url);
      if (u.includes("/list")) {
        return json({ entries: [{ name: "beach.jpg", kind: "file", size: 12, hidden: false }] });
      }
      if (u.endsWith("/rename")) return json({ ok: true });
      return json({ kind: "folder", name: "photos", caps: "full" });
    }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Rename beach\.jpg/i }));
    const input = await screen.findByDisplayValue("beach.jpg");
    fireEvent.change(input, { target: { value: "coast.jpg" } });
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/i }));
    await waitFor(() => {
      expect(calls.some(([url, method]) =>
        url === "/s/abc/rename" && method === "POST")).toBe(true);
    });
    expect(calls.every(([url]) => !url.includes("/api/v1/drives/"))).toBe(true);
  });

  it("view-only folder links hide edit affordances", async () => {
    vi.stubGlobal("fetch", folderMock({
      caps: "view",
      entries: [{ name: "beach.jpg", kind: "file", size: 12, hidden: false }],
    }));
    renderPage();
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Rename beach\.jpg/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move beach\.jpg to trash/i })).not.toBeInTheDocument();
  });

  it("reloads the folder listing after an upload lands", async () => {
    let listCalls = 0;
    const fetchMock = vi.fn(async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || "GET").toUpperCase();
      if (u.includes("/list")) {
        listCalls += 1;
        return json({
          entries: listCalls === 1
            ? []
            : [{ name: "new.txt", kind: "file", size: 3, hidden: false }],
        });
      }
      if (u.endsWith("/upload") && method === "POST") {
        return json({ upload_id: "u1", received: 0, size: 3 });
      }
      if (u.includes("/complete") && method === "POST") {
        return json({ name: "new.txt", kind: "file", size: 3 });
      }
      return json({ kind: "folder", name: "photos", caps: "view+upload" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderPage();
    expect(await screen.findByText(/This folder is empty/i)).toBeInTheDocument();

    const picker = container.querySelector('input[type="file"]');
    expect(picker).not.toBeNull();
    fireEvent.change(/** @type {HTMLInputElement} */ (picker), {
      target: { files: [new File(["abc"], "new.txt", { type: "text/plain" })] },
    });

    // The freshly uploaded file appears in the listing without a page refresh.
    expect(await screen.findByRole("link", { name: /Download new\.txt/i })).toBeInTheDocument();
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  });

  it("keeps the same browser mounted while a subfolder listing loads", async () => {
    let releaseSub = /** @type {() => void} */ (() => {});
    const gate = new Promise((r) => { releaseSub = () => r(); });
    const metaCalls = /** @type {string[]} */ ([]);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("meta=1")) {
        metaCalls.push(u);
        return json({ kind: "folder", name: "photos", caps: "view" });
      }
      if (u.includes("/list")) {
        const p = new URL(u, "http://luna.test").searchParams.get("path") || "";
        if (p === "album") await gate;
        return json({
          entries: p === ""
            ? [{ name: "album", kind: "dir", size: 0, modified: 0, hidden: false }]
            : [{ name: "inside.txt", kind: "file", size: 1, modified: 0, hidden: false }],
        });
      }
      return json({});
    }));
    renderPage();
    await screen.findByText("album");
    const filter = screen.getByLabelText("Find in this folder");
    fireEvent.click(screen.getByRole("link", { name: "album" }));
    // Navigating deeper must not remount the explorer: the filter element
    // is the same DOM node and the previous listing stays visible.
    expect(screen.getByLabelText("Find in this folder")).toBe(filter);
    expect(screen.getAllByText("album").length).toBeGreaterThan(0);
    // Metadata is fetched once, for the link root only.
    expect(metaCalls).toHaveLength(1);
    expect(metaCalls.every((u) => !u.includes("path="))).toBe(true);
    releaseSub();
    expect(await screen.findByText("inside.txt")).toBeInTheDocument();
    expect(screen.getByLabelText("Find in this folder")).toBe(filter);
  });

  it("opens, closes, and reopens a file link viewer via row and deep link", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("meta=1")) {
        return json({ kind: "file", name: "report.pdf", caps: "view" });
      }
      if (u.includes("/list")) {
        return json({ entries: [
          { name: "report.pdf", kind: "file", size: 42, modified: 0, hidden: false },
        ] });
      }
      if (u.includes("/file")) return new Response("%PDF", { status: 200 });
      return json({});
    }));
    renderWithNav();
    const dialogName = { name: /report\.pdf/i };
    const closeViewer = () => {
      const buttons = screen.getAllByRole("button", { name: "Close" });
      fireEvent.click(buttons[buttons.length - 1]);
    };
    const fileRowLink = () =>
      screen.getAllByRole("link", { name: "report.pdf" })
        .find((a) => a.getAttribute("href")?.includes("file="));
    expect(await screen.findByRole("dialog", dialogName)).toBeInTheDocument();

    closeViewer();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", dialogName)).not.toBeInTheDocument());

    fireEvent.click(fileRowLink());
    expect(await screen.findByRole("dialog", dialogName)).toBeInTheDocument();

    closeViewer();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", dialogName)).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "open file deep link" }));
    expect(await screen.findByRole("dialog", dialogName)).toBeInTheDocument();
  });

  it("resets the whole session when the link token changes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/s/abc") && u.includes("meta=1")) {
        return json({ kind: "folder", name: "old link", caps: "view" });
      }
      if (u.includes("/s/abc") && u.includes("/list")) {
        return json({ entries: [
          { name: "old.txt", kind: "file", size: 1, modified: 0, hidden: false },
        ] });
      }
      if (u.includes("/s/def") && u.includes("meta=1")) {
        return json({ kind: "folder", name: "new link", caps: "view" });
      }
      if (u.includes("/s/def") && u.includes("/list")) {
        return json({ entries: [
          { name: "fresh.txt", kind: "file", size: 1, modified: 0, hidden: false },
        ] });
      }
      return json({});
    }));
    renderWithNav();
    expect(await screen.findByText("old.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "switch link" }));
    expect(await screen.findByText("fresh.txt")).toBeInTheDocument();
    expect(screen.queryByText("old.txt")).not.toBeInTheDocument();
  });

  it("does not leak the previous token's password when switching links", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes("/s/abc") && u.includes("meta=1")) {
        const pwd = init?.headers?.["X-Share-Password"] || "";
        if (!pwd) {
          return new Response(JSON.stringify({ password_required: true, kind: "folder", name: "old link" }), {
            status: 401, headers: { "Content-Type": "application/json" },
          });
        }
        return json({ kind: "folder", name: "old link", caps: "view" });
      }
      if (u.includes("/s/abc") && u.includes("/list")) {
        return json({ entries: [] });
      }
      if (u.includes("/s/def") && u.includes("meta=1")) {
        return json({ kind: "folder", name: "new link", caps: "view" });
      }
      if (u.includes("/s/def") && u.includes("/list")) {
        return json({ entries: [
          { name: "fresh.txt", kind: "file", size: 1, modified: 0, hidden: false },
        ] });
      }
      return json({});
    }));
    renderWithNav();
    expect(await screen.findByText("This link is locked")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Password for this link"), {
      target: { value: "CorrectHorse1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findAllByText("old link");

    fireEvent.click(screen.getByRole("button", { name: "switch link" }));
    // The new session starts clean: no carried-over password state and no
    // stale rows from the previous link.
    expect(await screen.findByText("fresh.txt")).toBeInTheDocument();
    expect(screen.queryByText("This link is locked")).not.toBeInTheDocument();
  });

  it("retries the meta request when the same password is submitted again", async () => {
    let metaCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes("meta=1")) {
        metaCalls += 1;
        const pwd = init?.headers?.["X-Share-Password"] || "";
        // First authenticated attempt fails transiently, retry succeeds.
        if (pwd && metaCalls > 2) {
          return json({ kind: "folder", name: "photos", caps: "view" });
        }
        return new Response(JSON.stringify({ password_required: true, kind: "folder" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/list")) return json({ entries: [] });
      return json({});
    }));
    renderPage();
    expect(await screen.findByText("This link is locked")).toBeInTheDocument();
    const input = screen.getByLabelText("Password for this link");
    fireEvent.change(input, { target: { value: "CorrectHorse1" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("That password is wrong. Try again.")).toBeInTheDocument();
    const callsAfterFirst = metaCalls;

    // Same password submitted again still re-requests the link.
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findAllByText("photos");
    expect(metaCalls).toBeGreaterThan(callsAfterFirst);
  });

  it("shows no New menu on a full file link and rejects multi-file drops", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("meta=1")) {
        return json({ kind: "file", name: "report.pdf", caps: "full" });
      }
      if (u.includes("/list")) {
        return json({ entries: [
          { name: "report.pdf", kind: "file", size: 42, modified: 0, hidden: false },
        ] });
      }
      return json({});
    }));
    renderPage();
    await screen.findAllByText("report.pdf");
    expect(screen.queryByRole("button", { name: /^New$/i })).not.toBeInTheDocument();
    // No folder-ZIP breadcrumb affordance for a single-file link.
    expect(screen.queryByRole("link", { name: /Download folder/i })).not.toBeInTheDocument();

    const picker = document.querySelector('[data-slot="file-browser"] input[type="file"]');
    expect(picker).toBeTruthy();
    fireEvent.change(/** @type {HTMLInputElement} */ (picker), {
      target: { files: [new File(["1"], "a.txt"), new File(["2"], "b.txt")] },
    });
    expect(await screen.findByText("Choose one file to replace this file.")).toBeInTheDocument();
  });

  it("scopes the guest move picker to the shared drive and invalidates its listing on mkdir", async () => {
    const listCalls = /** @type {string[]} */ ([]);
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (u.includes("meta=1")) {
        return json({ kind: "folder", name: "photos", caps: "full" });
      }
      if (u.includes("/list")) {
        listCalls.push(u);
        const p = new URL(u, "http://luna.test").searchParams.get("path") || "";
        return json({ entries: p === "" ? [
          { name: "trip", kind: "dir", size: 0, modified: 0, hidden: false },
        ] : [] });
      }
      if (u.includes("/mkdir") && method === "POST") return json({ ok: true });
      if (u.includes("/move") && method === "POST") return json({ ok: true });
      return json({});
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Simulate an authenticated ['drives'] cache left behind in the tab.
    client.setQueryData(["drives"], [
      { id: "real1", label: "Secret Internal Drive", state: "as_is" },
    ]);
    renderPage({ client });
    await screen.findByText("trip");
    fireEvent.click(screen.getByRole("button", { name: "Move trip" }));
    const picker = await screen.findByRole("dialog");
    // The guest picker is scoped to the shared drive — never to any
    // signed-in drives that happen to be cached in this tab.
    expect(within(picker).queryByText("Secret Internal Drive")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(picker).getAllByText("photos").length).toBeGreaterThan(0));

    const listCountBefore = listCalls.length;
    fireEvent.click(within(picker).getByRole("button", { name: "New folder" }));
    const dialogs = await screen.findAllByRole("dialog");
    const createDialog = dialogs[dialogs.length - 1];
    fireEvent.change(within(createDialog).getByRole("textbox"), {
      target: { value: "fresh-folder" },
    });
    fireEvent.click(within(createDialog).getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(listCalls.length).toBeGreaterThan(listCountBefore));
  });

  it("opens a docx file link in the office editor, not an empty download modal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("meta=1")) {
        return json({ kind: "file", name: "Report.docx", caps: "view", size: 10 });
      }
      return json({});
    }));
    renderPage();
    // The shared file opens straight into the fullscreen EuroOffice frame —
    // a docx must not fall back to a bare download card.
    expect(await screen.findByTestId("office-editor")).toBeInTheDocument();
  });

  it("opens a .lunaform view link in the form builder and shows its answers", async () => {
    const FORM_DOC = JSON.stringify({
      version: 1,
      title: "Family reunion RSVP",
      settings: { collecting: true },
      questions: [
        { v: 1, id: "q_1", type: "short_text", label: "Your name?", required: true, config: {} },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("meta=1")) {
        return json({ kind: "file", name: "rsvp.lunaform", caps: "view", size: 10 });
      }
      if (u.startsWith("/s/abc/responses")) {
        return json({ responses: [{ id: "r1", answers: { q_1: "Ann" } }] });
      }
      if (u.startsWith("/s/abc/file")) {
        return new Response(FORM_DOC, { status: 200 });
      }
      return json({});
    }));
    renderPage();
    // The shared form mounts the same fullscreen builder a member gets —
    // read-only fields, real questions, no share affordance for a guest.
    const title = await screen.findByLabelText("Form title");
    expect(title).toHaveValue("Family reunion RSVP");
    expect(title).toBeDisabled();
    expect(screen.getByDisplayValue("Your name?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share this form" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Responses/ }));
    expect((await screen.findAllByText("Ann")).length).toBeGreaterThan(0);
  });
});

