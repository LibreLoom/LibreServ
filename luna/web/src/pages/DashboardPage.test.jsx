import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { dashboard as greetingMessages } from "../lib/greetings.jsx";
import {
  backupRow,
  jsonResponse,
  renderDashboard,
  stubDashboardFetch,
} from "../test/dashboardHarness.jsx";

vi.mock("../components/files/ProtectSheet.jsx", () => ({
  default: ({ driveId, path }) => <div data-testid="protect-sheet">{`${driveId}:${path}`}</div>,
}));

vi.mock("../components/cloud/RecoveryPhraseCheck.jsx", () => ({
  default: ({ lunaId, onClose }) => (
    <div data-testid="phrase-check">
      <span>{lunaId}</span>
      <button onClick={onClose}>Close check</button>
    </div>
  ),
}));

const PHOTOS_DRIVE = { id: "d1", label: "Photos Drive", state: "as_is", device: "sda1", fs_type: "exfat" };

const SANDISK = { name: "sdb", model: "SanDisk", size_bytes: 32_000_000_000, usb: true, fs_type: "exfat" };

/** A whole-drive share: the Member can browse the drive root. */
const ROOT_GRANT = {
  id: "g-root",
  kind: "path",
  drive_id: "d1",
  drive_label: "Photos Drive",
  path: "",
  name: "Photos Drive",
  caps: "view",
};

/** A folder share below the root: the Member cannot browse the root. */
const WORK_GRANT = {
  id: "g-work",
  kind: "path",
  drive_id: "d1",
  drive_label: "Photos Drive",
  path: "Work",
  name: "Work",
  caps: "view",
};

/** A single shared file. */
const FILE_GRANT = {
  id: "g-file",
  kind: "path",
  drive_id: "d1",
  drive_label: "Photos Drive",
  path: "docs/report.pdf",
  name: "report.pdf",
  is_file: true,
  caps: "view",
};

const WARNING_CHECKS = {
  overall_pass: true,
  checks: {
    clock_sync: {
      status: "warning",
      message: "Clock is a few minutes off.",
      category: "system",
      details: {},
    },
  },
};

const FAILED_CHECKS = {
  overall_pass: false,
  checks: {
    clock_sync: {
      status: "failed",
      message: "Clock could not be read.",
      category: "system",
      details: {},
    },
  },
};

/** Requests every Admin view of the dashboard makes before it is settled. */
const ADMIN_REQUESTS = [
  "/api/v1/me/recents",
  "/api/v1/drives/detected",
  "/api/v1/system/health/check",
  "/api/v1/backups",
  "/api/v1/cloud/backups",
];

/** Requests every Member view of the dashboard makes before it is settled. */
const MEMBER_REQUESTS = [
  "/api/v1/me/recents",
  "/api/v1/me/access",
  "/api/v1/backups",
  "/api/v1/cloud/backups",
];

/** @param {unknown} url */
function pathOf(url) {
  return new URL(String(url), "http://localhost").pathname;
}

/** @param {import("vitest").Mock} fetchMock */
function requestedPaths(fetchMock) {
  return fetchMock.mock.calls.map(([url]) => pathOf(url));
}

/**
 * How many times the page asked for one path.
 *
 * @param {import("vitest").Mock} fetchMock
 * @param {string} path
 */
function requestCount(fetchMock, path) {
  return requestedPaths(fetchMock).filter((asked) => asked === path).length;
}

/**
 * Waits until the page has asked for each path, then lets those answers render. Keeps the
 * negative checks below from passing before the data has arrived.
 *
 * @param {import("vitest").Mock} fetchMock
 * @param {string[]} paths
 */
