import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminAccountsPage from "./AdminAccountsPage.jsx";

const adminApiMock = vi.fn(async (path, opts) => {
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
        subdomain: "myluna",
        device_hostname: "myluna.luna.servers.libreloom.org",
        tunnel_id: "tnl_test",
        has_tunnel: true,
        online: true,
        last_seen_at: 1700000000,
      }],
    };
  }
  if (path === "/admin/devices/dev_1" && (!opts || opts.method !== "POST")) {
    return {
      id: "dev_1",
      tunnel_id: "tnl_test",
      account_email: "user@example.com",
      created_at: 1700000000,
      last_seen_at: 1700000000,
      online: true,
      hint: "…1234",
      code: "AAAA-BBBB-CCCC-DDDD-EEEE",
    };
  }
  if (path === "/admin/devices/dev_1/regenerate-tunnel") {
    return { hostname: "myluna.luna.servers.libreloom.org", regenerated: true };
  }
  if (path === "/admin/devices/dev_1/domain") {
    return { hostname: "newname.luna.servers.libreloom.org", subdomain: "newname" };
  }
  return {};
});

vi.mock("../components/AdminLayout.jsx", () => ({
  AdminLayout: ({ children }) => <div data-testid="admin-layout">{children}</div>,
}));

vi.mock("../context/AdminAuthContext.jsx", () => ({
  useAdminAuth: () => ({
    account: { email: "admin@example.com" },
    logout: vi.fn(),
  }),
  adminApi: (...args) => adminApiMock(...args),
}));

vi.mock("../context/ThemeContext.jsx", () => ({
  useTheme: () => ({ toggle: vi.fn() }),
}));

describe("AdminAccountsPage", () => {
  beforeEach(() => {
    adminApiMock.mockClear();
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

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
    expect(screen.getByText("myluna.luna.servers.libreloom.org")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
  });

  it("expands Luna details on View", async () => {
    render(
      <MemoryRouter>
        <AdminAccountsPage />
      </MemoryRouter>,
    );
    const rows = await screen.findAllByText("user@example.com");
    rows[0].click();
    await screen.findByTestId("luna-row-dev_1");
    fireEvent.click(screen.getByRole("button", { name: /^View$/i }));
    expect(await screen.findByTestId("luna-detail-dev_1")).toBeTruthy();
    expect(await screen.findByText("tnl_test")).toBeTruthy();
    expect(adminApiMock).toHaveBeenCalledWith("/admin/devices/dev_1");
    expect(screen.getByText("…1234")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Show full token/i }));
    expect(screen.getByText("AAAA-BBBB-CCCC-DDDD-EEEE")).toBeTruthy();
  });

  it("calls regenerate tunnel API after confirm", async () => {
    render(
      <MemoryRouter>
        <AdminAccountsPage />
      </MemoryRouter>,
    );
    const rows = await screen.findAllByText("user@example.com");
    rows[0].click();
    await screen.findByTestId("luna-row-dev_1");
    fireEvent.click(screen.getByRole("button", { name: /Regenerate connection/i }));
    await waitFor(() => {
      expect(adminApiMock).toHaveBeenCalledWith(
        "/admin/devices/dev_1/regenerate-tunnel",
        { method: "POST" },
      );
    });
  });

  it("calls domain rename API on save", async () => {
    render(
      <MemoryRouter>
        <AdminAccountsPage />
      </MemoryRouter>,
    );
    const rows = await screen.findAllByText("user@example.com");
    rows[0].click();
    await screen.findByTestId("luna-row-dev_1");
    const input = screen.getByLabelText("Subdomain");
    fireEvent.change(input, { target: { value: "newname" } });
    fireEvent.click(screen.getByRole("button", { name: /Save address/i }));
    await waitFor(() => {
      expect(adminApiMock).toHaveBeenCalledWith(
        "/admin/devices/dev_1/domain",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ subdomain: "newname" }),
        }),
      );
    });
  });
});
