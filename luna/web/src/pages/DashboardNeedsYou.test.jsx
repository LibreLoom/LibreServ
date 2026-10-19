import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  backupRow,
  cloudBackupRow,
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

/** Requests an Admin's dashboard makes before the Needs you zone is final. */
const ADMIN_QUERIES = [
  "/api/v1/drives",
  "/api/v1/drives/detected",
  "/api/v1/backups",
  "/api/v1/cloud/backups",
  "/api/v1/cloud/phrase",
  "/api/v1/system/health/check",
  "/api/v1/network/status",
  "/api/v1/connect/status",
];

/** Requests a Member's dashboard makes before the Needs you zone is final. */
const MEMBER_QUERIES = [
  "/api/v1/drives",
  "/api/v1/backups",
  "/api/v1/cloud/backups",
  "/api/v1/cloud/phrase",
  "/api/v1/me/access",
];

const DUE_PHRASE = { set: true, set_at: 0, luna_id: "luna-1", signing_public: "", check_due: true };
const FAMILY_PHOTOS = { id: "d1", label: "Family photos", state: "as_is", device: "sda1", fs_type: "exfat" };
const BACKUP_DRIVE_FAILED = { id: "d2", label: "Backup drive", state: "failed" };
const NEW_DRIVE = { name: "sdb", model: "SanDisk", size_bytes: 32_000_000_000 };
const FULL_SUMMARY = {
  d1: {
    id: "d1",
    mounted: true,
    total_bytes: 64_000_000_000,
    free_bytes: 5_000_000_000,
    used_bytes: 59_000_000_000,
    shortcuts: ["Photos"],
  },
};

/** The "Needs you" zone. Throws when the zone is not on the page. */
function needsYouZone() {
  return screen.getByRole("region", { name: "Needs you" });
}

/**
 * The header pill's "1 warning" text, skipping the hidden measuring copy the header renders
 * to size its items (that copy is aria-hidden).
 */
function visibleWarningPill() {
  return screen
    .queryAllByText("1 warning")
    .filter((element) => !element.closest('[aria-hidden="true"]'));
}

/** The pathname of every request the stub has answered so far. */
function requestedPaths(fetchMock) {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url), "http://localhost").pathname);
}

/**
 * Waits until the page has asked for each path, then lets the answers render.
 * A Needs you row appears only once its answer lands, so an absence check waits here first.
 * @param {import("vitest").Mock} fetchMock
 * @param {string[]} paths
 */
