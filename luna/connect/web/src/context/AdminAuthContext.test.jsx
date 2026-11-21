import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminAuthProvider, adminApi, useAdminAuth } from "./AdminAuthContext.jsx";

function jsonResponse(status, body) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

function Probe({ onReady }) {
  const auth = useAdminAuth();
  onReady(auth);
  return (
    <p>
      {auth.ready ? "ready" : "waiting"} {auth.isAuthenticated ? "signed-in" : "signed-out"} {auth.account?.email || ""}
    </p>
  );
}

function renderAt(path) {
  let latest;
  render(
    <MemoryRouter initialEntries={[path]}>
      <AdminAuthProvider>
        <Probe onReady={(a) => (latest = a)} />
      </AdminAuthProvider>
    </MemoryRouter>,
  );
  return () => latest;
}

describe("AdminAuthContext", () => {
  let setItem;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    setItem = vi.spyOn(globalThis.localStorage, "setItem");
    document.cookie = "luna_connect_csrf=csrf-abc; path=/";
  });

  afterEach(() => {
    setItem.mockRestore();
    document.cookie = "luna_connect_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });

  it("asks /admin/me with cookies on an admin page and signs in from the answer", async () => {
    globalThis.fetch.mockResolvedValue(jsonResponse(200, { id: "admin_1", email: "staff@example.com", name: "", has_2fa: true }));
    renderAt("/admin");
    expect(await screen.findByText(/ready signed-in staff@example\.com/)).toBeTruthy();
    const [path, init] = globalThis.fetch.mock.calls[0];
    expect(path).toBe("/admin/me");
    expect(init.credentials).toBe("include");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("treats a 401 from /admin/me as signed out", async () => {
    globalThis.fetch.mockResolvedValue(jsonResponse(401, { message: "Admin sign-in required." }));
    renderAt("/admin/login");
    expect(await screen.findByText(/ready signed-out/)).toBeTruthy();
  });

  it("does not ask about staff sign-in on customer pages", async () => {
    renderAt("/login");
    await act(async () => {});
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("signs in and out through the cookie without storing a token", async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonResponse(401, {}));
    const auth = renderAt("/admin/login");
    await screen.findByText(/ready signed-out/);

    globalThis.fetch.mockResolvedValueOnce(jsonResponse(200, { id: "admin_1", email: "staff@example.com", name: "", has_2fa: false }));
    await act(async () => {
      await auth().login("staff@example.com", "password1234", "");
    });
    expect(screen.getByText(/signed-in staff@example\.com/)).toBeTruthy();
    const [loginPath, loginInit] = globalThis.fetch.mock.calls[1];
    expect(loginPath).toBe("/admin/login");
    expect(loginInit.credentials).toBe("include");
    expect(loginInit.headers["X-CSRF-Token"]).toBe("csrf-abc");

    globalThis.fetch.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await act(async () => {
      await auth().logout();
    });
    await waitFor(() => expect(screen.getByText(/signed-out/)).toBeTruthy());
    const [logoutPath, logoutInit] = globalThis.fetch.mock.calls[2];
    expect(logoutPath).toBe("/admin/logout");
    expect(logoutInit.method).toBe("POST");
    expect(logoutInit.headers["X-CSRF-Token"]).toBe("csrf-abc");

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem("luna-connect-admin-token")).toBeNull();
  });

  it("clears a staff token an earlier build left in page storage", async () => {
    localStorage.setItem("luna-connect-admin-token", "old-session");
    localStorage.setItem("luna-connect-admin-account", "{}");
    globalThis.fetch.mockResolvedValue(jsonResponse(401, {}));
    renderAt("/admin/login");
    await screen.findByText(/ready signed-out/);
    expect(localStorage.getItem("luna-connect-admin-token")).toBeNull();
    expect(localStorage.getItem("luna-connect-admin-account")).toBeNull();
  });
});

describe("adminApi", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    document.cookie = "luna_connect_csrf=csrf-xyz; path=/";
  });

  it("sends the CSRF token on writes but not on reads, and never a bearer", async () => {
    await adminApi("/admin/stats");
    await adminApi("/admin/admins", { method: "POST", body: "{}", credentials: "omit" });
    const [, getInit] = globalThis.fetch.mock.calls[0];
    const [, postInit] = globalThis.fetch.mock.calls[1];
    expect(getInit.headers["X-CSRF-Token"]).toBeUndefined();
    expect(postInit.headers["X-CSRF-Token"]).toBe("csrf-xyz");
    expect(postInit.credentials).toBe("include");
    expect(getInit.headers.Authorization).toBeUndefined();
    expect(postInit.headers.Authorization).toBeUndefined();
  });
});
