import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { AuthContext } from "../context/AuthContextContext";
import { useAuth } from "./useAuth";

describe("useAuth", () => {
  it("returns context value when used within AuthProvider", () => {
    const mockAuth = {
      me: { username: "admin" },
      csrfToken: "token123",
      login: () => Promise.resolve(),
      logout: () => Promise.resolve(),
      request: () => Promise.resolve(),
      initialized: true,
    };

    const wrapper = ({ children }) => (
      <AuthContext.Provider value={mockAuth}>{children}</AuthContext.Provider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    expect(result.current).toEqual(mockAuth);
    expect(result.current.me.username).toBe("admin");
    expect(result.current.csrfToken).toBe("token123");
    expect(result.current.initialized).toBe(true);
  });

  it("throws when used outside AuthProvider", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    expect(() => renderHook(() => useAuth())).toThrow(
      "useAuth must be used within an AuthProvider",
    );

    consoleError.mockRestore();
  });
});
