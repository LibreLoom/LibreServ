import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminTokensPage from "./AdminTokensPage.jsx";

vi.mock("../context/AdminAuthContext.jsx", () => ({
  useAdminAuth: () => ({
    account: { email: "admin@example.com" },
    logout: vi.fn(),
  }),
  adminApi: vi.fn(),
}));

vi.mock("../context/ThemeContext.jsx", () => ({
  useTheme: () => ({ toggle: vi.fn() }),
}));

describe("AdminTokensPage", () => {
  it("tells support how to replace a lost official booklet code", () => {
    render(
      <MemoryRouter>
        <AdminTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("official-token-recovery")).toBeTruthy();
    expect(screen.getByText(/contact support and refer to their order id/i)).toBeTruthy();
    expect(screen.getByText(/TOKENS on the LUNAASSETS partition/i)).toBeTruthy();
    expect(screen.getByText(/one-shot setup-token file/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /New token/i })).toBeTruthy();
    expect(screen.getByTestId("bulk-tokens")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create list/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download TOKENS/i })).toBeTruthy();
  });
});
