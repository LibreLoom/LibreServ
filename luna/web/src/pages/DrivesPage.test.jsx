import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
    if (u.includes("/api/v1/search")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/drives/detected")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/api/v1/connect/status")) {
      return new Response(JSON.stringify({
        backup_unlocked: Boolean(extra.backupUnlocked),
        backup_sources: [],
        connect_active: Boolean(extra.backupUnlocked),
        enabled: Boolean(extra.backupUnlocked),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/summary")) {
      return new Response(JSON.stringify({
        id: "d1",
        mounted: true,
        total_bytes: 64_000_000_000,
        free_bytes: 50_000_000_000,
        used_bytes: 14_000_000_000,
        folders: 2,
        files: 10,
        shortcuts: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
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

  it("shows universal search above the drive list", async () => {
    stubDrivesApi();
    renderPage();
    const search = await screen.findByLabelText("Search for a file");
    expect(search).toBeInTheDocument();
    expect(search).toHaveAttribute("placeholder", "Search for a file");
  });

  it("shows a mock 64GB PSSD when opted in for review", async () => {
    window.history.replaceState({}, "", "/drives?mockUnknownDrive=1");
    stubDrivesApi();
    renderPage();
    expect(await screen.findByText("64GB PSSD")).toBeInTheDocument();
    expect(screen.getByText(/64 GB · USB · exFAT/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Add drive$/i })).toBeInTheDocument();
    expect(screen.getByText(/Click "Add drive" to begin adding the drive/i)).toBeInTheDocument();
    expect(screen.getByText(/You'll see the contents of the drive before adding it/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ignore for now/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/found on/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing new plugged in/i)).not.toBeInTheDocument();
  });

  it("previews folder and file names when adding the mock PSSD", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    window.history.replaceState({}, "", "/drives?mockUnknownDrive=1");
    stubDrivesApi();
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Add drive$/i }));
    expect(await screen.findByText(/3 folders and 12 files/i)).toBeInTheDocument();
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("Photos")).toBeInTheDocument();
    expect(screen.getByText("readme.txt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add this drive/i })).toBeInTheDocument();
  });

  it("keeps Add-drive loading copy short while inspect is pending", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    /** @type {() => void} */
    let finishInspect = () => {};
    const inspectGate = new Promise((resolve) => {
      finishInspect = () => {
        resolve(undefined);
      };
    });
    stubDrivesApi({
      fetch: (u) => {
        if (u.endsWith("/drives/detected")) {
          return new Response(JSON.stringify([{
            name: "sdb", model: "64GB PSSD", size_bytes: 64000000000,
            removable: true, usb: true, mount_point: null, fs_type: "exfat",
          }]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.includes("/drives/sdb/inspect")) {
          return inspectGate.then(() => new Response(JSON.stringify({
            device: "sdb", model: "64GB PSSD", fs_type: "exfat",
            mount_point: "/mnt", mounted_by_luna: true, has_marker: false,
            folders: 1, files: 1, unreadable: 0, needs_erase: false,
            readable: true, writable: true,
            entries: [{ name: "Photos", kind: "folder" }, { name: "notes.txt", kind: "file" }],
          }), { status: 200, headers: { "Content-Type": "application/json" } }));
        }
        return null;
      },
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Add drive$/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/^Checking the drive…$/);
    expect(screen.queryByText(/read-only mode/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/changes nothing until you add it/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /What happens when you add a drive/i })).toBeInTheDocument();
    finishInspect();
    expect(await screen.findByText(/1 folder and 1 file/i)).toBeInTheDocument();
  });

  it("uses an info icon for the .luna marker note and softens the name-field focus ring", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    window.history.replaceState({}, "", "/drives?mockUnknownDrive=1");
    stubDrivesApi();
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Add drive$/i }));
    const note = await screen.findByText(/marker file/i);
    const row = note.closest("div");
    expect(row?.querySelector(".text-accent")).toBeTruthy();
    expect(row?.querySelector(".text-warning")).toBeNull();
    const input = screen.getByDisplayValue("64GB PSSD");
    expect(input.className).toMatch(/no-focus-outline/);
    expect(input.className).not.toMatch(/focus:ring/);
  });

  it("animates Add-drive modal out when Add this drive succeeds", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const { waitFor } = await import("@testing-library/react");
    window.history.replaceState({}, "", "/drives?mockUnknownDrive=1");
    stubDrivesApi({
      fetch: (u) => {
        if (u.includes("/adopt")) {
          return new Response(JSON.stringify({ id: "d-new", label: "64GB PSSD" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return null;
      },
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Add drive$/i }));
    await user.click(await screen.findByRole("button", { name: /Add this drive/i }));
    await waitFor(() => {
      expect(screen.getByRole("dialog").closest("[data-slot=dialog-overlay]"))
        .toHaveClass("animate-out");
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("uses a page heading for unknown drives, not a stacked title card", async () => {
    stubDrivesApi();
    renderPage();
    const heading = await screen.findByRole("heading", { name: /Unknown Drives/i, level: 2 });
    expect(heading.tagName).toBe("H2");
    expect(heading.closest("[data-slot=card]")).toBeNull();
    expect(await screen.findByText(/Nothing new plugged in/i)).toBeInTheDocument();
  });

  it("shows useful drive details and Add drive without an Ignore action", async () => {
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
    expect(await screen.findByText(/8 GB · USB · FAT/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Add drive$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ignore for now/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/found on/i)).not.toBeInTheDocument();
  });

  it("shows a member the highest shared folder plus a write exception", async () => {
    stubDrivesApi({
      fetch: (u) => {
        if (u.endsWith("/auth/me") || u.endsWith("/api/v1/auth/me")) {
          return new Response(JSON.stringify({ id: "2", role: "user", username: "sam" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (u.endsWith("/me/access")) {
          return new Response(JSON.stringify([
            { id: "g-drive", drive_id: "d1", drive_label: "Photos Drive", path: "", permission: "read" },
            { id: "g-dcim", drive_id: "d1", drive_label: "Photos Drive", path: "DCIM", permission: "write" },
            { id: "g-print", drive_id: "d1", drive_label: "Photos Drive", path: "DCIM/print", permission: "read" },
          ]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return null;
      },
    });
    renderPage();
    expect(await screen.findByText("Whole drive")).toBeInTheDocument();
    expect(screen.getByText("DCIM")).toBeInTheDocument();
    expect(screen.queryByText("DCIM/print")).not.toBeInTheDocument();
    const opens = screen.getAllByRole("link", { name: "Open" });
    expect(opens).toHaveLength(2);
    expect(opens[0]).toHaveAttribute("href", "/drives/d1?path=");
    expect(opens[1]).toHaveAttribute("href", "/drives/d1?path=DCIM");
    expect(screen.queryByText(/Unknown Drives/i)).not.toBeInTheDocument();
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
    expect(screen.getByText(/Ask an administrator to share a folder, drive, or file with you/i)).toBeInTheDocument();
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
    // Device connection lives inside collapsed Drive details, not as a status line.
    expect(screen.getByRole("button", { name: /Drive details/i })).toHaveAttribute("aria-expanded", "false");
  });

  it("hides device connection behind collapsible Drive details", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    stubDrivesApi({
      fetch: (u) => {
        if (u.endsWith("/drives")) {
          return new Response(JSON.stringify([{
            id: "d1", label: "64GB PSSD!", state: "as_is", fs_type: "exfat", device: "sdmock",
          }]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.includes("/health")) {
          return new Response(JSON.stringify({
            available: false, overall: "unknown",
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.includes("/summary")) {
          return new Response(JSON.stringify({
            id: "d1",
            mounted: true,
            total_bytes: 64_000_000_000,
            free_bytes: 50_000_000_000,
            used_bytes: 14_000_000_000,
            folders: 1,
            files: 2,
            shortcuts: [],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return null;
      },
    });
    renderPage();
    // Storage bar is always visible (dashboard-style), outside Drive details.
    expect(await screen.findByText(/50 GB free/i)).toBeInTheDocument();
    expect(screen.getByText(/14 GB used · 64 GB total/i)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /22% used/i })).toBeInTheDocument();
    expect(document.querySelector("[data-slot=drive-storage-bar]")).toBeTruthy();

    const toggle = await screen.findByRole("button", { name: /Drive details/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById(toggle.getAttribute("aria-controls"));
    expect(panel).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText(/No health report/i)).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByText(/^exFAT$/i)).toBeInTheDocument();
    expect(screen.getByText(/^sdmock$/i)).toBeInTheDocument();
    expect(screen.getByText(/sdmock · exFAT/i)).toBeInTheDocument();
    // Card-style collapsible + ValueDisplay rows (storage is outside)
    expect(toggle.closest("[data-slot=collapsible]")?.className).toMatch(/rounded-large-element/);
    expect(document.querySelectorAll("[data-slot=value-display]")).toHaveLength(3);
  });

  it("shows ejected drives as Ejected without Open files or Eject safely", async () => {
    stubDrivesApi({
      fetch: (u) => {
        if (u.endsWith("/drives")) {
          return new Response(JSON.stringify([{
            id: "d1", label: "General UDisk", state: "ejected", fs_type: "vfat", device: "sda",
            mount_point: "",
          }]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return null;
      },
    });
    renderPage();
    expect(await screen.findByText(/^Ejected$/i)).toBeInTheDocument();
    expect(screen.getByText(/Plug it back in to use files again/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open files/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Eject safely/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Remove$/i })).toBeInTheDocument();
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
    await user.click(await screen.findByRole("button", { name: /^Add drive$/i }));
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
    await user.click(await screen.findByRole("button", { name: /^Add drive$/i }));
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
    expect(await screen.findByRole("button", { name: /^Remove$/i })).toBeInTheDocument();
    expect(screen.queryByText(/No health report/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/doesn't mean anything is wrong/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/doesn't tell Luna its temperature/i)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Remove$/i }));
    expect(await screen.findByRole("heading", { name: /Remove this drive/i })).toBeInTheDocument();
    expect(screen.getByText(/sticker file/i)).toBeInTheDocument();
  });

  it("offers Browse files linking to the full files page", async () => {
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
    expect(await screen.findByRole("link", { name: /Browse files/i })).toHaveAttribute("href", "/drives/d1");
    expect(screen.queryByRole("heading", { name: /Browse Photos Drive/i })).not.toBeInTheDocument();
  });

  it("shows singular grammar and named entries when adding a drive", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    stubDrivesApi({
      fetch: (u) => {
        if (u.endsWith("/drives/detected")) {
          return new Response(JSON.stringify([{
            name: "sde", model: "Tiny Stick", size_bytes: 1000000000,
            removable: true, usb: true, mount_point: null, fs_type: "vfat",
          }]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.includes("/drives/sde/inspect")) {
          return new Response(JSON.stringify({
            device: "sde", model: "Tiny Stick", fs_type: "vfat",
            mount_point: "/mnt", mounted_by_luna: true, has_marker: false,
            folders: 1, files: 1, unreadable: 0, needs_erase: false,
            readable: true, writable: true,
            entries: [
              { name: "Photos", kind: "dir" },
              { name: "readme.txt", kind: "file" },
            ],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return null;
      },
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Add drive$/i }));
    expect(await screen.findByText(/We found 1 folder and 1 file on this drive/i)).toBeInTheDocument();
    expect(screen.getByText("On this drive")).toBeInTheDocument();
    expect(screen.getByText("Photos")).toBeInTheDocument();
    expect(screen.getByText("readme.txt")).toBeInTheDocument();
  });

  it("shows a visible truncated-list hint on the primary inspect panel", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    stubDrivesApi({
      fetch: (u) => {
        if (u.endsWith("/drives/detected")) {
          return new Response(JSON.stringify([{
            name: "sde", model: "Tiny Stick", size_bytes: 1000000000,
            removable: true, usb: true, mount_point: null, fs_type: "vfat",
          }]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.includes("/drives/sde/inspect")) {
          return new Response(JSON.stringify({
            device: "sde", model: "Tiny Stick", fs_type: "vfat",
            mount_point: "/mnt", mounted_by_luna: true, has_marker: false,
            folders: 3, files: 12, unreadable: 0, needs_erase: false,
            readable: true, writable: true,
            entries: [
              { name: "Videos", kind: "folder" },
              { name: "readme.txt", kind: "file" },
            ],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return null;
      },
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Add drive$/i }));
    const hint = await screen.findByText((_content, el) =>
      el?.tagName === "P" &&
      /Showing names at the root of the drive/i.test(el.textContent || ""),
    );
    expect(hint).toHaveClass("text-secondary");
    expect(hint).not.toHaveClass("text-primary");
    expect(within(hint).getByRole("button", { name: /^root$/i })).toBeInTheDocument();
    expect(screen.queryByText(/at the top of the drive/i)).not.toBeInTheDocument();
  });
});
