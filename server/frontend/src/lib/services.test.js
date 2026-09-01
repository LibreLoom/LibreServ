import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("./api.js", () => ({ default: apiMock }));

import {
  ddnsForceUpdate,
  ddnsSetInterval,
  disableTunnel,
  enableTunnel,
  getCaddyfile,
  getCaddyStatus,
  getConnectivityStatus,
  getDDNSStatus,
  getNetworkPlans,
  getNetworkReport,
  getTunnelStatus,
  getUPnPStatus,
  listRoutes,
  testBackend,
} from "./network-api.js";
import {
  formatTimestamp,
  getEventTypeDisplayName,
  getSecurityEvents,
  getSecuritySettings,
  getSecurityStats,
  sendTestNotification,
  updateSecuritySettings,
} from "./security-api.js";
import {
  activateConnect,
  deactivateConnect,
  getConnectInfo,
  getConnectStatus,
  getConnectUsage,
  updateConnectService,
} from "./connect-api.js";
import {
  fetchAIModels,
  getAISettings,
  getSettings,
  updateAISettings,
  updateSettings,
} from "./settings-api.js";
import { formatBytes, formatRelativeTime } from "./backups-utils.js";
import {
  ERROR_REMEDIATIONS,
  getRemediations,
  summarizeError,
} from "./preflight-errors.js";
import { sanitizeURL, stripHTML } from "./sanitize.js";
import { formatDateLong, formatDateWithTime, formatTime } from "./time-utils.js";

const response = (data, ok = true) => ({
  ok,
  json: vi.fn().mockResolvedValue(data),
});

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue(response({ ok: true }));
});

describe("network API", () => {
  it("reads status, connectivity, mappings, DDNS, reports, and plans", async () => {
    const calls = [
      [getCaddyStatus, "/network/status"],
      [getConnectivityStatus, "/network/connectivity"],
      [getUPnPStatus, "/network/mappings/status"],
      [getDDNSStatus, "/network/ddns/status"],
      [getNetworkReport, "/network/report"],
      [getNetworkPlans, "/network/plans"],
    ];

    for (const [fn, path] of calls) {
      apiMock.mockResolvedValueOnce(response({ path }));
      await expect(fn()).resolves.toEqual({ path });
      expect(apiMock).toHaveBeenLastCalledWith(path);
    }
  });

  it("normalizes route and Caddyfile response shapes", async () => {
    apiMock
      .mockResolvedValueOnce(response(["one"]))
      .mockResolvedValueOnce(response({ routes: ["two"] }))
      .mockResolvedValueOnce(response({ routes: "bad" }))
      .mockResolvedValueOnce(response({ content: "example.test" }))
      .mockResolvedValueOnce(response({}));

    await expect(listRoutes()).resolves.toEqual(["one"]);
    await expect(listRoutes()).resolves.toEqual(["two"]);
    await expect(listRoutes()).resolves.toEqual([]);
    await expect(getCaddyfile()).resolves.toBe("example.test");
    await expect(getCaddyfile()).resolves.toBe("");
  });

  it("posts backend tests and DDNS actions", async () => {
    await testBackend("http://app:8080");
    expect(apiMock).toHaveBeenLastCalledWith("/network/test-backend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "http://app:8080" }),
    });

    await ddnsForceUpdate();
    expect(apiMock).toHaveBeenLastCalledWith("/network/ddns/update-now", {
      method: "POST",
    });

    await ddnsSetInterval(30);
    expect(apiMock).toHaveBeenLastCalledWith("/network/ddns/interval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interval_minutes: 30 }),
    });
  });

  it("handles unavailable and available tunnel status", async () => {
    apiMock.mockResolvedValueOnce(response({}, false));
    await expect(getTunnelStatus()).resolves.toEqual({
      enabled: false,
      available: false,
    });

    apiMock.mockResolvedValueOnce(response({ enabled: true }));
    await expect(getTunnelStatus()).resolves.toEqual({ enabled: true });
  });

  it("enables and disables tunnels", async () => {
    await enableTunnel("cloudflare", "secret");
    expect(apiMock).toHaveBeenLastCalledWith("/network/tunnel/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "cloudflare", token: "secret" }),
    });

    await disableTunnel();
    expect(apiMock).toHaveBeenLastCalledWith("/network/tunnel/disable", {
      method: "POST",
    });
  });
});

