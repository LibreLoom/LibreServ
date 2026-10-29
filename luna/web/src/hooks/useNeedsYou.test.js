import { createElement } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import useNeedsYou from "./useNeedsYou.js";

const auth = vi.hoisted(() => ({ user: null }));

vi.mock("../context/AuthContext.jsx", () => ({
  useAuth: () => auth,
}));

const ADMIN = { id: "admin", role: "admin" };
const MEMBER = { id: "sam", role: "member" };

const DAY = 24 * 3600;
const GB = 1e9;
const now = () => Math.floor(Date.now() / 1000);

const DRIVE_OK = { id: "d1", label: "Photos", state: "as_is" };
const SUMMARY_ROOMY = { mounted: true, total_bytes: 64 * GB, free_bytes: 40 * GB };
const HEALTH_OK = {
  available: true,
  reason: null,
  verdict: "ok",
  overall: "passed",
  reallocated_sectors: 0,
  temperature_c: 31,
  temperature_max_c: 60,
  temperature_max_source: "typical",
  signals: [],
};
const HEALTH_WORN = {
  ...HEALTH_OK,
  verdict: "watch",
  reallocated_sectors: 3,
  temperature_c: 38,
  signals: [{ kind: "reallocated_sectors", level: "watch", value: 3, limit: 100 }],
};
const PHRASE_NOT_DUE = { set: true, set_at: 0, luna_id: "luna-1", signing_public: "", check_due: false };

/** The requests a Member makes. Admin-only requests must never be among them. */
const MEMBER_PATHS = ["/api/v1/backups", "/api/v1/cloud/backups", "/api/v1/cloud/phrase", "/api/v1/drives"];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A route that answers with the same body on every request. */
function answer(body, status = 200) {
  return () => jsonResponse(body, status);
}

/**
 * One backup as /api/v1/backups returns it. The hook builds the kind from which
 * list the row came from, so a drive backup is the default.
 */
function backup(overrides = {}) {
  return {
    id: "b1",
    kind: "drive",
    private: false,
    source_drive: "d1",
    source_drive_name: "Photos drive",
    source_path: "Photos",
    source_name: "Photos",
    target_drive: "d2",
    target_drive_name: "Backup drive",
    state: "ok",
    status: "active",
    stop_reason: "",
    last_ok_at: now() - 3600,
    last_error: "",
    hard: false,
    first_done: true,
    created_by: "admin",
    can_delete: true,
    ...overrides,
  };
}

/** One cloud backup as /api/v1/cloud/backups returns it. Healthy unless overridden. */
function cloudBackup(overrides = {}) {
  return backup({
    id: "c1",
    kind: "cloud",
    source_name: "Documents",
    source_path: "Documents",
    target_drive: undefined,
    target_drive_name: undefined,
    last_checked_at: now() - 3 * DAY,
    check_problem: "",
    source_missing: false,
    ...overrides,
  });
}

/** Every Admin request answers healthy unless a test overrides that route. */
function adminRoutes(overrides = {}) {
  return {
    "/api/v1/drives": answer([DRIVE_OK]),
    "/api/v1/drives/detected": answer([]),
    "/api/v1/network/status": answer({ has_default_route: true }),
    "/api/v1/connect/status": answer({ device_token_error: "" }),
    "/api/v1/system/health/check": answer({ checks: {} }),
    "/api/v1/drives/d1/summary": answer(SUMMARY_ROOMY),
    "/api/v1/drives/d1/health": answer(HEALTH_OK),
    "/api/v1/backups": answer([]),
    "/api/v1/cloud/backups": answer([]),
    "/api/v1/cloud/phrase": answer(PHRASE_NOT_DUE),
    ...overrides,
  };
}

/**
 * Stubs fetch by exact path. A route returns a Response (or a promise of one).
 * A path with no route answers 404 and is still recorded, so an unexpected request shows up in the calls.
 */
function stubFetch(routes) {
  const fetchMock = vi.fn(async (url) => {
    const route = routes[String(url)];
    if (!route) return jsonResponse({ error: "not found" }, 404);
    return route();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** @param {{ mock: { calls: any[][] } }} fetchMock */
function calledPaths(fetchMock) {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

let client;

function renderNeedsYou() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }) => createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useNeedsYou(), { wrapper });
}

const ids = (result) => result.current.items.map((item) => item.id);

