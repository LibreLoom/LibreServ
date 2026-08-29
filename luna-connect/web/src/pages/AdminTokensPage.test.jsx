import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminTokensPage from "./AdminTokensPage.jsx";

vi.mock("../components/AdminLayout.jsx", () => ({
  AdminLayout: ({ children }) => <div data-testid="admin-layout">{children}</div>,
}));

vi.mock("../context/AdminAuthContext.jsx", () => ({
  useAdminAuth: () => ({
    account: { email: "admin@example.com" },
    logout: vi.fn(),
  }),
  adminApi: vi.fn(async (path) => {
    if (path === "/admin/setup-tokens") return { tokens: [] };
    return {};
  }),
}));

vi.mock("../context/ThemeContext.jsx", () => ({
  useTheme: () => ({ toggle: vi.fn() }),
}));

describe("AdminTokensPage", () => {
  it("shows issued codes table and mint controls", () => {
    render(
      <MemoryRouter>
        <AdminTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-layout")).toBeTruthy();
    expect(screen.getByTestId("setup-codes-table")).toBeTruthy();
    expect(screen.getByTestId("official-token-recovery")).toBeTruthy();
    expect(screen.getByText(/contact support and refer to their order id/i)).toBeTruthy();
    expect(screen.getByText(/TOKENS on the LUNAASSETS partition/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /New token/i })).toBeTruthy();
    expect(screen.getByTestId("bulk-tokens")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create list/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download TOKENS/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show all codes/i })).toBeTruthy();
  });
});
