import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminTokensPage from "./AdminTokensPage.jsx";

const adminApiMock = vi.fn(async (path) => {
  if (path === "/admin/device-codes/dev_1/reveal") {
    return { device_uid: "7K4M-2Q9X-R8N3-6T5W-1PZH", verification_code: "A3F91C", code_hint: "7K4M-…" };
  }
  if (path.startsWith("/admin/device-codes")) {
    return {
      tokens: [
        {
          id: "dev_1",
          device_uid: "7K4M-2Q9X-R8N3-6T5W-1PZH",
          hint: "7K4M-…",
          // The list must not carry the Verification code; reveal is password-gated.
          can_reveal: true,
          device_code_prefix: "7K4M-…",
          kind: "official",
          status: "unbound",
          created_at: 1700000000,
          can_revoke: true,
        },
        {
          id: "dev_legacy",
          device_uid: "ABCD-EFGH-IJKM-NPQR-STUV",
          hint: "ABCD-…",
          can_reveal: false,
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

  it("shows device identities, search, pagination and mint controls", async () => {
    render(
      <MemoryRouter>
        <AdminTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-layout")).toBeTruthy();
    expect(screen.getByTestId("device-tokens-table")).toBeTruthy();
    expect(screen.getByText(/Create one for a retail box or support/i)).toBeTruthy();
    expect(screen.getByText(/Device ID and Verification code separated by a space/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /New identity/i })).toBeTruthy();
    expect(screen.getByTestId("bulk-tokens")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create list/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download TOKENS/i })).toBeTruthy();
    expect(screen.getByLabelText(/Search devices/i)).toBeTruthy();
    expect(screen.getByTestId("pagination-controls")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Previous page/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Next page/i })).toBeTruthy();
    expect(await screen.findByText("7K4M-2Q9X-R8N3-6T5W-1PZH")).toBeTruthy();
    expect(screen.getByText(/Showing 1–2 of 2 devices/i)).toBeTruthy();
  });

  it("shows both values from a newly minted identity", async () => {
    render(<MemoryRouter><AdminTokensPage /></MemoryRouter>);
    await screen.findByText("7K4M-2Q9X-R8N3-6T5W-1PZH");
    adminApiMock.mockResolvedValueOnce({
      device_uid: "1234-5678-9ABC-DEFG-HJKM",
      verification_code: "B4E82D",
    });
    fireEvent.click(screen.getByRole("button", { name: /New identity/i }));
    expect(await screen.findByText("1234-5678-9ABC-DEFG-HJKM")).toBeTruthy();
    expect(screen.getByText("B4E82D")).toBeTruthy();
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

  it("reveals password-protected pairing details and hides them again", async () => {
    render(
      <MemoryRouter>
        <AdminTokensPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("7K4M-2Q9X-R8N3-6T5W-1PZH")).toBeTruthy();
    expect(screen.queryByText("A3F91C")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show pairing details/i }));
    expect(adminApiMock.mock.calls.some(([path]) => path === "/admin/device-codes/dev_1/reveal")).toBe(false);
    fireEvent.change(screen.getByLabelText("Staff password"), { target: { value: "staff-password" } });
    fireEvent.click(screen.getByRole("button", { name: /^Reveal details$/i }));
    expect(await screen.findByText("A3F91C")).toBeTruthy();
    expect(adminApiMock).toHaveBeenCalledWith("/admin/device-codes/dev_1/reveal", {
      method: "POST",
      body: JSON.stringify({ password: "staff-password" }),
      cache: "no-store",
    });
    fireEvent.click(screen.getByRole("button", { name: /Hide pairing details/i }));
    expect(screen.getByText("7K4M-2Q9X-R8N3-6T5W-1PZH")).toBeTruthy();
    expect(screen.queryByText("A3F91C")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show pairing details/i }));
    expect(screen.getByLabelText("Staff password").value).toBe("");
  });
});
