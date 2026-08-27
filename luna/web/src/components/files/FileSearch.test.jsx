import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import FileSearch from "./FileSearch";

function renderSearch(hits) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/auth/me") || u.endsWith("/api/v1/auth/me")) {
      return new Response(JSON.stringify({ id: "1", role: "admin", username: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/setup")) {
      return new Response(JSON.stringify({ setup_completed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/drives")) {
      return new Response(JSON.stringify([{ id: "d1", label: "Photos Drive" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/search")) {
      return new Response(JSON.stringify(hits), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/shares") || u.endsWith("/grants") || u.endsWith("/users") || u.endsWith("/protections")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <FileSearch />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("FileSearch", () => {
  it("explains an empty search in plain language", async () => {
    renderSearch([]);
    fireEvent.change(screen.getByLabelText("Search for a file"), {
      target: { value: "zz" },
    });
    expect(await screen.findByText(/Nothing matched/i)).toBeInTheDocument();
    expect(screen.getByText(/only shows files you're allowed to see/i)).toBeInTheDocument();
  });

  it("offers open and download actions on a file hit", async () => {
    renderSearch([
      {
        drive_id: "d1",
        path: "album/beach.jpg",
        parent: "album",
        name: "beach.jpg",
        kind: "file",
        size: 2048,
        modified: 1,
      },
    ]);
    fireEvent.change(screen.getByLabelText("Search for a file"), {
      target: { value: "beach" },
    });
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.getByText(/Photos Drive \/ album/i)).toBeInTheDocument();

    const open = await screen.findByRole("link", { name: /Go to folder for beach.jpg/i });
    expect(open).toHaveAttribute("href", "/drives/d1?path=album");

    const download = screen.getByRole("link", { name: /Download beach.jpg/i });
    expect(download).toHaveAttribute(
      "href",
      "/api/v1/drives/d1/files/content?path=album%2Fbeach.jpg&download=1"
    );

    expect(screen.getByRole("button", { name: /Sharing for beach.jpg/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy beach.jpg/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Move beach.jpg$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Move beach.jpg to trash/i })).toBeInTheDocument();
  });

  it("opens a folder hit into that folder", async () => {
    renderSearch([
      {
        drive_id: "d1",
        path: "album",
        parent: "",
        name: "album",
        kind: "dir",
        size: 0,
        modified: 1,
      },
    ]);
    fireEvent.change(screen.getByLabelText("Search for a file"), {
      target: { value: "alb" },
    });
    const open = await screen.findByRole("link", { name: /Open album/i });
    expect(open).toHaveAttribute("href", "/drives/d1?path=album");
    expect(screen.queryByRole("link", { name: /Download album/i })).not.toBeInTheDocument();
  });

  it("confirms trash from a search hit", async () => {
    renderSearch([
      {
        drive_id: "d1",
        path: "notes.txt",
        parent: "",
        name: "notes.txt",
        kind: "file",
        size: 10,
        modified: 1,
      },
    ]);
    fireEvent.change(screen.getByLabelText("Search for a file"), {
      target: { value: "notes" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Move notes.txt to trash/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Move to trash\?/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Move to trash/i })).toBeInTheDocument();
  });
});
