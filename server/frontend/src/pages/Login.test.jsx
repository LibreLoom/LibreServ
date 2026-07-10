import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/test-utils";
import Login from "./Login";

vi.mock("../assets/greetings", () => ({
  login: ["Stay productive!"],
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    addToast: vi.fn(),
    dismissToast: vi.fn(),
    clearToasts: vi.fn(),
    toasts: [],
  }),
}));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe("Login", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
  });

  it("renders login form with username and password fields", () => {
    renderWithProviders(<Login />);

    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
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
    const loginFn = /** @type {any} */ (vi.fn()).mockResolvedValue(undefined);
    renderWithProviders(<Login />, { authOverrides: { login: loginFn } });

    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /login/i }));

    expect(loginFn).toHaveBeenCalledWith("admin", "hunter2");
  });

  it("shows 401 error message on auth failure", async () => {
    const user = userEvent.setup();
    const loginFn = /** @type {any} */ (vi.fn());
    loginFn.mockRejectedValue({ cause: { status: 401 } });
    renderWithProviders(<Login />, { authOverrides: { login: loginFn } });

    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: /login/i }));

    expect(
      await screen.findByText(/username or password might be incorrect/i),
    ).toBeInTheDocument();
  });

  it("shows 429 error message on rate limit", async () => {
    const user = userEvent.setup();
    const loginFn = /** @type {any} */ (vi.fn());
    loginFn.mockRejectedValue({ cause: { status: 429 } });
    renderWithProviders(<Login />, { authOverrides: { login: loginFn } });

    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "pass");
    await user.click(screen.getByRole("button", { name: /login/i }));

    expect(
      await screen.findByText(/wait a bit before trying again/i),
    ).toBeInTheDocument();
  });

  it("shows network error message on fetch failure", async () => {
    const user = userEvent.setup();
    const loginFn = /** @type {any} */ (vi.fn());
    loginFn.mockRejectedValue(new Error("down"));
    renderWithProviders(<Login />, { authOverrides: { login: loginFn } });

    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "pass");
    await user.click(screen.getByRole("button", { name: /login/i }));

    expect(
      await screen.findByText(/check your device's connection/i),
    ).toBeInTheDocument();
  });

  it("navigates to returnTo after successful login", async () => {
    const user = userEvent.setup();
    const loginFn = /** @type {any} */ (vi.fn()).mockResolvedValue({ status: "ok" });
    renderWithProviders(<Login returnTo="/setup" />, { authOverrides: { login: loginFn } });

    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /login/i }));

    await waitFor(() => expect(loginFn).toHaveBeenCalledWith("admin", "hunter2"));
    expect(mockNavigate).toHaveBeenCalledWith("/setup");
  });

  it("navigates to returnTo after MFA challenge success", async () => {
    const mfaToken = "mfa-token";
    const loginFn = /** @type {any} */ (vi.fn()).mockResolvedValue({
      status: "mfa_required",
      mfaToken,
      methods: [{ type: "totp", label: "Authenticator app" }],
    });
    const mfaVerifyFn = /** @type {any} */ (vi.fn()).mockResolvedValue();
    renderWithProviders(<Login returnTo="/setup" />, {
      authOverrides: { login: loginFn, mfaVerify: mfaVerifyFn },
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /login/i }));

    await waitFor(() =>
      expect(screen.getByText(/Authenticator app/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByText(/Authenticator app/i));
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/6-digit code/i)).toBeInTheDocument(),
    );

    await user.type(screen.getByPlaceholderText(/6-digit code/i), "123456");
    await user.click(screen.getByRole("button", { name: /Verify/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/setup"));
  });
});