/**
 * Waits until every request has answered and the answers have been rendered,
 * so an empty list cannot pass just because nothing has arrived yet.
 */
async function settle(result) {
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  auth.user = ADMIN;
});

describe("useNeedsYou for an Admin", () => {
  it("lists the urgent rows in urgency order", async () => {
    stubFetch(
      adminRoutes({
        "/api/v1/drives": answer([{ id: "d1", label: "Backup drive", state: "as_is", mounted: false }]),
        "/api/v1/backups": answer([backup({ id: "b1", state: "failing", last_error: "Disk full" })]),
        "/api/v1/connect/status": answer({ device_token_error: "Your device token was revoked." }),
        "/api/v1/network/status": answer({ has_default_route: false }),
        "/api/v1/drives/detected": answer([{ name: "sdb1", model: "USB", size_bytes: 1 }]),
      }),
    );

    const { result } = renderNeedsYou();

    await waitFor(() =>
      expect(ids(result)).toEqual(["drive-unopenable:d1", "backup:drive:b1", "device-token", "no-route"]),
    );
    expect(result.current.items.map((item) => item.rank)).toEqual([15, 40, 50, 60]);
    expect(result.current.items[0]).toMatchObject({
      tone: "problem",
      title: [{ name: "Backup drive" }, " can't be opened"],
      action: { label: "See what's wrong", href: "/files#drive-d1" },
    });
    expect(result.current.items[1]).toMatchObject({
      title: [{ name: "Photos" }, " backup didn't finish"],
      detail: ["Backup drive ", { name: "Backup drive" }, ": ", "Disk full"],
      action: { label: "Open", intent: "open-backup" },
    });
    expect(result.current.items[2]).toMatchObject({
      detail: "Your device token was revoked.",
      action: { label: "Change the device token", href: "/settings#about" },
    });
    expect(result.current.items[3]).toMatchObject({
      detail: "Check that your router or modem is online.",
      action: { label: "Open system checks", href: "/settings#about" },
    });
  });

  it("does not ask a drive Luna can't open for its summary or health", async () => {
    const fetchMock = stubFetch(
      adminRoutes({ "/api/v1/drives": answer([{ id: "d1", label: "Backup drive", state: "as_is", mounted: false }]) }),
    );

    const { result } = renderNeedsYou();

    await waitFor(() => expect(calledPaths(fetchMock)).toContain("/api/v1/network/status"));
    await settle(result);
    expect(calledPaths(fetchMock)).not.toContain("/api/v1/drives/d1/summary");
    expect(calledPaths(fetchMock)).not.toContain("/api/v1/drives/d1/health");
    expect(ids(result)).toEqual(["drive-unopenable:d1"]);
  });

  it("shows a drive-health row when the drive reports wear", async () => {
    stubFetch(adminRoutes({ "/api/v1/drives/d1/health": answer(HEALTH_WORN) }));

    const { result } = renderNeedsYou();

    await waitFor(() => expect(ids(result)).toEqual(["drive-health:d1"]));
    expect(result.current.items[0]).toMatchObject({
      rank: 70,
      tone: "warning",
      title: [{ name: "Photos" }, " is showing wear"],
      action: { label: "See what's wrong", href: "/files#drive-d1" },
    });
  });

  it("asks a read-only drive for its health but not one whose mount is gone", async () => {
    const fetchMock = stubFetch(
      adminRoutes({
        "/api/v1/drives": answer([
          { id: "d1", label: "Photos", state: "readonly" },
          { id: "d2", label: "Spare", state: "as_is", mounted: false },
        ]),
      }),
    );

    const { result } = renderNeedsYou();

    await waitFor(() => expect(calledPaths(fetchMock)).toContain("/api/v1/drives/d1/health"));
    await settle(result);
    expect(calledPaths(fetchMock)).not.toContain("/api/v1/drives/d2/health");
  });

  it("shows a drive-full row when less than a tenth of the drive is free", async () => {
    stubFetch(
      adminRoutes({
        "/api/v1/drives/d1/summary": answer({ mounted: true, total_bytes: 64 * GB, free_bytes: 5 * GB }),
      }),
    );

    const { result } = renderNeedsYou();

    await waitFor(() => expect(ids(result)).toEqual(["drive-full:d1"]));
    expect(result.current.items[0]).toMatchObject({
      rank: 80,
      title: [{ name: "Photos" }, " is almost full"],
      detail: "5.0 GB free of 64 GB",
      action: { label: "Browse files", href: "/files/d1" },
    });
  });

  it("does not flag a drive with exactly a tenth of its space free", async () => {
    const fetchMock = stubFetch(
      adminRoutes({
        "/api/v1/drives/d1/summary": answer({ mounted: true, total_bytes: 70 * GB, free_bytes: 7 * GB }),
      }),
    );

    const { result } = renderNeedsYou();

    await waitFor(() => expect(calledPaths(fetchMock)).toContain("/api/v1/drives/d1/summary"));
    await settle(result);
    expect(ids(result)).toEqual([]);
  });

  it("does not flag a drive whose size Luna cannot measure", async () => {
    const fetchMock = stubFetch(
      adminRoutes({
        "/api/v1/drives/d1/summary": answer({ mounted: false, total_bytes: 64 * GB, free_bytes: 1 * GB }),
      }),
    );

    const { result } = renderNeedsYou();

    await waitFor(() => expect(calledPaths(fetchMock)).toContain("/api/v1/drives/d1/summary"));
    await settle(result);
    expect(ids(result)).toEqual([]);
  });

  it("shows a failed system check, with its message", async () => {
    stubFetch(
      adminRoutes({
        "/api/v1/system/health/check": answer({
          checks: { disk_space: { status: "failed", message: "Low space", category: "storage" } },
        }),
      }),
    );

    const { result } = renderNeedsYou();

    await waitFor(() => expect(ids(result)).toEqual(["check:disk_space"]));
    expect(result.current.items[0]).toMatchObject({
      rank: 20,
      title: ["Luna's own storage"],
      detail: "Low space",
      action: { label: "Open system checks", href: "/settings#about" },
    });
  });

  it("treats a 403 from Connect as no Connect status, without an error", async () => {
    stubFetch(
      adminRoutes({
        "/api/v1/connect/status": answer({ error: "Forbidden" }, 403),
        "/api/v1/backups": answer([backup({ id: "b1", state: "failing" })]),
      }),
    );

    const { result } = renderNeedsYou();

    await waitFor(() => expect(client.getQueryState(["connect-status"])?.status).toBe("success"));
    expect(client.getQueryData(["connect-status"])).toBeNull();
    await settle(result);
    expect(ids(result)).toEqual(["backup:drive:b1"]);
  });

  it("keeps the other rows when Connect fails with a server error", async () => {
    stubFetch(
      adminRoutes({
        "/api/v1/connect/status": answer({ error: "down" }, 500),
        "/api/v1/backups": answer([backup({ id: "b1", state: "failing" })]),
      }),
    );

    const { result } = renderNeedsYou();

    await waitFor(() => expect(client.getQueryState(["connect-status"])?.status).toBe("error"));
    await settle(result);
    expect(ids(result)).toEqual(["backup:drive:b1"]);
  });

  it("shows a private backup only to the person who made it", async () => {
    stubFetch(
      adminRoutes({
        "/api/v1/backups": answer([
          backup({ id: "b-admin-private", private: true, state: "failing", created_by: "admin" }),
          backup({ id: "b-sam-private", private: true, state: "failing", created_by: "sam" }),
          backup({ id: "b-public", private: false, state: "failing", created_by: "sam" }),
        ]),
      }),
    );

    const { result } = renderNeedsYou();

    await waitFor(() => expect(ids(result)).toContain("backup:drive:b-public"));
    await settle(result);
    expect(ids(result)).toEqual(["backup:drive:b-admin-private", "backup:drive:b-public"]);
  });

  it("shows the no-drives row once the drive list has loaded, not before", async () => {
    /** @type {(response: Response) => void} */
    let answerDrives = () => {};
    const pendingDrives = new Promise((resolve) => {
      answerDrives = resolve;
    });
    stubFetch(adminRoutes({ "/api/v1/drives": () => pendingDrives }));

    const { result } = renderNeedsYou();

    expect(result.current.isLoading).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.isLoading).toBe(true);
    expect(ids(result)).not.toContain("no-drives");

    answerDrives(jsonResponse([]));

    await waitFor(() => expect(ids(result)).toEqual(["no-drives"]));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.items[0]).toMatchObject({
      rank: 100,
      tone: "info",
      title: ["No drives yet"],
      detail: "Plug a USB drive into Luna to get started.",
    });
    expect(result.current.items[0].action).toBeUndefined();
  });

  it("does not claim there are no drives when the drive list fails to load", async () => {
    stubFetch(adminRoutes({ "/api/v1/drives": answer({ error: "boom" }, 500) }));

    const { result } = renderNeedsYou();

    await waitFor(() => expect(client.getQueryState(["drives"])?.status).toBe("error"));
    await settle(result);
    expect(ids(result)).not.toContain("no-drives");
  });

  it("shows nothing when every check is healthy", async () => {
    const fetchMock = stubFetch(
      adminRoutes({
        "/api/v1/backups": answer([backup({ id: "b1" })]),
        "/api/v1/cloud/backups": answer([cloudBackup({ id: "c1" })]),
      }),
    );

    const { result } = renderNeedsYou();

    await waitFor(() => expect(calledPaths(fetchMock)).toEqual(expect.arrayContaining([
      "/api/v1/drives/d1/summary",
      "/api/v1/drives/d1/health",
      "/api/v1/system/health/check",
      "/api/v1/cloud/backups",
    ])));
    await settle(result);
    expect(ids(result)).toEqual([]);
  });

  it("still shows drive rows when the backup list fails", async () => {
    stubFetch(
      adminRoutes({
        "/api/v1/drives": answer([{ id: "d1", label: "Backup drive", state: "as_is", mounted: false }]),
        "/api/v1/backups": answer({ error: "down" }, 500),
      }),
    );

    const { result } = renderNeedsYou();

    await waitFor(() => expect(ids(result)).toEqual(["drive-unopenable:d1"]));
    await settle(result);
    expect(ids(result)).toEqual(["drive-unopenable:d1"]);
  });
});

