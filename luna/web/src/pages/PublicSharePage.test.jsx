import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import PublicSharePage from "./PublicSharePage";

// Chunked uploads go through XHR (`putBinaryProgress`), which jsdom can't
// reach a server with; resolve it like a complete chunk would.
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal()),
  putBinaryProgress: vi.fn(async (_path, _body) => ({ received: 3 })),
}));

describe("PublicSharePage", () => {
  it("asks for the link password in plain language", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "This link needs its password." }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    )));
    render(
      <MemoryRouter initialEntries={["/s/abc"]}>
        <Routes>
          <Route path="/s/:token" element={<PublicSharePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/This link is locked/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Password for this link/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Open$/i })).toBeInTheDocument();
  });

  it("lists a shared folder and offers downloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        kind: "folder",
        path: "photos",
        entries: [
          { name: "beach.jpg", kind: "file", size: 12, hidden: false },
          { name: "album", kind: "dir", size: 0, hidden: false },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    render(
      <MemoryRouter initialEntries={["/s/abc"]}>
        <Routes>
          <Route path="/s/:token" element={<PublicSharePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.getByText("album")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download/i })).toHaveAttribute(
      "href",
      "/s/abc?path=beach.jpg&download=1",
    );
  });

  it("sends the share password in a header, not the listing URL", async () => {
    const fetchMock = vi.fn(async (url, options = {}) => {
      const headers = options.headers || {};
      if (headers["X-Share-Password"] === "secret") {
        return new Response(
          JSON.stringify({ kind: "folder", path: "", entries: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: "This link needs its password." }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/s/abc"]}>
        <Routes>
          <Route path="/s/:token" element={<PublicSharePage />} />
        </Routes>
      </MemoryRouter>,
    );
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

  it("asks for share metadata so file links can offer Replace", async () => {
    const fetchMock = vi.fn(async (_url) => new Response(
      JSON.stringify({
        kind: "file",
        permission: "write",
        name: "report.pdf",
        path: "docs/report.pdf",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/s/abc"]}>
        <Routes>
          <Route path="/s/:token" element={<PublicSharePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/A file was shared with you/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("meta=1"))).toBe(true);
    expect(screen.getByRole("button", { name: /Replace file/i })).toBeInTheDocument();
  });

  it("renders an upload-only drop box with no listing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        kind: "upload",
        permission: "upload",
        path: "dropbox",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    render(
      <MemoryRouter initialEntries={["/s/abc"]}>
        <Routes>
          <Route path="/s/:token" element={<PublicSharePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Add files")).toBeInTheDocument();
    expect(screen.queryByText(/Download/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Add files")).toBeInTheDocument();
  });

  it("shows an upload zone on read-write folder links", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        kind: "folder",
        permission: "write",
        path: "photos",
        entries: [{ name: "beach.jpg", kind: "file", size: 12, hidden: false }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    render(
      <MemoryRouter initialEntries={["/s/abc"]}>
        <Routes>
          <Route path="/s/:token" element={<PublicSharePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.getByText(/Add files to this folder/i)).toBeInTheDocument();
  });

  it("reloads the folder listing after a read-write upload lands", async () => {
    let listingCalls = 0;
    const fetchMock = vi.fn(async (url, init = {}) => {
      const method = (init.method || "GET").toUpperCase();
      if (method === "GET") {
        listingCalls += 1;
        if (listingCalls === 1) {
          return new Response(
            JSON.stringify({ kind: "folder", permission: "write", path: "photos", entries: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            kind: "folder",
            permission: "write",
            path: "photos",
            entries: [{ name: "new.txt", kind: "file", size: 3, hidden: false }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (String(url).endsWith("/upload") && method === "POST") {
        return new Response(
          JSON.stringify({ upload_id: "u1", received: 0, size: 3 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (String(url).includes("/complete") && method === "POST") {
        return new Response(
          JSON.stringify({ name: "new.txt", kind: "file", size: 3 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/s/abc"]}>
        <Routes>
          <Route path="/s/:token" element={<PublicSharePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Add files to this folder/i)).toBeInTheDocument();
    expect(await screen.findByText(/This folder is empty/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Add files"), {
      target: { files: [new File(["abc"], "new.txt", { type: "text/plain" })] },
    });

    // The freshly uploaded file appears in the listing without a page refresh.
    expect(await screen.findByRole("link", { name: /Download/i })).toBeInTheDocument();
    await waitFor(() => expect(listingCalls).toBeGreaterThanOrEqual(2));
  });
});