describe("security API", () => {
  it("builds event and stats filters", async () => {
    await getSecurityEvents({
      limit: 5,
      since: "2026-01-01",
      type: "login_failed",
      severity: "warning",
    });
    expect(apiMock).toHaveBeenLastCalledWith(
      "/security/events?limit=5&since=2026-01-01&type=login_failed&severity=warning",
    );

    await getSecurityEvents();
    expect(apiMock).toHaveBeenLastCalledWith("/security/events");

    await getSecurityStats({ since: "2026-02-01" });
    expect(apiMock).toHaveBeenLastCalledWith(
      "/security/stats?since=2026-02-01",
    );
    await getSecurityStats();
    expect(apiMock).toHaveBeenLastCalledWith("/security/stats");
  });

  it("gets and updates settings with optional CSRF", async () => {
    await getSecuritySettings();
    expect(apiMock).toHaveBeenLastCalledWith("/settings/security");

    await updateSecuritySettings({ alerts: true }, "csrf");
    expect(apiMock).toHaveBeenLastCalledWith("/settings/security", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": "csrf",
      },
      body: JSON.stringify({ alerts: true }),
    });

    await updateSecuritySettings({ alerts: false });
    expect(apiMock.mock.lastCall[1].headers).toEqual({
      "Content-Type": "application/json",
    });

    await sendTestNotification("csrf");
    expect(apiMock.mock.lastCall[1].headers).toEqual({
      "X-CSRF-Token": "csrf",
    });
    await sendTestNotification();
    expect(apiMock.mock.lastCall[1].headers).toEqual({});
  });

  it("maps known event names and humanizes unknown names", () => {
    expect(getEventTypeDisplayName("login_success")).toBe("Successful Login");
    expect(getEventTypeDisplayName("token_reuse")).toBe(
      "Suspicious Token Activity",
    );
    expect(getEventTypeDisplayName("new_event_name")).toBe("new event name");
  });

  it("formats recent and older timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));

    expect(formatTimestamp("2026-08-31T11:59:40Z")).toBe("Just now");
    expect(formatTimestamp("2026-08-31T11:58:00Z")).toBe("2 minutes ago");
    expect(formatTimestamp("2026-08-31T11:59:00Z")).toBe("1 minute ago");
    expect(formatTimestamp("2026-08-31T10:00:00Z")).toBe("2 hours ago");
    expect(formatTimestamp("2026-08-31T11:00:00Z")).toBe("1 hour ago");
    expect(formatTimestamp("2026-08-29T12:00:00Z")).toBe("2 days ago");
    expect(formatTimestamp("2026-08-30T12:00:00Z")).toBe("1 day ago");
    expect(formatTimestamp("2025-01-01T12:00:00Z", true)).toMatch(
      /Jan 1, 2025/,
    );

    vi.useRealTimers();
  });
});

describe("Connect and settings APIs", () => {
  it("calls every Connect endpoint", async () => {
    await getConnectStatus();
    expect(apiMock).toHaveBeenLastCalledWith("/connect/status");
    await getConnectUsage();
    expect(apiMock).toHaveBeenLastCalledWith("/connect/usage");
    await getConnectInfo();
    expect(apiMock).toHaveBeenLastCalledWith("/connect/info");

    await activateConnect("key", "csrf");
    expect(apiMock).toHaveBeenLastCalledWith("/connect/activate", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": "csrf",
      },
      body: JSON.stringify({ connect_key: "key" }),
    });
    await deactivateConnect("csrf");
    expect(apiMock).toHaveBeenLastCalledWith("/connect/deactivate", {
      method: "POST",
      headers: { "X-CSRF-Token": "csrf" },
    });
    await updateConnectService("backup", "enabled", "csrf");
    expect(apiMock.mock.lastCall[1].body).toBe(
      JSON.stringify({ service: "backup", state: "enabled" }),
    );
  });

  it("gets and updates general and AI settings", async () => {
    await getSettings();
    expect(apiMock).toHaveBeenLastCalledWith("/settings");
    await getAISettings();
    expect(apiMock).toHaveBeenLastCalledWith("/settings/ai-support");

    await updateSettings({ name: "LibreServ" }, "csrf");
    expect(apiMock.mock.lastCall[1].headers["X-CSRF-Token"]).toBe("csrf");
    await updateSettings({}, undefined);
    expect(apiMock.mock.lastCall[1].headers).toEqual({
      "Content-Type": "application/json",
    });

    await updateAISettings({ enabled: true }, "csrf");
    expect(apiMock.mock.lastCall[1].body).toBe(
      JSON.stringify({ enabled: true }),
    );
    await updateAISettings({}, undefined);
    expect(apiMock.mock.lastCall[1].headers).toEqual({
      "Content-Type": "application/json",
    });

    await fetchAIModels("https://ai.example", "key", "csrf", "anthropic");
    expect(apiMock).toHaveBeenLastCalledWith(
      "/settings/ai-support/models",
      expect.objectContaining({
        body: JSON.stringify({
          base_url: "https://ai.example",
          api_key: "key",
          api_format: "anthropic",
        }),
      }),
    );
    await fetchAIModels("https://ai.example", "", undefined);
    expect(apiMock.mock.lastCall[1].body).toContain('"api_format":"openai"');
  });
});