describe("useNeedsYou for a Member", () => {
  it("asks only for the Member's own data and shows only their own failing backup", async () => {
    auth.user = MEMBER;
    const fetchMock = stubFetch({
      "/api/v1/drives": answer([DRIVE_OK, { id: "d2", label: "Family drive", state: "as_is", mounted: false }]),
      "/api/v1/backups": answer([
        backup({ id: "b-sam", state: "failing", last_error: "Disk full", created_by: "sam" }),
        backup({ id: "b-admin", state: "failing", created_by: "admin", private: false }),
      ]),
      "/api/v1/cloud/backups": answer([]),
      "/api/v1/cloud/phrase": answer(PHRASE_NOT_DUE),
    });

    const { result } = renderNeedsYou();

    await waitFor(() => expect(calledPaths(fetchMock)).toEqual(expect.arrayContaining(MEMBER_PATHS)));
    await settle(result);
    expect([...new Set(calledPaths(fetchMock))].sort()).toEqual([...MEMBER_PATHS].sort());
    expect(ids(result)).toEqual(["backup:drive:b-sam"]);
  });

  it("shows the recovery phrase reminder when they have a cloud backup of their own", async () => {
    auth.user = MEMBER;
    stubFetch({
      "/api/v1/drives": answer([]),
      "/api/v1/backups": answer([]),
      "/api/v1/cloud/backups": answer([cloudBackup({ id: "c-sam", created_by: "sam" })]),
      "/api/v1/cloud/phrase": answer({ ...PHRASE_NOT_DUE, check_due: true }),
    });

    const { result } = renderNeedsYou();

    await waitFor(() => expect(ids(result)).toEqual(["phrase-check"]));
    expect(result.current.items[0]).toMatchObject({
      rank: 90,
      tone: "info",
      title: ["Check your recovery phrase"],
      action: { label: "Check now", intent: "check-phrase" },
    });
  });

  it("shows nothing when none of their backups need a look", async () => {
    auth.user = MEMBER;
    stubFetch({
      "/api/v1/drives": answer([DRIVE_OK]),
      "/api/v1/backups": answer([backup({ id: "b-sam", created_by: "sam" })]),
      "/api/v1/cloud/backups": answer([]),
      "/api/v1/cloud/phrase": answer(PHRASE_NOT_DUE),
    });

    const { result } = renderNeedsYou();

    await settle(result);
    expect(ids(result)).toEqual([]);
  });
});

describe("useNeedsYou loading", () => {
  it("is loading first, then done once the drive and backup lists answer", async () => {
    stubFetch(adminRoutes());

    const { result } = renderNeedsYou();

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });
});
