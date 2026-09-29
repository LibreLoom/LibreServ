import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import SharedFoldersPage from "./SharedFoldersPage";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

function stub({ role = "user", access = [], drives = [] } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith("/auth/me")) return json({ id: "2", role, username: "sam" });
    if (u.endsWith("/setup")) return json({ setup_completed: true });
    if (u.endsWith("/me/access")) return json(access);
    if (u.endsWith("/api/v1/drives")) return json(drives);
    return json([]);
  }));
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ToastProvider>
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <SharedFoldersPage />
          </AuthProvider>
        </QueryClientProvider>
      </MemoryRouter>
    </ToastProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("SharedFoldersPage", () => {
  it("shows a member the highest shared folder plus a write exception, without their home", async () => {
    stub({
      access: [
        { id: "home", kind: "path", drive_id: "d1", drive_label: "Photos Drive", path: ".luna-x-members/sam", caps: "full", is_home: true },
        { id: "g-drive", kind: "path", drive_id: "d1", drive_label: "Photos Drive", path: "", caps: "view" },
        { id: "g-dcim", kind: "path", drive_id: "d1", drive_label: "Photos Drive", path: "DCIM", caps: "full" },
        { id: "g-print", kind: "path", drive_id: "d1", drive_label: "Photos Drive", path: "DCIM/print", caps: "view" },
      ],
    });
    renderPage();
    expect(await screen.findByText(/^Whole drive$/)).toBeInTheDocument();
    expect(screen.getByText(/^Photos Drive · DCIM$/)).toBeInTheDocument();
    expect(screen.queryByText(/DCIM\/print/)).not.toBeInTheDocument();
    expect(screen.queryByText(/members/)).not.toBeInTheDocument();
    const opens = screen.getAllByRole("link", { name: "Browse files" });
    expect(opens).toHaveLength(2);
    expect(opens[0]).toHaveAttribute("href", "/drives/d1");
    expect(opens[1]).toHaveAttribute("href", "/drives/d1?path=DCIM");
  });

  it("opens a single-file share at the file, not its folder", async () => {
    stub({
      access: [
        { id: "g-file", kind: "path", drive_id: "d1", drive_label: "Photos Drive",
          path: "docs/report.pdf", name: "report.pdf", is_file: true, caps: "view" },
      ],
    });
    renderPage();
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" }))
      .toHaveAttribute("href", "/drives/d1?path=docs%2Freport.pdf");
  });

  it("tells a member plainly when nothing is shared", async () => {
    stub();
    renderPage();
    expect(await screen.findByText("No shared folders yet")).toBeInTheDocument();
    expect(screen.getByText(/Ask an Admin to give you access/i)).toBeInTheDocument();
  });

  it("gives an admin a card per drive", async () => {
    stub({ role: "admin", drives: [{ id: "d1", label: "Big Drive", state: "as_is" }] });
    renderPage();
    expect(await screen.findByText("Big Drive")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse files" })).toHaveAttribute("href", "/drives/d1");
  });
});
