import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/test-utils";
import Login from "./Login";

vi.mock("../assets/greetings", () => ({
  login: ["Stay productive!"],
}));

describe("Login", () => {
  it("renders login form with username and password fields", () => {
    renderWithProviders(<Login />);

    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /login/i }),
    ).toBeInTheDocument();
  });

  it("renders the greeting and quip", () => {
    renderWithProviders(<Login />);

    expect(
      screen.getByText("Hey there! Log in to continue."),
    ).toBeInTheDocument();
    expect(screen.getByText("Stay productive!")).toBeInTheDocument();
  });

  it("disables submit when fields are empty", async () => {
    const user = userEvent.setup();
    const loginFn = vi.fn();
    renderWithProviders(<Login />, { authOverrides: { login: loginFn } });

    await user.click(screen.getByRole("button", { name: /login/i }));
    expect(loginFn).not.toHaveBeenCalled();
  });

  it("calls login with credentials on submit", async () => {
    const user = userEvent.setup();
    const loginFn = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<Login />, { authOverrides: { login: loginFn } });

    await user.type(screen.getByLabelText(/username/i), "admin");
    await user.type(screen.getByLabelText(/password/i), "hunter2");
    await user.click(screen.getByRole("button", { name: /login/i }));

    expect(loginFn).toHaveBeenCalledWith("admin", "hunter2");
  });

  it("shows 401 error message on auth failure", async () => {
    const user = userEvent.setup();
    const loginFn = vi.fn().mockRejectedValue({
      cause: { status: 401 },
    });
    renderWithProviders(<Login />, { authOverrides: { login: loginFn } });

    await user.type(screen.getByLabelText(/username/i), "admin");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /login/i }));

    expect(
      await screen.findByText(/username or password might be incorrect/i),
    ).toBeInTheDocument();
  });

  it("shows 429 error message on rate limit", async () => {
    const user = userEvent.setup();
    const loginFn = vi.fn().mockRejectedValue({
      cause: { status: 429 },
    });
    renderWithProviders(<Login />, { authOverrides: { login: loginFn } });

    await user.type(screen.getByLabelText(/username/i), "admin");
    await user.type(screen.getByLabelText(/password/i), "pass");
    await user.click(screen.getByRole("button", { name: /login/i }));

    expect(
      await screen.findByText(/wait a bit before trying again/i),
    ).toBeInTheDocument();
  });

  it("shows network error message on fetch failure", async () => {
    const user = userEvent.setup();
    const loginFn = vi.fn().mockRejectedValue(new Error("down"));
    renderWithProviders(<Login />, { authOverrides: { login: loginFn } });

    await user.type(screen.getByLabelText(/username/i), "admin");
    await user.type(screen.getByLabelText(/password/i), "pass");
    await user.click(screen.getByRole("button", { name: /login/i }));

    expect(
      await screen.findByText(/check your device's connection/i),
    ).toBeInTheDocument();
  });
});
