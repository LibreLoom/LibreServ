import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminLayout } from "../components/AdminLayout.jsx";

vi.mock("../context/AdminAuthContext.jsx", () => ({
  useAdminAuth: () => ({
    account: { email: "admin@example.com", has_2fa: true },
    logout: vi.fn(),
  }),
}));

vi.mock("../context/ThemeContext.jsx", () => ({
  useTheme: () => ({ toggle: vi.fn() }),
}));

describe("AdminLayout", () => {
  it("renders Connect-style admin sidebar nav", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminLayout>
          <p>child</p>
        </AdminLayout>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-layout")).toBeTruthy();
    expect(screen.getByText("Admin")).toBeTruthy();
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.getByText("Devices")).toBeTruthy();
    expect(screen.getByText("Setup codes")).toBeTruthy();
    expect(screen.getByText("Accounts")).toBeTruthy();
    expect(screen.getByText("Security")).toBeTruthy();
    expect(screen.getByText("2FA enabled")).toBeTruthy();
    expect(screen.getByText("child")).toBeTruthy();
  });
});