describe("formatting, remediation, and sanitization utilities", () => {
  it("formats byte counts", () => {
    expect(formatBytes(0)).toBe("-");
    expect(formatBytes(512)).toBe("512.0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });

  it("formats relative times across every unit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));

    expect(formatRelativeTime()).toBe("Never");
    expect(formatRelativeTime("bad")).toBe("Never");
    expect(formatRelativeTime("2026-08-31T11:59:30Z")).toBe("1 minute ago");
    expect(formatRelativeTime("2026-08-31T10:00:00Z")).toBe("2 hours ago");
    expect(formatRelativeTime("2026-08-30T12:00:00Z")).toBe("1 day ago");
    expect(formatRelativeTime("2026-10-31T12:00:00Z")).toBe("in 2 months");

    vi.useRealTimers();
  });

  it("finds unique remediations for failed checks", () => {
    expect(getRemediations(null)).toEqual([]);
    expect(getRemediations([])).toEqual([]);
    expect(getRemediations([["ok", { status: "ok" }]])).toEqual([]);

    const remediations = getRemediations([
      ["storage", { status: "error", error: "permission denied" }],
      ["disk", { status: "error", error: "no space left" }],
      ["runtime", { status: "error", error: "Podman daemon stopped" }],
      ["database", { status: "error", error: "SQLite migration failed" }],
      ["network", { status: "error", error: "connection timeout" }],
      ["duplicate", { status: "error", error: "forbidden" }],
    ]);
    expect(remediations.map(({ id }) => id)).toEqual(
      ERROR_REMEDIATIONS.map(({ id }) => id),
    );
  });

  it("summarizes backend errors", () => {
    expect(summarizeError("")).toBe("");
    expect(summarizeError("Failed to connect")).toBe("connect");
    expect(summarizeError("Cannot open the database\nstack trace")).toBe(
      "open the database",
    );
    expect(
      summarizeError(
        "Unable to process this exceptionally lengthy message because the service is unavailable",
      ),
    ).toBe("process this exceptionally lengthy message...");
    expect(
      summarizeError(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOQRSTUVWXYZ0123456789",
      ),
    ).toBe("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOQRSTUV...");
  });

  it("escapes HTML text and validates URL schemes", () => {
    expect(stripHTML(null)).toBe("");
    expect(stripHTML("<img src=x onerror=alert(1)>")).toBe(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(sanitizeURL(null)).toBe("");
    expect(sanitizeURL("https://example.test/path")).toBe(
      "https://example.test/path",
    );
    expect(sanitizeURL("/relative")).toBe("/relative");
    expect(sanitizeURL("mailto:user@example.test")).toBe(
      "mailto:user@example.test",
    );
    expect(sanitizeURL("javascript:alert(1)")).toBe("");
    expect(sanitizeURL("http://[invalid")).toBe("");
  });

  it("formats valid and invalid dates", () => {
    const date = new Date("2026-08-31T15:45:00Z");
    expect(formatTime("bad")).toBe("-");
    expect(formatTime(date)).toMatch(/15:45/);
    expect(formatTime(date, true)).toMatch(/03:45 PM/);
    expect(formatDateWithTime()).toBe("-");
    expect(formatDateWithTime("bad")).toBe("-");
    expect(formatDateWithTime(date)).toMatch(/31 Aug 2026 15:45/);
    expect(formatDateLong()).toBe("Unknown");
    expect(formatDateLong("bad")).toBe("Unknown");
    expect(formatDateLong(date, true)).toMatch(/31 August 2026 03:45 PM/);
  });
});
