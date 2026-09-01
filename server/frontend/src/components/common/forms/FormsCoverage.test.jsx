import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { addToastMock, requestMock } = vi.hoisted(() => ({
  addToastMock: vi.fn(),
  requestMock: vi.fn(),
}));

vi.mock("../../../hooks/useAuth.jsx", () => ({
  useAuth: () => ({ request: requestMock }),
}));
vi.mock("../../../context/ToastContext.jsx", () => ({
  useToast: () => ({ addToast: addToastMock }),
}));
vi.mock("../Dropdown.jsx", () => ({
  default: ({ options, value, onChange }) => (
    <select
      aria-label="Role"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../../ui/Button.jsx", () => ({
  default: ({
    children,
    disabled,
    loading,
    onClick,
    type = "button",
  }) => (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {children}
    </button>
  ),
}));

import AddUserForm from "./AddUserForm.jsx";
import ChangeEmailForm from "./ChangeEmailForm.jsx";
import InviteUserForm from "./InviteUserForm.jsx";
import ResetPasswordForm from "./ResetPasswordForm.jsx";
import RoleChangeForm from "./RoleChangeForm.jsx";
import SetPasswordForm from "./SetPasswordForm.jsx";

const response = (data = {}) => ({
  ok: true,
  json: vi.fn().mockResolvedValue(data),
});

beforeEach(() => {
  addToastMock.mockReset();
  requestMock.mockReset();
  requestMock.mockResolvedValue(response({ id: "user-1" }));
});

describe("account form coverage", () => {
  it("validates and creates a user", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    render(<AddUserForm onSuccess={onSuccess} />);

    await user.click(screen.getByRole("button", { name: /Create User/ }));
    expect(screen.getByText("Username is required")).toBeVisible();
    expect(screen.getByText("Password must be at least 12 characters")).toBeVisible();

    await user.type(screen.getByLabelText(/Username/), "ada");
    await user.type(screen.getByLabelText(/Email/), "ada@example.test");
    const password = screen.getByLabelText(/^Password/);
    await user.type(password, "LongPassword123!");
    expect(screen.getByText("Strong")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveAttribute("type", "text");
    await user.selectOptions(screen.getByLabelText("Role"), "admin");
    await user.click(screen.getByRole("button", { name: /Create User/ }));

    expect(requestMock).toHaveBeenCalledWith(
      "/users",
      expect.objectContaining({
        body: JSON.stringify({
          username: "ada",
          email: "ada@example.test",
          password: "LongPassword123!",
          role: "admin",
        }),
      }),
    );
    expect(onSuccess).toHaveBeenCalledWith({ id: "user-1" });
  });

  it("maps create-user conflicts to the matching field", async () => {
    const user = userEvent.setup();
    const conflict = new Error("email already exists");
    conflict.cause = { status: 409 };
    requestMock.mockRejectedValue(conflict);
    render(<AddUserForm />);

    await user.type(screen.getByLabelText(/Username/), "ada");
    await user.type(screen.getByLabelText(/Email/), "ada@example.test");
    await user.type(screen.getByLabelText(/^Password/), "LongPassword123!");
    await user.click(screen.getByRole("button", { name: /Create User/ }));
    expect(await screen.findByText("Email is already in use")).toBeVisible();
  });

  it("sends invitations and reports API failures", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const { rerender } = render(<InviteUserForm onSuccess={onSuccess} />);

    await user.type(screen.getByLabelText(/^Email/), "lin@example.test");
    await user.selectOptions(screen.getByLabelText("Role"), "admin");
    await user.click(screen.getByRole("button", { name: /Send Invitation/ }));
    expect(requestMock).toHaveBeenCalledWith(
      "/users/invites",
      expect.objectContaining({
        body: JSON.stringify({
          email: "lin@example.test",
          role: "admin",
        }),
      }),
    );
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
    expect(onSuccess).toHaveBeenCalled();

    const badRequest = new Error("Email provider is missing");
    badRequest.cause = { status: 400 };
    requestMock.mockRejectedValue(badRequest);
    rerender(<InviteUserForm />);
    await user.type(screen.getByLabelText(/^Email/), "next@example.test");
    await user.click(screen.getByRole("button", { name: /Send Invitation/ }));
    expect(await screen.findByText("Email provider is missing")).toBeVisible();
  });

  it("changes an email and role", async () => {
    const user = userEvent.setup();
    const emailSuccess = vi.fn();
    const roleSuccess = vi.fn();
    const view = render(
      <ChangeEmailForm
        user={{ id: "one", username: "Ada", email: "old@example.test" }}
        onSuccess={emailSuccess}
        onCancel={() => {}}
      />,
    );

    const email = screen.getByLabelText("New Email");
    await user.clear(email);
    await user.type(email, "new@example.test");
    await user.click(screen.getByRole("button", { name: "Change Email" }));
    expect(emailSuccess).toHaveBeenCalledWith("new@example.test");
    view.unmount();

    render(
      <RoleChangeForm
        user={{ id: "one", username: "Ada", role: "user" }}
        onSuccess={roleSuccess}
        onCancel={() => {}}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Role"), "admin");
    await user.click(screen.getByRole("button", { name: "Change Role" }));
    expect(requestMock).toHaveBeenLastCalledWith(
      "/users/one",
      expect.objectContaining({
        body: JSON.stringify({ role: "admin" }),
      }),
    );
    expect(roleSuccess).toHaveBeenCalledWith("admin");
  });

  it("changes the current user's password", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    render(
      <ResetPasswordForm
        user={{ username: "Ada" }}
        onSuccess={onSuccess}
        onCancel={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    expect(screen.getByText("Current password is required")).toBeVisible();
    await user.type(
      screen.getByLabelText("Current Password"),
      "CurrentPassword123",
    );
    await user.type(
      screen.getByLabelText("New Password"),
      "NewLongPassword123",
    );
    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    expect(requestMock).toHaveBeenLastCalledWith(
      "/auth/change-password",
      expect.objectContaining({
        body: JSON.stringify({
          old_password: "CurrentPassword123",
          new_password: "NewLongPassword123",
        }),
      }),
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it("sets another user's password", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    render(
      <SetPasswordForm
        user={{ id: "two", username: "Lin" }}
        onSuccess={onSuccess}
        onCancel={() => {}}
      />,
    );

    await user.type(
      screen.getByLabelText("New Password"),
      "AnotherPassword123",
    );
    await user.type(screen.getByLabelText("Confirm Password"), "different");
    await user.click(screen.getByRole("button", { name: "Set Password" }));
    expect(screen.getByText("Passwords don't match")).toBeVisible();
    await user.clear(screen.getByLabelText("Confirm Password"));
    await user.type(
      screen.getByLabelText("Confirm Password"),
      "AnotherPassword123",
    );
    await user.click(screen.getByRole("button", { name: "Set Password" }));
    expect(requestMock).toHaveBeenLastCalledWith(
      "/users/two/password",
      expect.objectContaining({
        body: JSON.stringify({ new_password: "AnotherPassword123" }),
      }),
    );
    expect(onSuccess).toHaveBeenCalled();
  });
});
