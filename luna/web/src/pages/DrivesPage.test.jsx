import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import DrivesPage, { inspectCountLine } from "./DrivesPage";

afterEach(() => {
  window.history.replaceState({}, "", "/");
  window.localStorage.removeItem("luna.mockUnknownDrive");
  vi.unstubAllGlobals();
});

describe("inspectCountLine", () => {
  it("uses singular folder and file when the count is 1", () => {
    expect(inspectCountLine(1, 38)).toBe("We found 1 folder and 38 files on this drive.");
    expect(inspectCountLine(1, 1)).toBe("We found 1 folder and 1 file on this drive.");
    expect(inspectCountLine(0, 0)).toBe("We found 0 folders and 0 files on this drive.");
  });

  it("mentions unreadable items when present", () => {
    expect(inspectCountLine(2, 3, 1)).toBe(
      "We found 2 folders and 3 files on this drive (1 item could not be read).",
    );
  });
});

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
    expect(await screen.findByRole("heading", { name: "Files" })).toBeInTheDocument();
  });

  it("shows a mock 64GB PSSD when opted in for review", async () => {
    window.history.replaceState({}, "", "/drives?mockUnknownDrive=1");
    stubDrivesApi();
    renderPage();
    expect(await screen.findByText("64GB PSSD")).toBeInTheDocument();
    expect(screen.getByText(/64 GB · found on sdmock/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Look inside/i })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing new plugged in/i)).not.toBeInTheDocument();
  });

  it("uses a page heading for unknown drives, not a stacked title card", async () => {
    stubDrivesApi();
    renderPage();
    const heading = await screen.findByRole("heading", { name: /Unknown Drives/i, level: 2 });
    expect(heading.tagName).toBe("H2");
    expect(heading.closest("[data-slot=card]")).toBeNull();
    expect(await screen.findByText(/Nothing new plugged in/i)).toBeInTheDocument();
  });

  it("puts Ignore for now in the header and Look inside in the body", async () => {
    stubDrivesApi({
      fetch: (u) => {
        if (u.endsWith("/drives/detected")) {
          return new Response(JSON.stringify([{
            name: "sdb", model: "Lexar USB Flash Drive", size_bytes: 8000000000,
            removable: true, usb: true, mount_point: null, fs_type: "vfat",
          }]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return null;
      },
    });
    renderPage();
    const ignore = await screen.findByRole("button", { name: /Ignore for now/i });
    const look = screen.getByRole("button", { name: /Look inside/i });
    expect(ignore.compareDocumentPosition(look) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows granted folders for a household member", async () => {
    stubDrivesApi({
      fetch: (u) => {
        if (u.endsWith("/auth/me") || u.endsWith("/api/v1/auth/me")) {
          return new Response(JSON.stringify({ id: "2", role: "user", username: "sam" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (u.endsWith("/me/access")) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return null;
      },
    });
    renderPage();
    expect(await screen.findByText(/Nothing shared with you yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Unknown Drives/i)).not.toBeInTheDocument();
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
            readable: true, writable: false,
            entries: [
              { name: "EFI", kind: "folder" },
              { name: "boot", kind: "folder" },
              { name: "luna.iso", kind: "file" },
            ],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return null;
      },
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Look inside/i }));
    expect(await screen.findByText(/12 folders and 7 files/i)).toBeInTheDocument();
    expect(screen.getByText("EFI")).toBeInTheDocument();
    expect(screen.getByText("boot")).toBeInTheDocument();
    expect(screen.getByText("luna.iso")).toBeInTheDocument();
    expect(screen.getByText(/still has the Luna installer/i)).toBeInTheDocument();
    expect(screen.queryByText(/tiny/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Erase and add this drive/i }));
    expect(screen.getByRole("button", { name: /Yes, erase it/i })).toBeInTheDocument();
  });

  it("refuses Add when the drive is not writable", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    stubDrivesApi({
      fetch: (u) => {
        if (u.endsWith("/drives/detected")) {
          return new Response(JSON.stringify([{
            name: "sdc", model: "Locked Stick", size_bytes: 4000000000,
            removable: true, usb: true, mount_point: "/mnt", fs_type: "vfat",
          }]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.includes("/drives/sdc/inspect")) {
          return new Response(JSON.stringify({
            device: "sdc", model: "Locked Stick", fs_type: "vfat",
            mount_point: "/mnt", mounted_by_luna: false, has_marker: false,
            folders: 1, files: 2, unreadable: 0, needs_erase: false,
            readable: true, writable: false,
            entries: [
              { name: "Photos", kind: "folder" },
              { name: "notes.txt", kind: "file" },
              { name: "todo.txt", kind: "file" },
            ],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return null;
      },
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Look inside/i }));
    expect(await screen.findByText(/1 folder and 2 files/i)).toBeInTheDocument();
    expect(screen.queryByText(/1 folders/i)).not.toBeInTheDocument();
    expect(screen.getByText("Photos")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText(/will not accept new files/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add this drive/i })).not.toBeInTheDocument();
  });

  it("labels Browse files on adopted drives", async () => {
    stubDrivesApi({
      fetch: (u) => {
        if (u.endsWith("/drives")) {
          return new Response(JSON.stringify([{
            id: "d1", label: "Photos Drive", state: "as_is", fs_type: "ext4", device: "sdz",
          }]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.includes("/health")) {
          return new Response(JSON.stringify({
            available: false, overall: "unknown",
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return null;
      },
    });
    renderPage();
    const browse = await screen.findByRole("link", { name: /Browse files/i });
    expect(browse).toHaveAttribute("href", "/drives/d1");
    expect(screen.queryByRole("link", { name: /Open files/i })).not.toBeInTheDocument();
  });

  it("shows a confirm dialog before removing a drive", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    stubDrivesApi({
      fetch: (u) => {
        if (u.endsWith("/drives")) {
          return new Response(JSON.stringify([{
            id: "d1", label: "Photos Drive", state: "as_is", fs_type: "ext4", device: "sdz",
          }]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.includes("/health")) {
          return new Response(JSON.stringify({
            available: false, overall: "unknown",
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return null;
      },
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Remove$/i }));
    expect(await screen.findByRole("heading", { name: /Remove this drive/i })).toBeInTheDocument();
    expect(screen.getByText(/sticker file/i)).toBeInTheDocument();
  });
});
