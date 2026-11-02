import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RequireAdmin from "./RequireAdmin.jsx";

let role = "user";
vi.mock("../../context/AuthContext", () => ({ useAuth: () => ({ user: { role } }) }));

describe("RequireAdmin", () => {
  it("tells a Member the page is for Admins, in plain words", () => {
    role = "user";
    render(<RequireAdmin><div>SECRET</div></RequireAdmin>);
    expect(
      screen.getByText("This page is only for Admins. Members can only edit their own user settings."),
    ).toBeInTheDocument();
    expect(screen.queryByText("SECRET")).not.toBeInTheDocument();
  });

  it("shows the page to an Admin", () => {
    role = "admin";
    render(<RequireAdmin><div>SECRET</div></RequireAdmin>);
    expect(screen.getByText("SECRET")).toBeInTheDocument();
  });
});
