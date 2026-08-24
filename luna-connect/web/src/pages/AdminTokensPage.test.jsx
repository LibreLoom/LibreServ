import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminTokensPage from "./AdminTokensPage.jsx";

vi.mock("../components/Layout.jsx", () => ({
  Layout: ({ children }) => <div>{children}</div>,
}));

describe("AdminTokensPage", () => {
  it("tells support how to replace a lost official booklet code", () => {
    render(<AdminTokensPage />);
    expect(screen.getByTestId("official-token-recovery")).toBeTruthy();
    expect(screen.getByText(/contact support and refer to their order id/i)).toBeTruthy();
    expect(screen.getByText(/setup-token on the installer USB/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /New token/i })).toBeTruthy();
  });
});
