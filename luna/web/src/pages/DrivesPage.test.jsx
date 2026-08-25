import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import DrivesPage from "./DrivesPage";

function stubDrivesApi(extra = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (extra.fetch) {
      const hit = extra.fetch(u);
      if (hit) return hit;
    }
    if (u.endsWith("/auth/me") || u.endsWith("/api/v1/auth/me")) {
      return new Response(JSON.stringify({ id: "1", role: "admin", username: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/setup") || u.endsWith("/api/v1/setup")) {
      return new Response(JSON.stringify({ setup_completed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/drives")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/drives/detected")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 500 });
  }));
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <DrivesPage />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("DrivesPage", () => {
  it("tells the user nothing is touched until they choose", async () => {
    stubDrivesApi();
    renderPage();
    expect(screen.getAllByText(/Plug a USB drive/i).length).toBeGreaterThan(0);
  });

  it("uses a page heading for plugged-in drives, not a stacked title card", async () => {
    stubDrivesApi();
    renderPage();
    const heading = await screen.findByRole("heading", { name: /Drives plugged in now/i, level: 2 });
    expect(heading.tagName).toBe("H2");
    expect(heading.closest("[data-slot=card]")).toBeNull();
    expect(await screen.findByText(/Nothing new plugged in/i)).toBeInTheDocument();
  });

  it("shows plain-language drive health for an admin", async () => {
    stubDrivesApi({
      fetch: (u) => {
        if (u.endsWith("/drives")) {
          return new Response(JSON.stringify([{
            id: "d1", label: "Photos Drive", state: "as_is", fs_type: "ext4", device: "sdz",
          }]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.includes("/health")) {
          return new Response(JSON.stringify({
            available: true, overall: "passed", temperature_c: 31, reallocated_sectors: 0,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return null;
      },
    });
    renderPage();
    expect(await screen.findByText(/^Healthy$/i)).toBeInTheDocument();
    expect(screen.getByText(/31°C/)).toBeInTheDocument();
    expect(screen.queryByText(/smartctl/i)).not.toBeInTheDocument();
  });

  it("offers to erase an installer USB instead of writing a marker", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    stubDrivesApi({
      fetch: (u) => {
        if (u.endsWith("/drives/detected")) {
          return new Response(JSON.stringify([{
            name: "sdb", model: "Lexar USB Flash Drive", size_bytes: 8000000000,
            removable: true, usb: true, mount_point: null, fs_type: "iso9660",
          }]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.includes("/drives/sdb/inspect")) {
          return new Response(JSON.stringify({
            device: "sdb", model: "Lexar USB Flash Drive", fs_type: "iso9660",
            mount_point: "/mnt", mounted_by_luna: true, has_marker: false,
            folders: 12, files: 7, unreadable: 0, needs_erase: true,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return null;
      },
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Look inside/i }));
    const lookButtons = await screen.findAllByRole("button", { name: /Look inside/i });
    await user.click(lookButtons[lookButtons.length - 1]);
    expect(await screen.findByText(/12 folders and 7 files/i)).toBeInTheDocument();
    expect(screen.getByText(/still has the Luna installer/i)).toBeInTheDocument();
    expect(screen.queryByText(/tiny/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Erase and add this drive/i }));
    expect(screen.getByRole("button", { name: /Yes, erase it/i })).toBeInTheDocument();
  });
});