async function settle(fetchMock, paths) {
  await waitFor(() => {
    const seen = requestedPaths(fetchMock);
    for (const path of paths) expect(seen).toContain(path);
  });
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe("Needs you on the dashboard", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  describe("drives (Admin)", () => {
    it("shows a failed drive as a pill and a link to Drives", async () => {
      const fetchMock = stubDashboardFetch({ drives: [BACKUP_DRIVE_FAILED] });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("Backup drive")).toHaveAttribute("data-slot", "inline-pill");
      expect(within(row).getByText("ran into a problem")).toBeInTheDocument();
      expect(within(zone).getByRole("link", { name: "Open Drives" })).toHaveAttribute("href", "/drives");
    });

    it("says a drive with a worn spot is working, with a warning", async () => {
      const fetchMock = stubDashboardFetch({
        health: { d1: { available: true, overall: "passed", reallocated_sectors: 4 } },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("Family photos")).toHaveAttribute("data-slot", "inline-pill");
      expect(within(row).getByText("is working, with a warning")).toBeInTheDocument();
      expect(within(row).getByText(/repaired a few worn spots/)).toBeInTheDocument();
      expect(within(zone).getByRole("link", { name: "Open Drives" })).toHaveAttribute("href", "/drives");
    });

    it("says a drive whose health report failed needs attention", async () => {
      const fetchMock = stubDashboardFetch({
        health: { d1: { available: true, overall: "failed", reallocated_sectors: 0 } },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("Family photos")).toHaveAttribute("data-slot", "inline-pill");
      expect(within(row).getByText("needs attention")).toBeInTheDocument();
      expect(within(zone).getByRole("link", { name: "Open Drives" })).toHaveAttribute("href", "/drives");
    });

    it("makes no row for a healthy drive", async () => {
      const fetchMock = stubDashboardFetch();
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    });

    it("makes no row for a drive whose health is unavailable or still unknown", async () => {
      const fetchMock = stubDashboardFetch({
        drives: [FAMILY_PHOTOS, { id: "d3", label: "Music drive", state: "as_is" }],
        health: {
          d1: { available: false, overall: "failed", reallocated_sectors: 9 },
          d3: null,
        },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    });

    it("shows a drive that is almost full with its free space and a Browse files link", async () => {
      const fetchMock = stubDashboardFetch({ summaries: FULL_SUMMARY });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("Family photos")).toHaveAttribute("data-slot", "inline-pill");
      expect(within(row).getByText("is almost full")).toBeInTheDocument();
      expect(within(row).getByText("5.0 GB free of 64 GB")).toBeInTheDocument();
      expect(within(zone).getByRole("link", { name: "Browse files" })).toHaveAttribute("href", "/drives/d1");
    });

    it("makes no row for a drive with plenty of space", async () => {
      const fetchMock = stubDashboardFetch();
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    });

    it("says No drives yet with no button when nothing is added", async () => {
      const fetchMock = stubDashboardFetch({ drives: [] });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("No drives yet")).toBeInTheDocument();
      expect(within(row).getByText("Plug a USB drive into Luna to get started.")).toBeInTheDocument();
      expect(within(row).queryByRole("button")).not.toBeInTheDocument();
      expect(within(row).queryByRole("link")).not.toBeInTheDocument();
    });

    it("says nothing about drives while the drive list is still loading", async () => {
      const base = stubDashboardFetch({ drives: [] });
      const fetchMock = vi.fn(async (url, init) => {
        if (new URL(String(url), "http://localhost").pathname === "/api/v1/drives") {
          return new Promise(() => {});
        }
        return base(url, init);
      });
      vi.stubGlobal("fetch", fetchMock);
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES.filter((path) => path !== "/api/v1/drives"));
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
      expect(screen.queryByText("No drives yet")).not.toBeInTheDocument();
    });

    it("shows a New drive plugged in row whose button opens the drive picker", async () => {
      const fetchMock = stubDashboardFetch({ detected: [NEW_DRIVE] });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("New drive plugged in")).toBeInTheDocument();
      expect(within(row).getByText("Nothing on it changes until you confirm.")).toBeInTheDocument();
      await userEvent.click(within(row).getByRole("button", { name: "Add drive" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("New drive detected")).toBeInTheDocument();
      expect(within(dialog).getByText("SanDisk")).toBeInTheDocument();
    });
  });

  describe("system checks (Admin)", () => {
    it("lists a failed system check with its message and a link to system checks", async () => {
      const fetchMock = stubDashboardFetch({
        systemChecks: {
          checks: {
            disk_space: { status: "failed", message: "Low space on the Luna data drive.", category: "storage" },
          },
        },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("Storage space")).toBeInTheDocument();
      expect(within(row).getByText("Low space on the Luna data drive.")).toBeInTheDocument();
      expect(within(zone).getByRole("link", { name: "Open system checks" })).toHaveAttribute(
        "href",
        "/settings#about",
      );
    });

    it("makes no row for a warning check", async () => {
      const fetchMock = stubDashboardFetch({
        systemChecks: {
          checks: {
            clock: { status: "warning", message: "The clock is a few minutes behind.", category: "system" },
          },
        },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
      expect(visibleWarningPill()).toHaveLength(1);
    });

    it("keeps the failed check in Needs you and leaves only the warning in the header pill", async () => {
      const fetchMock = stubDashboardFetch({
        systemChecks: {
          checks: {
            disk_space: { status: "failed", message: "Low space on the Luna data drive.", category: "storage" },
            clock: { status: "warning", message: "The clock is a few minutes behind.", category: "system" },
          },
        },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      expect(visibleWarningPill()).toHaveLength(1);
      expect(visibleWarningPill()[0]).toHaveTextContent("1 warning");
      const zone = needsYouZone();
      const rows = within(zone).getAllByRole("listitem");
      expect(rows).toHaveLength(1);
      expect(within(rows[0]).getByText("Storage space")).toBeInTheDocument();
      expect(within(zone).queryByText("Clock")).not.toBeInTheDocument();
    });

    it("leaves out a failed backup check and a failed drive wear check, which have their own rows", async () => {
      const fetchMock = stubDashboardFetch({
        systemChecks: {
          checks: {
            protect_photos: {
              status: "failed",
              message: "The Photos copy is not running.",
              category: "backups",
            },
            drive_d1_smart: {
              status: "failed",
              message: "The drive reports wear.",
              category: "drives",
              details: { drive_label: "Family photos" },
            },
          },
        },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    });

    it("leaves out the network check while the no internet row covers it", async () => {
      const fetchMock = stubDashboardFetch({
        network: { ethernet_connected: true, has_default_route: false },
        systemChecks: {
          checks: {
            network: { status: "failed", message: "Luna can't see a network connection.", category: "network" },
          },
        },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      expect(within(zone).getAllByRole("listitem")).toHaveLength(1);
      expect(within(zone).getByText("Luna can't reach the internet")).toBeInTheDocument();
      expect(within(zone).queryByText("Network")).not.toBeInTheDocument();
    });

    it("shows the network check when the internet route is fine", async () => {
      const fetchMock = stubDashboardFetch({
        systemChecks: {
          checks: {
            network: { status: "failed", message: "Luna can't see a network connection.", category: "network" },
          },
        },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("Network")).toBeInTheDocument();
      expect(within(row).getByText("Luna can't see a network connection.")).toBeInTheDocument();
    });

    it("leaves out Luna Connect and remote access checks while the device token row covers them", async () => {
      const fetchMock = stubDashboardFetch({
        connect: { enabled: true, device_token_error: "The device token was not accepted." },
        systemChecks: {
          checks: {
            connect: { status: "failed", message: "Luna Connect can't be reached.", category: "network" },
            remote_access: { status: "failed", message: "Remote access is off.", category: "network" },
          },
        },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const rows = within(zone).getAllByRole("listitem");
      expect(rows).toHaveLength(1);
      expect(within(rows[0]).getByText("Luna Connect needs a new device token")).toBeInTheDocument();
      expect(within(zone).queryByText("Remote access")).not.toBeInTheDocument();
    });

    it("shows a failed Luna Connect check when no device token row is shown", async () => {
      const fetchMock = stubDashboardFetch({
        connect: { enabled: true },
        systemChecks: {
          checks: {
            connect: { status: "failed", message: "Luna Connect can't be reached.", category: "network" },
          },
        },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("Luna Connect")).toBeInTheDocument();
      expect(within(row).getByText("Luna Connect can't be reached.")).toBeInTheDocument();
      expect(within(zone).getByRole("link", { name: "Open system checks" })).toHaveAttribute(
        "href",
        "/settings#about",
      );
    });

    it("shows a failed save test on its own row only when the drive has no row of its own", async () => {
      const fetchMock = stubDashboardFetch({
        drives: [FAMILY_PHOTOS, BACKUP_DRIVE_FAILED],
        systemChecks: {
          checks: {
            drive_d1_read_write: {
              status: "failed",
              message: "Luna couldn't save a test file here.",
              category: "drives",
              details: { drive_label: "Family photos" },
            },
            drive_d2_read_write: {
              status: "failed",
              message: "Luna couldn't save a test file here.",
              category: "drives",
              details: { drive_label: "Backup drive" },
            },
          },
        },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const rows = within(zone).getAllByRole("listitem");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent("Backup drive ran into a problem");
      expect(within(rows[1]).getByText("Family photos — save test")).toBeInTheDocument();
      expect(within(rows[1]).getByRole("link", { name: "Open Drives" })).toHaveAttribute("href", "/drives");
    });
  });

  describe("backups", () => {
    it("lists a failing backup with its reason and opens its protect sheet", async () => {
      const fetchMock = stubDashboardFetch({
        backups: [backupRow({ state: "failing", last_error: "The backup drive is full." })],
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("Photos")).toHaveAttribute("data-slot", "inline-pill");
      expect(within(row).getByText("backup didn't finish")).toBeInTheDocument();
      expect(within(row).getByText("The backup drive is full.")).toBeInTheDocument();
      await userEvent.click(within(zone).getByRole("button", { name: "Open Photos backup" }));
      expect(screen.getByTestId("protect-sheet")).toHaveTextContent("d1:Photos");
    });

    it("lists a stale backup as not copied in a day", async () => {
      const fetchMock = stubDashboardFetch({ backups: [backupRow({ state: "stale" })] });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const row = within(needsYouZone()).getByRole("listitem");
      expect(within(row).getByText("Photos")).toHaveAttribute("data-slot", "inline-pill");
      expect(within(row).getByText("hasn't been copied in a day")).toBeInTheDocument();
    });

    it("never shows a stopped backup, even one that is failing", async () => {
      const fetchMock = stubDashboardFetch({
        backups: [backupRow({ status: "stopped", state: "failing", last_error: "old" })],
      });
      renderDashboard();
      await screen.findByText("All backed up");
      await settle(fetchMock, ADMIN_QUERIES);
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
      expect(screen.queryByText("old")).not.toBeInTheDocument();
    });

    it("lists a failing cloud backup with its reason", async () => {
      const fetchMock = stubDashboardFetch({
        cloudBackups: [cloudBackupRow({ state: "failing", last_error: "Cloud upload failed." })],
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("Documents")).toHaveAttribute("data-slot", "inline-pill");
      expect(within(row).getByText("backup didn't finish")).toBeInTheDocument();
      expect(within(row).getByText("Cloud upload failed.")).toBeInTheDocument();
      expect(within(zone).getByRole("button", { name: "Open Documents backup" })).toBeInTheDocument();
    });

    it("still shows drive backup rows when the cloud request fails", async () => {
      const base = stubDashboardFetch({
        backups: [backupRow({ state: "failing", last_error: "The backup drive is full." })],
      });
      const fetchMock = vi.fn(async (url, init) => {
        if (new URL(String(url), "http://localhost").pathname === "/api/v1/cloud/backups") {
          return jsonResponse({ error: "down" }, 500);
        }
        return base(url, init);
      });
      vi.stubGlobal("fetch", fetchMock);
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      expect(within(zone).getAllByRole("listitem")).toHaveLength(1);
      expect(within(zone).getByText("The backup drive is full.")).toBeInTheDocument();
    });

    it("shows the Show more button for more than five rows, and Show fewer after it", async () => {
      const backups = Array.from({ length: 7 }, (_, i) =>
        backupRow({
          id: `b${i + 1}`,
          source_name: `Folder ${i + 1}`,
          source_path: `Folder ${i + 1}`,
          state: "failing",
          last_error: "The backup drive is full.",
        }),
      );
      const fetchMock = stubDashboardFetch({ backups });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      expect(within(zone).getAllByRole("listitem")).toHaveLength(5);
      await userEvent.click(within(zone).getByRole("button", { name: "Show 2 more" }));
      expect(within(zone).getAllByRole("listitem")).toHaveLength(7);
      expect(within(zone).getByRole("button", { name: "Show fewer" })).toBeInTheDocument();
    });

    it("says All backed up on the quiet line, and See all backups opens the list", async () => {
      const fetchMock = stubDashboardFetch({ backups: [backupRow()] });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
      expect(screen.getByText("All backed up")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "See all backups" }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("hides a private backup another user made, and shows that user's ordinary backups", async () => {
      const fetchMock = stubDashboardFetch({
        backups: [
          backupRow({ private: true, created_by: "u2", state: "failing", last_error: "Private." }),
          backupRow({
            id: "b2",
            source_name: "Music",
            source_path: "Music",
            created_by: "u2",
            state: "failing",
            last_error: "The backup drive is full.",
          }),
        ],
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const rows = within(zone).getAllByRole("listitem");
      expect(rows).toHaveLength(1);
      expect(within(rows[0]).getByText("Music")).toBeInTheDocument();
      expect(within(zone).queryByText("Photos")).not.toBeInTheDocument();
      expect(screen.queryByText("Private.")).not.toBeInTheDocument();
    });

    it("has no Needs you zone and no All good text for a healthy Admin", async () => {
      const fetchMock = stubDashboardFetch();
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
      expect(screen.queryByText(/all good/i)).not.toBeInTheDocument();
    });

    it("does not remind about the recovery phrase when only drive backups exist", async () => {
      const fetchMock = stubDashboardFetch({ backups: [backupRow()], phrase: DUE_PHRASE });
      renderDashboard();
      await screen.findByText("All backed up");
      await settle(fetchMock, ADMIN_QUERIES);
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
      expect(screen.queryByText("Check your recovery phrase")).not.toBeInTheDocument();
    });
  });

  describe("recovery phrase (Admin)", () => {
    it("shows the recovery phrase reminder, and Check now opens the check until it is closed", async () => {
      const fetchMock = stubDashboardFetch({ cloudBackups: [cloudBackupRow()], phrase: DUE_PHRASE });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("Check your recovery phrase")).toBeInTheDocument();
      expect(
        within(row).getByText("It's been a while. Make sure your 12 words still open your cloud backups."),
      ).toBeInTheDocument();
      await userEvent.click(within(row).getByRole("button", { name: "Check now" }));
      expect(screen.getByTestId("phrase-check")).toHaveTextContent("luna-1");
      await userEvent.click(screen.getByRole("button", { name: "Close check" }));
      expect(screen.queryByTestId("phrase-check")).not.toBeInTheDocument();
    });
  });

  describe("device token and internet route (Admin)", () => {
    it("says Luna Connect needs a new device token, with the error and a link to About", async () => {
      const fetchMock = stubDashboardFetch({
        connect: { enabled: true, device_token_error: "The device token was not accepted." },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("Luna Connect needs a new device token")).toBeInTheDocument();
      expect(within(row).getByText("The device token was not accepted.")).toBeInTheDocument();
      expect(within(zone).getByRole("link", { name: "Change the device token" })).toHaveAttribute(
        "href",
        "/settings#about",
      );
    });

    it("makes no row and does not crash when Luna Connect answers 403", async () => {
      const fetchMock = stubDashboardFetch({ connect: 403 });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      expect(await screen.findByRole("heading", { name: "Drives" })).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    });

    it("says Luna can't reach the internet when the router or modem has no route", async () => {
      const fetchMock = stubDashboardFetch({
        network: { ethernet_connected: true, has_default_route: false },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      const zone = needsYouZone();
      const row = within(zone).getByRole("listitem");
      expect(within(row).getByText("Luna can't reach the internet")).toBeInTheDocument();
      expect(within(row).getByText("Check that your router or modem is online.")).toBeInTheDocument();
      expect(within(zone).getByRole("link", { name: "Open system checks" })).toHaveAttribute(
        "href",
        "/settings#about",
      );
    });

    it("makes no internet row when the route is fine", async () => {
      const fetchMock = stubDashboardFetch({
        network: { ethernet_connected: true, has_default_route: true },
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
      expect(screen.queryByText("Luna can't reach the internet")).not.toBeInTheDocument();
    });
  });

  describe("ordering and zone frame (Admin)", () => {
    it("orders rows by urgency: drive, backup, new drive, then the recovery phrase", async () => {
      const fetchMock = stubDashboardFetch({
        drives: [FAMILY_PHOTOS, BACKUP_DRIVE_FAILED],
        backups: [backupRow({ state: "failing", last_error: "The backup drive is full." })],
        detected: [NEW_DRIVE],
        cloudBackups: [cloudBackupRow()],
        phrase: DUE_PHRASE,
      });
      renderDashboard();
      await settle(fetchMock, ADMIN_QUERIES);
      await waitFor(() => expect(within(needsYouZone()).getAllByRole("listitem")).toHaveLength(4));
      const rows = within(needsYouZone()).getAllByRole("listitem");
      expect(rows[0]).toHaveTextContent("Backup drive ran into a problem");
      expect(rows[1]).toHaveTextContent("Photos backup didn't finish");
      expect(rows[2]).toHaveTextContent("New drive plugged in");
      expect(rows[3]).toHaveTextContent("Check your recovery phrase");
    });
  });

  describe("Member", () => {
    it("shows a Member only their own failing backup, and none of the Admin rows", async () => {
      const fetchMock = stubDashboardFetch({
        role: "user",
        userId: "u1",
        drives: [FAMILY_PHOTOS, BACKUP_DRIVE_FAILED],
        summaries: FULL_SUMMARY,
        backups: [
          backupRow({ state: "failing", last_error: "The backup drive is full." }),
          backupRow({
            id: "b2",
            source_name: "Music",
            source_path: "Music",
            created_by: "u2",
            state: "failing",
            last_error: "The backup drive is full.",
          }),
        ],
        systemChecks: {
          checks: {
            disk_space: { status: "failed", message: "Low space on the Luna data drive.", category: "storage" },
          },
        },
        connect: { enabled: true, device_token_error: "The device token was not accepted." },
        network: { ethernet_connected: true, has_default_route: false },
        detected: [NEW_DRIVE],
      });
      renderDashboard();
      await settle(fetchMock, MEMBER_QUERIES);
      const zone = needsYouZone();
      const rows = within(zone).getAllByRole("listitem");
      expect(rows).toHaveLength(1);
      expect(within(rows[0]).getByText("Photos")).toHaveAttribute("data-slot", "inline-pill");
      expect(within(rows[0]).getByText("backup didn't finish")).toBeInTheDocument();
      expect(within(zone).queryByText("Music")).not.toBeInTheDocument();
      expect(screen.queryByText("New drive plugged in")).not.toBeInTheDocument();
      expect(screen.queryByText("Open Drives")).not.toBeInTheDocument();
      expect(screen.queryByText(/almost full/)).not.toBeInTheDocument();
      expect(screen.queryByText(/internet/)).not.toBeInTheDocument();
      expect(screen.queryByText("Storage space")).not.toBeInTheDocument();
      expect(screen.queryByText("Luna Connect needs a new device token")).not.toBeInTheDocument();

      const paths = requestedPaths(fetchMock);
      expect(paths).not.toContain("/api/v1/drives/detected");
      expect(paths).not.toContain("/api/v1/network/status");
      expect(paths).not.toContain("/api/v1/connect/status");
      expect(paths).not.toContain("/api/v1/system/health/check");
      expect(paths.filter((path) => /^\/api\/v1\/drives\/[^/]+\/health$/.test(path))).toEqual([]);
    });

    it("shows a Member the recovery phrase reminder with their own cloud backup", async () => {
      const fetchMock = stubDashboardFetch({
        role: "user",
        cloudBackups: [cloudBackupRow()],
        phrase: DUE_PHRASE,
      });
      renderDashboard();
      await settle(fetchMock, MEMBER_QUERIES);
      const zone = needsYouZone();
      expect(within(zone).getByText("Check your recovery phrase")).toBeInTheDocument();
      expect(within(zone).getByRole("button", { name: "Check now" })).toBeInTheDocument();
    });

    it("has no Needs you zone for a Member with nothing to do", async () => {
      const fetchMock = stubDashboardFetch({ role: "user", backups: [backupRow()] });
      renderDashboard();
      await settle(fetchMock, MEMBER_QUERIES);
      expect(screen.getByRole("heading", { name: "Your folders" })).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    });
  });
});