async function waitForRequests(fetchMock, paths) {
  await waitFor(() => {
    const asked = requestedPaths(fetchMock);
    for (const path of paths) expect(asked).toContain(path);
  });
  await act(async () => {
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/**
 * Stubs the dashboard endpoints, then answers Software updates as available. Used to prove the
 * Member header never shows the update pill.
 *
 * @param {Record<string, any>} opts
 * @returns {import("vitest").Mock}
 */
function stubWithUpdateAvailable(opts) {
  const base = stubDashboardFetch(opts);
  const fetchMock = vi.fn(async (/** @type {any} */ url, /** @type {any} */ init) => {
    if (pathOf(url) === "/api/v1/system/updates") {
      return jsonResponse({ update_available: true, latest_version: "0.5.0" });
    }
    return base(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The Recents card, found by its heading. */
function recentsCard() {
  return /** @type {HTMLElement} */ (
    screen.getByRole("heading", { name: "Recents" }).closest("[data-slot=card]")
  );
}

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    // The header tip is decided once per browser session; start each test with a fresh visit.
    window.sessionStorage.clear();
  });

  describe("header and greeting", () => {
    it("greets the signed-in user and shows the drive card without uptime or network text", async () => {
      stubDashboardFetch();
      renderDashboard();
      const heading = await screen.findByRole("heading", { name: /max/i });
      const greetingBit = heading.textContent.replace(/,?\s*max\s*$/i, "").trim();
      const known = greetingMessages.some((g) => g.replace(/,\s*$/, "").trim() === greetingBit)
        || /Happy|Merry/.test(greetingBit);
      expect(known).toBe(true);
      expect(await screen.findByText("Family photos")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Browse files" })).toHaveAttribute("href", "/drives/d1");
      expect(document.body).not.toHaveTextContent(/uptime|on this network|remote access/i);
      expect(document.body).not.toHaveTextContent(/What to do next|No subscription|Anywhere, free/i);
    });

    it("shows a warning pill to Admins when a system check warns", async () => {
      stubDashboardFetch({ systemChecks: WARNING_CHECKS });
      renderDashboard();
      expect(await screen.findByRole("button", { name: /^1 warning\./ })).toBeInTheDocument();
      expect(screen.queryByText(/Everything looks good/i)).not.toBeInTheDocument();
    });

    it("shows no warning pill when the only system problem is a failed check", async () => {
      const fetchMock = stubDashboardFetch({ systemChecks: FAILED_CHECKS });
      renderDashboard();
      await screen.findByText("Family photos");
      await waitForRequests(fetchMock, ADMIN_REQUESTS);
      expect(screen.queryByRole("button", { name: /warning/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/\d+ warnings?/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Everything looks good/i)).not.toBeInTheDocument();
    });

    it("shows an Admin the tip, the Software update pill and the warning pill", async () => {
      const fetchMock = stubWithUpdateAvailable({ systemChecks: WARNING_CHECKS });
      renderDashboard();
      expect(
        await screen.findByRole("link", { name: /Software update 0\.5\.0 available/ }),
      ).toHaveAttribute("href", "/settings#about");
      expect(await screen.findByRole("button", { name: /^1 warning\./ })).toBeInTheDocument();
      await waitForRequests(fetchMock, ADMIN_REQUESTS);
      expect(document.querySelector("[data-slot=software-update-pill]")).not.toBeNull();
      expect(document.querySelector("[data-slot=system-health-pill]")).not.toBeNull();
      expect(document.querySelector("[data-slot=tip-pill]")).not.toBeNull();
    });

    it("shows an Admin the tip but no Software update pill when Luna is up to date", async () => {
      const fetchMock = stubDashboardFetch();
      renderDashboard();
      await screen.findByText("Family photos");
      await waitForRequests(fetchMock, [...ADMIN_REQUESTS, "/api/v1/system/updates"]);
      expect(document.querySelector("[data-slot=tip-pill]")).not.toBeNull();
      expect(document.querySelector("[data-slot=software-update-pill]")).toBeNull();
    });

    it("shows Members the tip but no update or warning pill, even when the system check would warn", async () => {
      const fetchMock = stubWithUpdateAvailable({
        username: "jamie",
        role: "user",
        userId: "u2",
        drives: [PHOTOS_DRIVE],
        access: [ROOT_GRANT],
        systemChecks: WARNING_CHECKS,
      });
      renderDashboard();
      await screen.findByRole("link", { name: "Browse files" });
      await waitForRequests(fetchMock, MEMBER_REQUESTS);
      expect(screen.queryByRole("button", { name: /warning/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Software update/i })).not.toBeInTheDocument();
      expect(document.querySelector("[data-slot=system-health-pill]")).toBeNull();
      expect(document.querySelector("[data-slot=software-update-pill]")).toBeNull();
      expect(requestedPaths(fetchMock)).not.toContain("/api/v1/system/health/check");
      expect(requestedPaths(fetchMock)).not.toContain("/api/v1/system/updates");
      // The tip is for everyone, not just Admins.
      expect(document.querySelector("[data-slot=tip-pill]")).not.toBeNull();
    });

    it("holds no right-hand header slot for an Admin with nothing to show", async () => {
      const fetchMock = stubDashboardFetch();
      renderDashboard();
      await screen.findByText("Family photos");
      await waitForRequests(fetchMock, [...ADMIN_REQUESTS, "/api/v1/system/updates"]);
      expect(document.querySelector("[data-slot=header-pills]")).toBeNull();
    });

    it("holds the right-hand header slot only while a pill is in it", async () => {
      stubWithUpdateAvailable({});
      renderDashboard();
      const pill = await screen.findByRole("link", { name: /Software update 0\.5\.0/ });
      expect(pill.closest("[data-slot=header-pills]")).not.toBeNull();
    });

    it("holds the right-hand header slot when only a warning shows", async () => {
      stubDashboardFetch({ systemChecks: WARNING_CHECKS });
      renderDashboard();
      const pill = await screen.findByRole("button", { name: /^1 warning\./ });
      expect(pill.closest("[data-slot=header-pills]")).not.toBeNull();
    });

    it("holds no right-hand header slot for a Member, even when an update is ready", async () => {
      const fetchMock = stubWithUpdateAvailable({
        username: "jamie",
        role: "user",
        userId: "u2",
        drives: [PHOTOS_DRIVE],
        access: [ROOT_GRANT],
        systemChecks: WARNING_CHECKS,
      });
      renderDashboard();
      await screen.findByRole("link", { name: "Browse files" });
      await waitForRequests(fetchMock, MEMBER_REQUESTS);
      expect(document.querySelector("[data-slot=header-pills]")).toBeNull();
    });

    it("draws no empty card under the tip when the header splits and no pill shows", async () => {
      // jsdom has no layout, so make the header's measuring say the row is too wide for the card.
      const width = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(100);
      const needed = vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(500);
      try {
        const fetchMock = stubDashboardFetch();
        renderDashboard();
        await screen.findByText("Family photos");
        await waitForRequests(fetchMock, [...ADMIN_REQUESTS, "/api/v1/system/updates"]);
        const split = await waitFor(() => {
          const found = document.querySelector("[data-slot=header-card-split]");
          expect(found).not.toBeNull();
          return /** @type {Element} */ (found);
        });
        // The title card and the tip card, and nothing else.
        expect(split.querySelectorAll("[data-slot=card]")).toHaveLength(2);
        expect(split.querySelector("[data-slot=tip-pill]")).not.toBeNull();
      } finally {
        width.mockRestore();
        needed.mockRestore();
      }
    });

    it("titles the drive column Drives above the cards for Admins", async () => {
      stubDashboardFetch();
      renderDashboard();
      const heading = await screen.findByRole("heading", { name: "Drives" });
      const card = await screen.findByRole("heading", { name: "Family photos" });
      expect(heading.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Your folders" })).not.toBeInTheDocument();
    });

    it("titles the drive column Your folders for Members and has no Shared with you card", async () => {
      stubDashboardFetch({
        username: "jamie",
        role: "user",
        userId: "u2",
        drives: [PHOTOS_DRIVE],
        access: [FILE_GRANT],
      });
      renderDashboard();
      expect(await screen.findByRole("heading", { name: "Your folders" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Drives" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Shared with you" })).not.toBeInTheDocument();
      expect(screen.queryByText("Shared with you")).not.toBeInTheDocument();
    });
  });

  describe("layout", () => {
    /** One recent file, so the Recents column has something to show. */
    const RECENT_NOTE = [{ kind: "file", driveId: "d1", path: "Documents/note.md", at: Date.now() - 60_000 }];

    /** A backup that stopped copying, so the Needs you zone has a row. */
    const FAILING_BACKUP = backupRow({ state: "failing", last_error: "The backup drive is full." });

    /** The two-column wrapper that holds Recents and Drives, found from one of their headings. */
    const columnsAround = (/** @type {HTMLElement} */ heading) =>
      /** @type {HTMLElement} */ (heading.closest(".grid.items-start"));

    it("puts Needs you first, then Recents, then Drives, which is also the phone order", async () => {
      stubDashboardFetch({ backups: [FAILING_BACKUP], recents: RECENT_NOTE });
      renderDashboard();
      const needsYou = await screen.findByRole("region", { name: "Needs you" });
      expect(within(needsYou).getByText("backup didn't finish")).toBeInTheDocument();
      const recents = await screen.findByRole("heading", { name: "Recents" });
      const drives = await screen.findByRole("heading", { name: "Drives" });
      expect(needsYou.compareDocumentPosition(recents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(recents.compareDocumentPosition(drives) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("keeps Needs you, then the backups line, above the two columns", async () => {
      stubDashboardFetch({ backups: [FAILING_BACKUP], recents: RECENT_NOTE });
      renderDashboard();
      const needsYou = await screen.findByRole("region", { name: "Needs you" });
      const recents = await screen.findByRole("heading", { name: "Recents" });
      const drives = await screen.findByRole("heading", { name: "Drives" });
      const backups = await screen.findByRole("region", { name: "Backups" });
      const columns = columnsAround(recents);
      expect(columns).toContainElement(drives);
      expect(columns).not.toContainElement(needsYou);
      expect(columns).not.toContainElement(backups);
      expect(needsYou.compareDocumentPosition(columns) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(needsYou.compareDocumentPosition(backups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(backups.compareDocumentPosition(columns) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("sets Recents and Drives side by side on desktop when both are there", async () => {
      stubDashboardFetch({ recents: RECENT_NOTE });
      renderDashboard();
      const recents = await screen.findByRole("heading", { name: "Recents" });
      const drives = await screen.findByRole("heading", { name: "Drives" });
      const columns = columnsAround(recents);
      expect(columns).toContainElement(drives);
      expect(columns).toHaveClass("grid-cols-1", "md:grid-cols-2");
    });

    it("keeps one column when only Recents is there", async () => {
      stubDashboardFetch({ drives: [], recents: RECENT_NOTE });
      renderDashboard();
      const recents = await screen.findByRole("heading", { name: "Recents" });
      expect(screen.queryByRole("heading", { name: "Drives" })).not.toBeInTheDocument();
      expect(columnsAround(recents)).toHaveClass("grid-cols-1");
      expect(columnsAround(recents)).not.toHaveClass("md:grid-cols-2");
    });

    it("keeps one column when only Drives is there", async () => {
      stubDashboardFetch({ recents: [] });
      renderDashboard();
      const drives = await screen.findByRole("heading", { name: "Drives" });
      expect(screen.queryByRole("heading", { name: "Recents" })).not.toBeInTheDocument();
      expect(columnsAround(drives)).toHaveClass("grid-cols-1");
      expect(columnsAround(drives)).not.toHaveClass("md:grid-cols-2");
    });
  });

  describe("drive cards", () => {
    it("shows free space, used space, a usage bar and folder shortcuts with no root counts", async () => {
      stubDashboardFetch();
      renderDashboard();
      expect(await screen.findByText("30 GB free")).toBeInTheDocument();
      expect(screen.getByText(/34 GB used/)).toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: "53% used" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Photos" })).toHaveAttribute("href", "/drives/d1?path=Photos");
      expect(screen.getByRole("link", { name: "Documents" })).toHaveAttribute(
        "href",
        "/drives/d1?path=Documents",
      );
      expect(screen.getByRole("link", { name: "Browse files" })).toHaveAttribute("href", "/drives/d1");
      expect(screen.queryByText(/\d+ folders?/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/at the/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^root$/i })).not.toBeInTheDocument();
    });

    it("keeps the root counts off the drive card even when the summary reports them", async () => {
      stubDashboardFetch({
        summaries: {
          d1: {
            id: "d1",
            mounted: true,
            total_bytes: 64_000_000_000,
            free_bytes: 30_000_000_000,
            used_bytes: 34_000_000_000,
            folders: 3,
            files: 12,
            shortcuts: ["Photos"],
          },
        },
      });
      renderDashboard();
      expect(await screen.findByText("30 GB free")).toBeInTheDocument();
      expect(screen.queryByText(/\d+ folders?/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/12 files/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/at the/i)).not.toBeInTheDocument();
    });

    it("leaves the storage block out when the drive reports no space", async () => {
      stubDashboardFetch({
        summaries: {
          d1: {
            id: "d1",
            mounted: false,
            total_bytes: null,
            free_bytes: null,
            used_bytes: null,
            shortcuts: ["Photos"],
          },
        },
      });
      renderDashboard();
      expect(await screen.findByRole("link", { name: "Photos" })).toHaveAttribute(
        "href",
        "/drives/d1?path=Photos",
      );
      expect(screen.getByRole("link", { name: "Browse files" })).toHaveAttribute("href", "/drives/d1");
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      expect(screen.queryByText(/\bfree\b/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Checking space/i)).not.toBeInTheDocument();
    });

    it("shows the Unplugged copy for a missing drive, with no storage and no Needs you row", async () => {
      const fetchMock = stubDashboardFetch({
        drives: [{ id: "d2", label: "Travel stick", state: "missing" }],
        summaries: {},
      });
      renderDashboard();
      expect(await screen.findByText("Travel stick")).toBeInTheDocument();
      expect(
        await screen.findByText(/Unplugged\. Plug it back in when you want its files and space here\./),
      ).toBeInTheDocument();
      await waitForRequests(fetchMock, ADMIN_REQUESTS);
      expect(screen.queryByRole("link", { name: /Open Drives/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/\bGB\b/)).not.toBeInTheDocument();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    });

    it("shows a Member's drive card with shortcuts and a See all shared items link", async () => {
      stubDashboardFetch({
        username: "jamie",
        role: "user",
        userId: "u2",
        drives: [PHOTOS_DRIVE],
        access: [WORK_GRANT],
        summaries: {
          d1: {
            id: "d1",
            mounted: true,
            total_bytes: 64_000_000_000,
            free_bytes: 30_000_000_000,
            used_bytes: 34_000_000_000,
            shortcuts: ["Family photos", "Sam"],
          },
        },
      });
      renderDashboard();
      expect(await screen.findByRole("link", { name: "Family photos" })).toHaveAttribute(
        "href",
        "/drives/d1?path=Family%20photos",
      );
      expect(screen.getByRole("link", { name: "Sam" })).toHaveAttribute("href", "/drives/d1?path=Sam");
      expect(screen.getByRole("link", { name: "See all shared items" })).toHaveAttribute("href", "/shared");
    });

    it("opens a Member's drive at their deep-linked folder when the drive root is not browsable", async () => {
      stubDashboardFetch({
        username: "jamie",
        role: "user",
        userId: "u2",
        drives: [PHOTOS_DRIVE],
        access: [
          {
            id: "m3",
            kind: "path",
            drive_id: "d1",
            drive_label: "Photos Drive",
            path: "docs/drop",
            name: "drop",
            caps: "upload",
          },
        ],
        summaries: {
          d1: {
            id: "d1",
            mounted: true,
            total_bytes: 64_000_000_000,
            free_bytes: 30_000_000_000,
            used_bytes: 34_000_000_000,
            shortcuts: [],
          },
        },
      });
      renderDashboard();
      expect(await screen.findByRole("link", { name: "Browse files" })).toHaveAttribute(
        "href",
        "/drives/d1?path=docs%2Fdrop",
      );
      expect(document.querySelector('a[href="/drives/d1"]')).toBeNull();
    });
  });

  describe("Needs you", () => {
    it("shows no Needs you zone for a healthy Admin", async () => {
      const fetchMock = stubDashboardFetch();
      renderDashboard();
      await screen.findByRole("link", { name: "Browse files" });
      await waitForRequests(fetchMock, ADMIN_REQUESTS);
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
      expect(screen.queryByText(/Everything looks good/i)).not.toBeInTheDocument();
    });

    it("shows no Needs you zone for a Member with a healthy world", async () => {
      const fetchMock = stubDashboardFetch({
        username: "jamie",
        role: "user",
        userId: "u2",
        drives: [PHOTOS_DRIVE],
        access: [ROOT_GRANT],
      });
      renderDashboard();
      await screen.findByRole("link", { name: "Browse files" });
      await waitForRequests(fetchMock, MEMBER_REQUESTS);
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    });

    it("explains the first run with No drives yet and no button when Admin has no drives", async () => {
      stubDashboardFetch({ drives: [] });
      renderDashboard();
      const region = await screen.findByRole("region", { name: "Needs you" });
      expect(within(region).getByText("No drives yet")).toBeInTheDocument();
      expect(within(region).getByText("Plug a USB drive into Luna to get started.")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Go to Drives/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Drives" })).not.toBeInTheDocument();
    });

    it("flags a newly plugged-in USB drive with an Add drive button, not a link", async () => {
      stubDashboardFetch({ drives: [], detected: [SANDISK] });
      renderDashboard();
      const region = await screen.findByRole("region", { name: "Needs you" });
      expect(await within(region).findByText("New drive plugged in")).toBeInTheDocument();
      expect(within(region).getByRole("button", { name: /^Add drive$/ })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /^Add drive$/ })).not.toBeInTheDocument();
    });

    it("opens the New drive detected picker listing the drive, with a Cancel button", async () => {
      const user = userEvent.setup();
      stubDashboardFetch({ drives: [], detected: [SANDISK] });
      renderDashboard();
      await user.click(await screen.findByRole("button", { name: /^Add drive$/ }));
      const dialog = await screen.findByRole("dialog", { name: /New drive detected/i });
      expect(within(dialog).getByRole("button", { name: /SanDisk/ })).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /^Cancel$/ })).toBeInTheDocument();
    });

    it("closes the picker with Cancel", async () => {
      const user = userEvent.setup();
      stubDashboardFetch({ drives: [], detected: [SANDISK] });
      renderDashboard();
      await user.click(await screen.findByRole("button", { name: /^Add drive$/ }));
      const dialog = await screen.findByRole("dialog", { name: /New drive detected/i });
      await user.click(within(dialog).getByRole("button", { name: /^Cancel$/ }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: /New drive detected/i })).not.toBeInTheDocument(),
      );
    });

    it("opens the inspect wizard when the listed drive is picked", async () => {
      const user = userEvent.setup();
      stubDashboardFetch({ drives: [], detected: [SANDISK] });
      renderDashboard();
      await user.click(await screen.findByRole("button", { name: /^Add drive$/ }));
      const dialog = await screen.findByRole("dialog", { name: /New drive detected/i });
      await user.click(within(dialog).getByRole("button", { name: /SanDisk/ }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: /New drive detected/i })).not.toBeInTheDocument(),
      );
      expect(await screen.findByText(/Add SanDisk/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Add this drive$/ })).toBeInTheDocument();
    });
  });

  describe("Members", () => {
    it("tells Members to ask an Admin when nothing is shared yet", async () => {
      stubDashboardFetch({ username: "jamie", role: "user", userId: "u2", drives: [], access: [] });
      renderDashboard();
      expect(await screen.findByText("Nothing shared with you yet")).toBeInTheDocument();
      expect(
        screen.getByText("Ask an Admin to share a folder, drive, or album with you."),
      ).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Go to Drives/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/Plug a USB drive/i)).not.toBeInTheDocument();
    });

    it("shows albums shared with a Member and no nothing-shared message", async () => {
      stubDashboardFetch({
        username: "jamie",
        role: "user",
        userId: "u2",
        drives: [],
        access: [
          {
            id: "m1",
            kind: "album",
            drive_id: "d1",
            drive_label: "Photos Drive",
            album_id: "al1",
            name: "Beach day",
            caps: "view",
          },
        ],
      });
      renderDashboard();
      expect(await screen.findByText(/Albums shared with you/i)).toBeInTheDocument();
      expect(screen.getByText("Beach day")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /^View album$/i })).toHaveAttribute(
        "href",
        "/gallery#albums/d1/al1",
      );
      expect(screen.queryByText(/Nothing shared with you yet/i)).not.toBeInTheDocument();
    });

    it("gives a Member with a share but no drive card a See all shared items link", async () => {
      stubDashboardFetch({
        username: "jamie",
        role: "user",
        userId: "u2",
        drives: [],
        access: [WORK_GRANT],
      });
      renderDashboard();
      expect(await screen.findByRole("link", { name: /See all shared items/i })).toHaveAttribute(
        "href",
        "/shared",
      );
      expect(screen.queryByText(/Nothing shared with you yet/i)).not.toBeInTheDocument();
    });
  });

  describe("Recents", () => {
    it("lists recent files, folders and drives as one link each, with no kind labels", async () => {
      const now = Date.now();
      window.localStorage.setItem(
        "luna.recentItems.max",
        JSON.stringify([
          { kind: "file", driveId: "d1", driveLabel: "Family photos", path: "Documents/note.md", at: now - 5 * 60_000 },
          { kind: "folder", driveId: "d1", path: "Office", at: now - 3 * 3_600_000 },
          { kind: "drive", driveId: "d1", path: "", at: now - 2 * 86_400_000 },
        ]),
      );
      const fetchMock = stubDashboardFetch();
      renderDashboard();
      expect(await screen.findByRole("heading", { name: "Recents" })).toBeInTheDocument();
      await waitForRequests(fetchMock, ADMIN_REQUESTS);

      const card = recentsCard();
      expect(within(card).getByText("note.md")).toBeInTheDocument();
      expect(within(card).getByText("Family photos · Documents")).toBeInTheDocument();
      expect(within(card).getByText("Office")).toBeInTheDocument();
      expect(within(card).getByText("5 min ago")).toBeInTheDocument();
      expect(within(card).getByText("3 h ago")).toBeInTheDocument();
      expect(within(card).getByText("2 days ago")).toBeInTheDocument();

      const links = within(card).getAllByRole("link");
      expect(links.map((a) => a.getAttribute("href"))).toEqual([
        "/drives/d1?path=Documents&file=note.md",
        "/drives/d1?path=Office",
        "/drives/d1",
      ]);
      expect(within(card).queryByRole("link", { name: /^Open$/i })).not.toBeInTheDocument();
      expect(within(card).queryByText(/^(File|Folder)$/)).not.toBeInTheDocument();
    });

    it("shows at most six recent items", async () => {
      const now = Date.now();
      const recents = Array.from({ length: 8 }, (_, i) => ({
        kind: "file",
        driveId: "d1",
        path: `Docs/file${i + 1}.txt`,
        at: now - (i + 1) * 60_000,
      }));
      stubDashboardFetch({ recents });
      renderDashboard();
      expect(await screen.findByText("file1.txt")).toBeInTheDocument();
      const card = recentsCard();
      expect(within(card).getAllByRole("link")).toHaveLength(6);
      expect(within(card).getByText("file6.txt")).toBeInTheDocument();
      expect(within(card).queryByText("file7.txt")).not.toBeInTheDocument();
      expect(within(card).queryByText("file8.txt")).not.toBeInTheDocument();
    });

    it("hides the Recents card when there is nothing to resume", async () => {
      const fetchMock = stubDashboardFetch();
      renderDashboard();
      await screen.findByRole("link", { name: "Browse files" });
      await waitForRequests(fetchMock, ADMIN_REQUESTS);
      expect(screen.queryByRole("heading", { name: "Recents" })).not.toBeInTheDocument();
    });

    it("hides the Recents card when the server list is empty", async () => {
      const fetchMock = stubDashboardFetch({ recents: [] });
      renderDashboard();
      await screen.findByRole("link", { name: "Browse files" });
      await waitForRequests(fetchMock, ADMIN_REQUESTS);
      expect(screen.queryByRole("heading", { name: "Recents" })).not.toBeInTheDocument();
    });

    it("shows a Member their own recents, not another user's", async () => {
      const now = Date.now();
      window.localStorage.setItem(
        "luna.recentItems.max",
        JSON.stringify([{ kind: "file", driveId: "d1", path: "secret.md", at: now }]),
      );
      window.localStorage.setItem(
        "luna.recentItems.jamie",
        JSON.stringify([{ kind: "file", driveId: "d1", path: "Recipes.docx", at: now }]),
      );
      stubDashboardFetch({
        username: "jamie",
        role: "user",
        userId: "u2",
        drives: [PHOTOS_DRIVE],
        access: [ROOT_GRANT],
      });
      renderDashboard();
      expect(await screen.findByText("Recipes.docx")).toBeInTheDocument();
      expect(screen.queryByText("secret.md")).not.toBeInTheDocument();
    });

    it("shows a renamed file under its new name once, with a single link", async () => {
      const now = Date.now();
      window.localStorage.setItem(
        "luna.recentItems.max",
        JSON.stringify([{ kind: "file", driveId: "d1", path: "whiteboard.excalidraw", at: now }]),
      );
      stubDashboardFetch({
        recents: [{ kind: "file", driveId: "d1", path: "67.excalidraw", at: now - 60_000 }],
      });
      renderDashboard();
      expect(await screen.findByText("67.excalidraw")).toBeInTheDocument();
      expect(screen.queryByText("whiteboard.excalidraw")).not.toBeInTheDocument();
      const links = within(recentsCard()).getAllByRole("link");
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute("href", "/drives/d1?file=67.excalidraw");
    });
  });

  describe("Backups line", () => {
    it("shows All backed up and a See all backups button when every backup is healthy", async () => {
      stubDashboardFetch({ backups: [backupRow()] });
      renderDashboard();
      const region = await screen.findByRole("region", { name: "Backups" });
      expect(within(region).getByText("All backed up")).toBeInTheDocument();
      expect(within(region).getByText("1 backup")).toBeInTheDocument();
      expect(within(region).getByRole("button", { name: "See all backups" })).toBeInTheDocument();
    });

    it("places the backups line before the drive cards", async () => {
      stubDashboardFetch({ backups: [backupRow()] });
      renderDashboard();
      const card = await screen.findByRole("heading", { name: "Family photos" });
      const region = await screen.findByRole("region", { name: "Backups" });
      expect(region.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("shows a Member with their own healthy backup the same quiet line", async () => {
      stubDashboardFetch({
        username: "jamie",
        role: "user",
        userId: "u2",
        drives: [PHOTOS_DRIVE],
        access: [ROOT_GRANT],
        backups: [backupRow({ created_by: "u2" })],
      });
      renderDashboard();
      const region = await screen.findByRole("region", { name: "Backups" });
      expect(within(region).getByText("All backed up")).toBeInTheDocument();
      expect(within(region).getByRole("button", { name: "See all backups" })).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    });

    it("shows no backups region when there are no backups", async () => {
      const fetchMock = stubDashboardFetch({ backups: [] });
      renderDashboard();
      await screen.findByRole("link", { name: "Browse files" });
      await waitForRequests(fetchMock, ADMIN_REQUESTS);
      expect(screen.queryByRole("region", { name: "Backups" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "See all backups" })).not.toBeInTheDocument();
    });
  });

  describe("requests", () => {
    it("asks for each Admin dashboard request once, so Needs you and the cards share their data", async () => {
      const fetchMock = stubDashboardFetch({ backups: [backupRow()] });
      renderDashboard();
      await screen.findByText("30 GB free");
      const paths = [
        ...ADMIN_REQUESTS,
        "/api/v1/drives",
        "/api/v1/network/status",
        "/api/v1/connect/status",
        "/api/v1/cloud/phrase",
        "/api/v1/system/updates",
        "/api/v1/drives/d1/summary",
        "/api/v1/drives/d1/health",
      ];
      await waitForRequests(fetchMock, paths);
      // Give a late second request time to show up before counting.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      for (const path of paths) {
        expect({ path, count: requestCount(fetchMock, path) }).toEqual({ path, count: 1 });
      }
    });

    it("asks for each request of a Member's dashboard once and leaves out the Admin-only ones", async () => {
      const fetchMock = stubDashboardFetch({
        username: "jamie",
        role: "user",
        userId: "u2",
        drives: [PHOTOS_DRIVE],
        access: [ROOT_GRANT],
        backups: [backupRow({ created_by: "u2" })],
      });
      renderDashboard();
      await screen.findByRole("link", { name: "Browse files" });
      const paths = [...MEMBER_REQUESTS, "/api/v1/drives", "/api/v1/cloud/phrase", "/api/v1/drives/d1/summary"];
      await waitForRequests(fetchMock, paths);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      for (const path of paths) {
        expect({ path, count: requestCount(fetchMock, path) }).toEqual({ path, count: 1 });
      }
      for (const path of [
        "/api/v1/drives/detected",
        "/api/v1/network/status",
        "/api/v1/connect/status",
        "/api/v1/system/health/check",
        "/api/v1/system/updates",
        "/api/v1/drives/d1/health",
      ]) {
        expect(requestCount(fetchMock, path)).toBe(0);
      }
    });
  });
});
