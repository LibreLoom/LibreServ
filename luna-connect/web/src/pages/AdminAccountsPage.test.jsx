import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminAccountsPage from "./AdminAccountsPage.jsx";

vi.mock("../components/AdminLayout.jsx", () => ({
  AdminLayout: ({ children }) => <div data-testid="admin-layout">{children}</div>,
}));

vi.mock("../context/AdminAuthContext.jsx", () => ({
  useAdminAuth: () => ({
    account: { email: "admin@example.com" },
    logout: vi.fn(),
  }),
  adminApi: vi.fn(async (path) => {
    if (path === "/admin/accounts") {
      return {
        accounts: [{
          id: "acct_1",
          email: "user@example.com",
          device_count: 1,
          email_verified: true,
          has_card: false,
          billing_status: "none",
          created_at: 1700000000,
        }],
      };
    }
    if (path.startsWith("/admin/accounts/")) {
      return {
        id: "acct_1",
        email: "user@example.com",
        email_verified: true,
        has_card: false,
        billing_status: "none",
        created_at: 1700000000,
        devices: [{
          id: "dev_1",
          hint: "ABCD1234",
          kind: "official",
          status: "bound",
          device_hostname: "myluna.luna.servers.libreloom.org",
          online: true,
        }],
      };
    }
    return {};
  }),
}));

vi.mock("../context/ThemeContext.jsx", () => ({
  useTheme: () => ({ toggle: vi.fn() }),
}));

describe("AdminAccountsPage", () => {
  it("shows account list and detail panel when selected", async () => {
    render(
      <MemoryRouter>
        <AdminAccountsPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-layout")).toBeTruthy();
    expect(await screen.findByText("user@example.com")).toBeTruthy();
    const rows = screen.getAllByText("user@example.com");
    rows[0].click();
    expect(await screen.findByTestId("account-detail")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Mint replacement token/i })).toBeTruthy();
    expect(screen.getByText("myluna.luna.servers.libreloom.org")).toBeTruthy();
  });
});
