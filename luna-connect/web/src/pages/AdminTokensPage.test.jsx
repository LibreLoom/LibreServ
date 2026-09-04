import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminTokensPage from "./AdminTokensPage.jsx";

const adminApiMock = vi.fn(async (path) => {
  if (path === "/admin/setup-tokens" || path === "/admin/setup-tokens?all=1") {
    return {
      tokens: [
        {
          id: "dev_1",
          hint: "…WXYZ",
          code: "AAAA-BBBB-CCCC-DDDD-WXYZ",
          kind: "official",
          status: "unbound",
          created_at: 1700000000,
          can_revoke: true,
        },
        {
          id: "dev_legacy",
          hint: "…LEG1",
          kind: "official",
          status: "unbound",
          created_at: 1690000000,
          can_revoke: true,
        },
      ],
      limited: true,
    };
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

describe("AdminTokensPage", () => {
  beforeEach(() => {
    adminApiMock.mockClear();
  });

  it("shows device tokens table and mint controls", async () => {
    render(
      <MemoryRouter>
        <AdminTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-layout")).toBeTruthy();
    expect(screen.getByTestId("device-tokens-table")).toBeTruthy();
    expect(screen.getByText(/one-off code for support/i)).toBeTruthy();
    expect(screen.getByText(/put that file on the LUNAASSETS partition/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /New token/i })).toBeTruthy();
    expect(screen.getByTestId("bulk-tokens")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create list/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download TOKENS/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show all/i })).toBeTruthy();
    expect(await screen.findByText("…WXYZ")).toBeTruthy();
  });

  it("reveals the full sealed token and hides it again", async () => {
    render(
      <MemoryRouter>
        <AdminTokensPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("…WXYZ")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Show full token/i }));
    expect(screen.getByText("AAAA-BBBB-CCCC-DDDD-WXYZ")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Hide full token/i }));
    expect(screen.getByText("…WXYZ")).toBeTruthy();
    expect(screen.queryByText("AAAA-BBBB-CCCC-DDDD-WXYZ")).toBeNull();
  });
});
