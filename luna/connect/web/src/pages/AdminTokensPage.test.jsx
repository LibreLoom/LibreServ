import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminTokensPage from "./AdminTokensPage.jsx";

const adminApiMock = vi.fn(async (path) => {
  if (path.startsWith("/admin/device-codes")) {
    return {
      tokens: [
        {
          id: "dev_1",
          // The list carries only a short hint and the order reference; the token is never returned.
          hint: "7K4M-…",
          order_ref: "ORDER-1001",
          kind: "official",
          status: "unbound",
          created_at: 1700000000,
          can_revoke: true,
        },
        {
          id: "dev_2",
          hint: "ABCD-…",
          order_ref: "",
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

  it("shows device tokens, search, pagination and mint controls", async () => {
    render(
      <MemoryRouter>
        <AdminTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-layout")).toBeTruthy();
    expect(screen.getByTestId("device-tokens-table")).toBeTruthy();
    expect(screen.getByText(/Each token is shown once/i)).toBeTruthy();
    expect(screen.getByText(/Each TOKENS line is one device token/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /New token/i })).toBeTruthy();
    expect(screen.getByTestId("bulk-tokens")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create list/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download TOKENS/i })).toBeTruthy();
    expect(screen.getByLabelText(/Search devices/i)).toBeTruthy();
    expect(screen.getByTestId("pagination-controls")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Previous page/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Next page/i })).toBeTruthy();
    expect(await screen.findByText("7K4M-…")).toBeTruthy();
    expect(screen.getByText("ORDER-1001")).toBeTruthy();
    expect(screen.queryByText(/Show pairing details|Verification code|Device ID/i)).toBeNull();
    expect(screen.getByText(/Showing 1–2 of 2 devices/i)).toBeTruthy();
  });

  it("shows a newly minted token once, with no way to reveal it later", async () => {
    render(<MemoryRouter><AdminTokensPage /></MemoryRouter>);
    await screen.findByText("7K4M-…");
    adminApiMock.mockResolvedValueOnce({ device_token: "12345678-9ABC-DEFG-HJKM".replace(/-/g, "").slice(0, 20) });
    fireEvent.click(screen.getByRole("button", { name: /New token/i }));
    expect(await screen.findByText("1234-5678-9ABC-DEFG-HJKM")).toBeTruthy();
    expect(screen.getByText(/cannot show this token again/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy device token/i })).toBeTruthy();
    expect(adminApiMock.mock.calls.some(([path]) => String(path).includes("reveal"))).toBe(false);
  });

  it("sends the order reference when minting and shows a bulk list once", async () => {
    render(<MemoryRouter><AdminTokensPage /></MemoryRouter>);
    await screen.findByText("7K4M-…");
    fireEvent.change(screen.getByLabelText(/Order reference/i, { selector: "#order-ref" }), { target: { value: "ORDER-7" } });
    adminApiMock.mockResolvedValueOnce({ device_token: "7K4M2Q9XR8N36T5W1PZH" });
    fireEvent.click(screen.getByRole("button", { name: /New token/i }));
    await screen.findByTestId("token-reveal");
    expect(adminApiMock).toHaveBeenCalledWith("/admin/device-codes", {
      method: "POST",
      body: JSON.stringify({ order_ref: "ORDER-7" }),
      cache: "no-store",
    });

    adminApiMock.mockResolvedValueOnce({ tokens: ["7K4M2Q9XR8N36T5W1PZH", "ABCDEFGHJKMNPQRSTVWX"] });
    fireEvent.click(screen.getByRole("button", { name: /Create list/i }));
    expect(await screen.findByText(/2 Lunas/)).toBeTruthy();
  });

  it("submits search query and clears search", async () => {
    render(
      <MemoryRouter>
        <AdminTokensPage />
      </MemoryRouter>,
    );
    await screen.findByText("7K4M-2Q9X-R8N3-6T5W-1PZH");
    const searchInput = screen.getByLabelText(/Search devices/i);
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
});
