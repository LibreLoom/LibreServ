import { useContext } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, navigateMock, setApiCsrfTokenMock, routerState } = vi.hoisted(
  () => ({
    apiMock: vi.fn(),
    navigateMock: vi.fn(),
    setApiCsrfTokenMock: vi.fn(),
    routerState: { pathname: "/" },
  }),
);

vi.mock("../lib/api", () => ({
  default: apiMock,
  AuthError: class AuthError extends Error {},
  setCsrfToken: setApiCsrfTokenMock,
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => routerState,
}));

import { AuthProvider } from "./AuthContext.jsx";
import { AuthContext } from "./AuthContextContext.js";

const response = (data, ok = true) => ({
  ok,
  json: vi.fn().mockResolvedValue(data),
});

function renderAuth(queryClient = undefined) {
  const wrapper = ({ children }) => (
    <AuthProvider queryClient={queryClient}>{children}</AuthProvider>
  );
  return renderHook(() => useContext(AuthContext), { wrapper });
}

describe("AuthProvider", () => {
  beforeEach(() => {
    apiMock.mockReset();
    navigateMock.mockReset();
    setApiCsrfTokenMock.mockReset();
    routerState.pathname = "/";
  });

  it("hydrates the user and exposes authenticated operations", async () => {
    const queryClient = { invalidateQueries: vi.fn() };
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/setup/status") {
        return response({ setup_state: { status: "complete" } });
      }
      if (path === "/auth/me") {
        return response({ id: "user-1", username: "admin" });
      }
      if (path === "/auth/csrf") {
        return response({ csrf_token: "csrf-1" });
      }
      if (path === "/auth/login") {
        const body = JSON.parse(options.body);
        return response(
          body.username === "mfa"
            ? {
                status: "mfa_required",
                mfa_token: "mfa-token",
                methods: "invalid",
                email: "admin@example.test",
              }
            : { status: "ok" },
        );
      }
      return response({ accepted: true });
    });

    const { result } = renderAuth(queryClient);
    await waitFor(() => expect(result.current.initialized).toBe(true));
    expect(result.current.me).toEqual({ id: "user-1", username: "admin" });
    expect(result.current.csrfToken).toBe("csrf-1");
    expect(setApiCsrfTokenMock).toHaveBeenCalledWith("csrf-1");

    await expect(
      result.current.login("mfa", "password"),
    ).resolves.toEqual({
      status: "mfa_required",
      mfaToken: "mfa-token",
      methods: [],
      email: "admin@example.test",
    });

    await act(async () => {
      await expect(
        result.current.login("admin", "password"),
      ).resolves.toEqual({ status: "ok" });
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["user"],
    });

    await expect(
      result.current.mfaChallenge("mfa-token", "email"),
    ).resolves.toEqual({ accepted: true });
    expect(apiMock).toHaveBeenLastCalledWith("/auth/mfa/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfa_token: "mfa-token", type: "email" }),
      noRetry: true,
    });

    await act(async () => {
      await result.current.mfaVerify("mfa-token", "totp", { code: "123456" });
      await result.current.mfaRecover("mfa-token", "recovery-code");
    });
    expect(apiMock).toHaveBeenCalledWith(
      "/auth/mfa/verify",
      expect.objectContaining({ noRetry: true }),
    );
    expect(apiMock).toHaveBeenCalledWith(
      "/auth/mfa/recover",
      expect.objectContaining({ noRetry: true }),
    );

    await act(async () => {
      await result.current.request("/settings", {
        method: "patch",
        headers: { "X-Test": "yes" },
      });
      await result.current.request("/health");
    });
    expect(apiMock).toHaveBeenCalledWith("/settings", {
      method: "PATCH",
      headers: {
        "X-Test": "yes",
        "X-CSRF-Token": "csrf-1",
      },
    });
    expect(apiMock).toHaveBeenCalledWith("/health", {
      method: "GET",
      headers: {},
    });

    await act(async () => {
      await result.current.logout();
    });
    expect(apiMock).toHaveBeenCalledWith("/auth/logout", {
      method: "POST",
      headers: { "X-CSRF-Token": "csrf-1" },
    });
    expect(result.current.me).toBeNull();
    expect(result.current.csrfToken).toBeNull();
  });

  it.each(["/setup", "/login", "/reset-password", "/invite/token"])(
    "allows the public %s route while setup is incomplete",
    async (pathname) => {
      routerState.pathname = pathname;
      apiMock.mockImplementation(async (path) => {
        if (path === "/setup/status") {
          return response({ setup_state: { status: "incomplete" } });
        }
        if (path === "/auth/me") return response({ username: "guest" });
        return response({ csrf_token: "csrf" });
      });

      const { result } = renderAuth();
      await waitFor(() => expect(result.current.initialized).toBe(true));
      expect(navigateMock).not.toHaveBeenCalled();
    },
  );

  it("redirects private routes when setup is incomplete", async () => {
    apiMock.mockResolvedValue(
      response({ setup_state: { status: "incomplete" } }),
    );

    const { result } = renderAuth();
    await waitFor(() => expect(result.current.initialized).toBe(true));

    expect(navigateMock).toHaveBeenCalledWith("/setup");
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("initializes as signed out when startup requests fail", async () => {
    apiMock.mockRejectedValue(new Error("offline"));

    const { result } = renderAuth();
    await waitFor(() => expect(result.current.initialized).toBe(true));

    expect(result.current.me).toBeNull();
    expect(result.current.csrfToken).toBeNull();
  });

  it("refreshes user and CSRF state independently", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/setup/status") {
        return response({ setup_state: { status: "complete" } });
      }
      if (path === "/auth/me") return response({ username: "admin" });
      if (path === "/auth/csrf") return response({ csrf_token: "csrf" });
      return response({});
    });
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.initialized).toBe(true));

    apiMock.mockImplementation(async (path) => {
      if (path === "/auth/me") throw new Error("me failed");
      if (path === "/auth/csrf") throw new Error("csrf failed");
      return response({});
    });
    await act(async () => {
      await result.current.refreshAuth();
    });
    expect(result.current.me).toBeNull();
    expect(result.current.csrfToken).toBeNull();

    apiMock.mockImplementation(async (path) => {
      if (path === "/auth/me") return response({}, false);
      if (path === "/auth/csrf") return response({ csrf_token: "new-csrf" });
      return response({});
    });
    await act(async () => {
      await result.current.refreshAuth();
    });
    expect(result.current.me).toBeNull();
    expect(result.current.csrfToken).toBe("new-csrf");
  });

  it("falls back to refresh when MFA hydration requests reject", async () => {
    const queryClient = { invalidateQueries: vi.fn() };
    apiMock
      .mockResolvedValueOnce(response({ setup_state: { status: "complete" } }))
      .mockResolvedValueOnce(response({ username: "admin" }))
      .mockResolvedValueOnce(response({ csrf_token: "csrf" }));
    const { result } = renderAuth(queryClient);
    await waitFor(() => expect(result.current.initialized).toBe(true));

    apiMock
      .mockResolvedValueOnce(response({ verified: true }))
      .mockRejectedValueOnce(new Error("me failed"))
      .mockRejectedValueOnce(new Error("csrf failed"))
      .mockResolvedValueOnce(response({ username: "refreshed" }))
      .mockResolvedValueOnce(response({ csrf_token: "refreshed-csrf" }));

    await act(async () => {
      await result.current.mfaVerify("token", "email", { code: "123456" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(result.current.me).toEqual({ username: "refreshed" }),
    );
    expect(result.current.csrfToken).toBe("refreshed-csrf");
  });

  it("ignores malformed MFA hydration JSON and cleans up after failed logout", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/setup/status") {
        return response({ setup_state: { status: "complete" } });
      }
      if (path === "/auth/me") return response({ username: "admin" });
      if (path === "/auth/csrf") return response({ csrf_token: "csrf" });
      return response({});
    });
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.initialized).toBe(true));

    apiMock
      .mockResolvedValueOnce(response({ recovered: true }))
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockRejectedValue(new Error("bad me JSON")),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockRejectedValue(new Error("bad csrf JSON")),
      });
    await act(async () => {
      await result.current.mfaRecover("token", "code");
    });

    apiMock.mockRejectedValueOnce(new Error("logout failed"));
    await act(async () => {
      await result.current.logout();
    });
    expect(result.current.me).toBeNull();
    expect(result.current.csrfToken).toBeNull();
  });
});
