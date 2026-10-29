import { createElement } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildBackupRows } from "../lib/backupRows.js";
import { PHRASE_QUERY_KEY } from "../lib/cloudPhrase.js";
import useBackupRows from "./useBackupRows.js";

const DAY = 24 * 3600;
const now = () => Math.floor(Date.now() / 1000);

const PHRASE = { set: true, set_at: 0, luna_id: "luna-1", signing_public: "", check_due: false };

const ROUTES = {
  backups: "/api/v1/backups",
  cloud: "/api/v1/cloud/backups",
  phrase: "/api/v1/cloud/phrase",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function backup(overrides = {}) {
  return {
    id: "b1",
    kind: "drive",
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
    created_by: "u1",
    can_delete: true,
    ...overrides,
  };
}

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

/**
 * Stubs fetch for the three routes.
 * opts.backups / cloud / phrase: response bodies (defaults: no backups, no cloud rows, phrase not due).
 * opts.hang: route names that never answer.
 * opts.fail: route names that answer with HTTP 500.
 */
function stubApi({ backups = [], cloud = [], phrase = PHRASE, hang = [], fail = [] } = {}) {
  const bodies = { backups, cloud, phrase };
  const fetchMock = vi.fn((url) => {
    const name = Object.keys(ROUTES).find((key) => String(url).endsWith(ROUTES[key]));
    if (!name) return Promise.resolve(jsonResponse({}, 404));
    if (hang.includes(name)) return new Promise(() => {});
    if (fail.includes(name)) return Promise.resolve(jsonResponse({ error: "down" }, 500));
    return Promise.resolve(jsonResponse(bodies[name]));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderBackupRows(client = newClient()) {
  const wrapper = ({ children }) => createElement(QueryClientProvider, { client }, children);
  return { client, ...renderHook(() => useBackupRows(), { wrapper }) };
}

describe("useBackupRows", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns drive and cloud backups as one list, most urgent first", async () => {
    const hardDrive = backup({ id: "b1", source_name: "Photos", hard: true, last_ok_at: now() - 3600 });
    const oldDrive = backup({ id: "b2", source_name: "Music", source_path: "Music", last_ok_at: now() - DAY });
    const cloudRow = cloudBackup({ id: "c1", source_name: "Documents", last_ok_at: now() - 3 * DAY });
    stubApi({ backups: [oldDrive, hardDrive], cloud: [cloudRow] });
    const { result } = renderBackupRows();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual(buildBackupRows([oldDrive, hardDrive], [cloudRow]));
    // A hard error comes first, then the oldest good copy: cloud (3 days) before drive (1 day).
    expect(result.current.rows.map((r) => [r.id, r.kind])).toEqual([
      ["b1", "drive"],
      ["c1", "cloud"],
      ["b2", "drive"],
    ]);
    expect(result.current.isError).toBe(false);
  });

  it("is loading, with no rows, until the backup lists arrive", () => {
    stubApi({ hang: ["backups", "cloud"] });
    const { result } = renderBackupRows();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.rows).toEqual([]);
    expect(result.current.isError).toBe(false);
  });

  it("keeps rows empty while the cloud list is still loading", async () => {
    stubApi({ backups: [backup()], hang: ["cloud"] });
    const { result, client } = renderBackupRows();
    await waitFor(() => expect(client.getQueryState(["backups"])?.status).toBe("success"));
    expect(client.getQueryData(["backups"])).toHaveLength(1);
    expect(result.current.rows).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it("returns no rows and no error when there are no backups at all", async () => {
    stubApi({ backups: [], cloud: [] });
    const { result } = renderBackupRows();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual([]);
    expect(result.current.isError).toBe(false);
  });

  it("reports an error and no rows when the drive backup list fails", async () => {
    stubApi({ backups: [backup()], cloud: [cloudBackup()], fail: ["backups"] });
    const { result } = renderBackupRows();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isError).toBe(true);
    expect(result.current.rows).toEqual([]);
  });

  it("still returns drive rows when the cloud list fails (Connect off)", async () => {
    const drive = backup({ state: "failing", last_error: "The backup drive is full." });
    stubApi({ backups: [drive], fail: ["cloud"] });
    const { result } = renderBackupRows();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual(buildBackupRows([drive], []));
    expect(result.current.rows.map((r) => r.kind)).toEqual(["drive"]);
    expect(result.current.isError).toBe(false);
  });

  it("returns the recovery phrase status once it loads", async () => {
    const status = { ...PHRASE, check_due: true };
    stubApi({ phrase: status });
    const { result } = renderBackupRows();
    await waitFor(() => expect(result.current.phrase).not.toBeNull());
    // The hook returns the normalized status: the reply's fields plus safe defaults for the rest.
    expect(result.current.phrase).toEqual({
      ...status,
      last_checked_at: 0,
      phrase_words: 0,
      resealing: false,
      old_phrase_copies: { count: 0, removed_at: 0 },
    });
  });

  it("returns a null phrase while it loads, and still loads the backups", async () => {
    stubApi({ backups: [backup()], hang: ["phrase"] });
    const { result } = renderBackupRows();
    expect(result.current.phrase).toBeNull();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.phrase).toBeNull();
  });

  it("returns a null phrase when the phrase request fails, without touching the rows", async () => {
    stubApi({ backups: [backup()], fail: ["phrase"] });
    const { result, client } = renderBackupRows();
    await waitFor(() => expect(client.getQueryState(PHRASE_QUERY_KEY)?.status).toBe("error"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.phrase).toBeNull();
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.isError).toBe(false);
  });

  it("keeps the same rows array across re-renders when the data is unchanged", async () => {
    stubApi({ backups: [backup()], cloud: [cloudBackup()] });
    const { result, rerender } = renderBackupRows();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const first = result.current.rows;
    rerender();
    expect(result.current.rows).toBe(first);
  });

  it("keeps the same rows array when a refetch returns the same lists", async () => {
    stubApi({ backups: [backup()], cloud: [cloudBackup()] });
    const { result, rerender, client } = renderBackupRows();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const first = result.current.rows;
    await client.refetchQueries({ queryKey: ["backups"] });
    await client.refetchQueries({ queryKey: ["cloud-backups"] });
    rerender();
    expect(result.current.rows).toBe(first);
  });

  it("uses lists already in the shared cache on the first render", () => {
    const client = newClient();
    const drive = backup();
    client.setQueryData(["backups"], [drive]);
    client.setQueryData(["cloud-backups"], []);
    stubApi({ backups: [drive], cloud: [] });
    const { result } = renderBackupRows(client);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.rows).toEqual(buildBackupRows([drive], []));
  });
});
