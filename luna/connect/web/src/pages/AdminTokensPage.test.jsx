import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminTokensPage from "./AdminTokensPage.jsx";

const adminApiMock = vi.fn(async (path) => {
  if (path.startsWith("/admin/setup-tokens")) {
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
      pagination: {
        total: 2,
        limit: 25,
        offset: 0,
        has_more: false,
      },
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

  it("shows device tokens table, search bar, pagination controls and mint controls", async () => {
    render(
      <MemoryRouter>
        <AdminTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-layout")).toBeTruthy();
    expect(screen.getByTestId("device-tokens-table")).toBeTruthy();
    expect(screen.getByText(/one-off token for support/i)).toBeTruthy();
    expect(screen.getByText(/put that file on the LUNAASSETS partition/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /New token/i })).toBeTruthy();
    expect(screen.getByTestId("bulk-tokens")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create list/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download TOKENS/i })).toBeTruthy();
    expect(screen.getByLabelText(/Search tokens/i)).toBeTruthy();
    expect(screen.getByTestId("pagination-controls")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Previous page/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Next page/i })).toBeTruthy();
    expect(await screen.findByText("…WXYZ")).toBeTruthy();
    expect(screen.getByText(/Showing 1–2 of 2 tokens/i)).toBeTruthy();
  });

  it("submits search query and clears search", async () => {
    render(
      <MemoryRouter>
        <AdminTokensPage />
      </MemoryRouter>,
    );
    await screen.findByText("…WXYZ");
    const searchInput = screen.getByLabelText(/Search tokens/i);
    fireEvent.change(searchInput, { target: { value: "mydevice" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/i }));

    await waitFor(() => {
      expect(adminApiMock).toHaveBeenCalledWith(
        expect.stringContaining("q=mydevice")
      );
    });

    const clearButton = screen.getByLabelText(/Clear search/i);
    fireEvent.click(clearButton);
    expect(searchInput.value).toBe("");
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
