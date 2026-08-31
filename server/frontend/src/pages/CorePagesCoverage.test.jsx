import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
  api: vi.fn(),
  auth: {
    me: { id: "member-1", username: "Ada", email: "ada@example.test", role: "user" },
    request: vi.fn(),
  },
  location: { pathname: "/missing", search: "", hash: "" },
  navigate: vi.fn(),
  params: { userId: "user-2" },
  search: "",
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const original = /** @type {Record<string, any>} */ (await importOriginal());
  return {
    ...original,
    Link: ({ children, to, ...props }) => (
      <a href={typeof to === "string" ? to : "#"} {...props}>
        {children}
      </a>
    ),
    useLocation: () => testState.location,
    useNavigate: () => testState.navigate,
    useParams: () => testState.params,
    useSearchParams: () => [new URLSearchParams(testState.search)],
  };
});

vi.mock("../lib/api", () => ({ default: testState.api }));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => testState.auth,
}));
vi.mock("../hooks/useTimeFormat", () => ({
  useTimeFormat: () => ({
    formatDateLong: (value) => `long:${value}`,
    use12HourTime: false,
  }),
}));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ addToast: testState.addToast }),
}));

vi.mock("../components/ui/Page", () => ({
  default: ({ children, leftContent, rightContent, title }) => (
    <main id="main-content" tabIndex={-1}>
      {title && (
        <header>
          {leftContent}
          <h1>{title}</h1>
          {rightContent}
        </header>
      )}
      {children}
    </main>
  ),
}));
vi.mock("../components/cards/Card", () => ({
  default: ({ children, title }) => (
    <section>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  ),
}));
vi.mock("../components/cards/HeaderCard", () => ({
  default: ({ leftContent, rightContent, title }) => (
    <header>
      {leftContent}
      <h1>{title}</h1>
      {rightContent}
    </header>
  ),
}));
vi.mock("../components/cards/MetricCard", () => ({
  default: ({ children, label, value }) => (
    <div>
      <span>{label}</span>
      <span>{value}</span>
      {children}
    </div>
  ),
}));
vi.mock("../components/ui/Button", () => ({
  default: ({
    asChild,
    children,
    disabled,
    loading,
    onClick,
    type = "button",
    ...props
  }) =>
    asChild ? (
      children
    ) : (
      <button
        type={/** @type {"button" | "reset" | "submit"} */ (type)}
        disabled={disabled || loading}
        onClick={onClick}
        aria-label={props["aria-label"]}
      >
        {children}
      </button>
    ),
}));
vi.mock("../components/common/Pill", () => ({
  default: ({ children }) => <span>{children}</span>,
}));
vi.mock("../components/common/ValueDisplay", () => ({
  default: ({ label, value }) => (
    <div>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  ),
}));
vi.mock("../components/cards/StateOverlay", () => ({
  default: ({ children, message }) => <div>{message || children}</div>,
}));
vi.mock("../components/common/EmptyState", () => ({
  default: ({ description, title }) => (
    <div>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  ),
}));
vi.mock("../components/common/Table", () => ({
  default: ({ columns, data, onRowClick, rowKey }) => (
    <div>
      {data.map((row, rowIndex) => (
        <div key={row[rowKey] ?? rowIndex}>
          {columns.map((column) => (
            <span key={column.key}>
              {column.render ? column.render(row, rowIndex) : row[column.key]}
            </span>
          ))}
          <button type="button" onClick={() => onRowClick?.(row, rowIndex)}>
            Open {row.username}
          </button>
        </div>
      ))}
    </div>
  ),
}));
vi.mock("../components/cards/ConfirmModal", () => ({
  default: ({ confirmLabel = "Confirm", message, onClose, onConfirm, open, title }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <p>{message}</p>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));
vi.mock("../components/cards/ModalCard", () => ({
  default: ({ children, onClose, title }) => (
    <div role="dialog" aria-label={title}>
      <button type="button" onClick={onClose}>
        Close
      </button>
      {typeof children === "function" ? children({ close: onClose }) : children}
    </div>
  ),
}));
vi.mock("../components/common/forms/FormInput", () => ({
  default: ({ error, label, name, onChange, type = "text", value }) => (
    <label>
      {label}
      <input aria-label={label} name={name} type={type} value={value} onChange={onChange} />
      {error && <span>{error}</span>}
    </label>
  ),
}));
vi.mock("../components/common/Alert", () => ({
  default: ({ message }) => <div role="alert">{message}</div>,
}));
vi.mock("../components/profile/MfaCard", () => ({
  default: () => <div>MFA settings</div>,
}));
vi.mock("../components/profile/ApiTokensCard", () => ({
  default: () => <div>API tokens</div>,
}));
vi.mock("../components/common/forms/ChangeEmailForm", () => ({
  default: ({ onSuccess }) => (
    <button type="button" onClick={() => onSuccess("changed@example.test")}>
      Apply email
    </button>
  ),
}));
vi.mock("../components/common/forms/RoleChangeForm", () => ({
  default: ({ onSuccess }) => (
    <button type="button" onClick={() => onSuccess("admin")}>
      Apply role
    </button>
  ),
}));
vi.mock("../components/common/forms/SetPasswordForm", () => ({
  default: ({ onSuccess }) => (
    <button type="button" onClick={onSuccess}>
      Apply password
    </button>
  ),
}));
vi.mock("./ObjectNotFound", () => ({
  default: ({ objectLabel, objectName }) => (
    <div>
      Missing {objectLabel}: {objectName}
    </div>
  ),
}));

import MyProfile from "./MyProfile";
import NotFoundPage from "./NotFoundPage";
import ResetPassword from "./ResetPassword";
import UserDetailPage from "./UserDetailPage";
import UsersPage from "./UsersPage";

const response = (data, ok = true) => ({
  ok,
  json: vi.fn().mockResolvedValue(data),
});

beforeEach(() => {
  testState.addToast.mockReset();
  testState.api.mockReset();
  testState.auth.me = {
    id: "member-1",
    username: "Ada",
    email: "ada@example.test",
    role: "user",
  };
  testState.auth.request.mockReset();
  testState.auth.request.mockResolvedValue(response({}));
  testState.location = { pathname: "/missing", search: "", hash: "" };
  testState.navigate.mockReset();
  testState.params = { userId: "user-2" };
  testState.search = "";
});

describe("NotFoundPage", () => {
  it("suggests a close route, expands details, and navigates back", async () => {
    const user = userEvent.setup();
    testState.location = {
      pathname: "/appps/",
      search: "?from=test",
      hash: "#lost",
    };

    render(<NotFoundPage />);

    expect(screen.getByText("/appps?from=test#lost")).toBeVisible();
    expect(screen.getByText("Did you mean…")).toBeVisible();
    expect(document.title).toBe("404 — Page Not Found · LibreServ");
    await user.click(
      screen.getByRole("button", {
        name: /Highly Scientific Investigation/,
      }),
    );
    expect(screen.getByText(/Close-Enough-O-Meter/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect(testState.navigate).toHaveBeenCalled();
  });

  it("renders without a page shell when embedded", () => {
    render(<NotFoundPage includeMain={false} />);
    expect(screen.getByRole("region", { name: "Page Not Found" })).toHaveAttribute(
      "data-slot",
      "not-found",
    );
  });
});

describe("ResetPassword", () => {
  it("explains a missing or invalid token", async () => {
    const user = userEvent.setup();
    render(<ResetPassword />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Missing reset token",
    );
    await user.click(screen.getByRole("button", { name: "Back to Login" }));
    expect(testState.navigate).toHaveBeenCalledWith("/login");
  });

  it("validates the passwords and confirms a valid reset", async () => {
    const user = userEvent.setup();
    testState.search = "token=reset-token";
    testState.api.mockImplementation(async (path) => {
      if (path === "/auth/password-reset/validate") {
        return response({ valid: true });
      }
      return response({});
    });

    render(<ResetPassword />);
    const password = await screen.findByLabelText("New Password");
    const confirmation = screen.getByLabelText("Confirm Password");

    await user.type(password, "abcdefgh");
    await user.type(confirmation, "different");
    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Passwords don't match");

    await user.clear(password);
    await user.clear(confirmation);
    await user.type(password, "short");
    await user.type(confirmation, "short");
    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Password must be at least 8 characters",
    );

    await user.clear(password);
    await user.clear(confirmation);
    await user.type(password, "new-password");
    await user.type(confirmation, "new-password");
    await user.click(screen.getByRole("button", { name: "Reset Password" }));

    expect(
      await screen.findByText(/Password reset successfully! Redirecting/),
    ).toBeVisible();
    expect(testState.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("reports validation and confirmation failures", async () => {
    testState.search = "token=bad-token";
    testState.api.mockResolvedValue(response({ valid: false }));
    const { unmount } = render(<ResetPassword />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "invalid or has expired",
    );
    unmount();

    testState.api.mockRejectedValue(new Error("offline"));
    render(<ResetPassword />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to validate reset link",
    );
  });
});

describe("MyProfile", () => {
  it("updates the email and password", async () => {
    const user = userEvent.setup();
    render(<MyProfile />);

    const email = screen.getByLabelText("Email (optional)");
    await user.clear(email);
    await user.type(email, "new@example.test");
    await user.click(screen.getByRole("button", { name: "Save Email" }));

    await user.type(
      screen.getByLabelText("Current Password"),
      "OldPassword123",
    );
    await user.type(
      screen.getByLabelText("New Password"),
      "NewPassword123",
    );
    await user.click(screen.getByRole("button", { name: "Change Password" }));

    expect(testState.auth.request).toHaveBeenCalledWith(
      "/auth/profile",
      expect.objectContaining({
        body: JSON.stringify({ email: "new@example.test" }),
      }),
    );
    expect(testState.auth.request).toHaveBeenCalledWith(
      "/auth/change-password",
      expect.objectContaining({
        body: JSON.stringify({
          old_password: "OldPassword123",
          new_password: "NewPassword123",
        }),
      }),
    );
    expect(testState.addToast).toHaveBeenCalledTimes(2);
  });

  it("shows local validation and API errors", async () => {
    const user = userEvent.setup();
    testState.auth.request.mockImplementation(async (path) => {
      const error = /** @type {any} */ (new Error("already used"));
      error.cause = { status: path === "/auth/profile" ? 409 : 401 };
      throw error;
    });
    render(<MyProfile />);

    const email = screen.getByLabelText("Email (optional)");
    await user.clear(email);
    await user.type(email, "used@example.test");
    await user.click(screen.getByRole("button", { name: "Save Email" }));
    expect(await screen.findByText("Email is already in use")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Change Password" }));
    expect(screen.getByText("Current password is required")).toBeVisible();
    expect(
      screen.getByText("Password must be at least 12 characters"),
    ).toBeVisible();

    await user.type(screen.getByLabelText("Current Password"), "wrong");
    await user.type(
      screen.getByLabelText("New Password"),
      "ValidPassword123",
    );
    await user.click(screen.getByRole("button", { name: "Change Password" }));
    expect(
      await screen.findByText("Current password is incorrect"),
    ).toBeVisible();
  });
});

describe("UsersPage", () => {
  it("shows the current user's profile to non-admins", () => {
    render(<UsersPage />);
    expect(screen.getByRole("heading", { name: "My Account" })).toBeVisible();
    expect(screen.getByText("API tokens")).toBeVisible();
  });

  it("lists, opens, and deletes users for an admin", async () => {
    const user = userEvent.setup();
    testState.auth.me = {
      id: "admin-1",
      username: "Admin",
      email: "admin@example.test",
      role: "admin",
    };
    testState.api.mockImplementation(async (path) => {
      if (path === "/users") {
        return response({
          data: [
            {
              id: "user-2",
              username: "Lin",
              email: "lin@example.test",
              role: "user",
              last_login: new Date().toISOString(),
            },
          ],
        });
      }
      if (path === "/auth/csrf") return response({ csrf_token: "csrf" });
      return response({});
    });

    render(<UsersPage />);
    expect(await screen.findByText("lin@example.test")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Open Lin" }));
    expect(testState.navigate).toHaveBeenCalledWith("/users/user-2");
    await user.click(screen.getByRole("button", { name: "Delete Lin" }));
    const dialog = screen.getByRole("dialog", { name: "Delete User" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByText("lin@example.test")).not.toBeInTheDocument(),
    );
    expect(testState.api).toHaveBeenCalledWith(
      "/users/user-2",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("renders empty and failed list states", async () => {
    testState.auth.me = {
      id: "admin-1",
      username: "Admin",
      email: "admin@example.test",
      role: "admin",
    };
    testState.api.mockResolvedValue(response({ data: [] }));
    const { unmount } = render(<UsersPage />);
    expect(await screen.findByText("No people yet")).toBeVisible();
    unmount();

    testState.api.mockRejectedValue(new Error("Users unavailable"));
    render(<UsersPage />);
    expect(await screen.findByText("Error: Users unavailable")).toBeVisible();
  });
});

describe("UserDetailPage", () => {
  const detailedUser = {
    id: "user-2",
    username: "Lin",
    email: "lin@example.test",
    role: "user",
    created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    updated_at: new Date().toISOString(),
    last_login: new Date().toISOString(),
  };

  it("renders details and completes account actions", async () => {
    const user = userEvent.setup();
    testState.auth.me = {
      id: "admin-1",
      username: "Admin",
      email: "admin@example.test",
      role: "admin",
    };
    testState.api.mockImplementation(async (path) => {
      if (path === "/users/user-2") return response(detailedUser);
      if (path === "/auth/csrf") return response({ csrf_token: "csrf" });
      return response({});
    });

    render(<UserDetailPage />);
    expect(await screen.findByText("lin@example.test")).toBeVisible();
    expect(screen.getByText("2 days ago")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Change Email" }));
    await user.click(screen.getByRole("button", { name: "Apply email" }));
    expect(screen.getByText("changed@example.test")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Change Role" }));
    await user.click(screen.getByRole("button", { name: "Apply role" }));
    expect(screen.getByText("Admin")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Set Password" }));
    await user.click(screen.getByRole("button", { name: "Apply password" }));

    await user.click(screen.getByRole("button", { name: "Delete User" }));
    const dialog = screen.getByRole("dialog", { name: "Delete User" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(testState.navigate).toHaveBeenCalledWith("/users"),
    );
  });

  it("shows private MFA actions and hides unsafe self-management", async () => {
    testState.auth.me = {
      id: "user-2",
      username: "Lin",
      email: "lin@example.test",
      role: "admin",
    };
    testState.api.mockResolvedValue(response(detailedUser));

    render(<UserDetailPage />);
    expect(await screen.findByText("MFA settings")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Change Role" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete User" }),
    ).not.toBeInTheDocument();
  });

  it("distinguishes missing users from other request failures", async () => {
    const missing = /** @type {any} */ (new Error("not found"));
    missing.cause = { status: 404 };
    testState.api.mockRejectedValue(missing);
    const { unmount } = render(<UserDetailPage />);
    expect(await screen.findByText("Missing user: user-2")).toBeVisible();
    unmount();

    testState.api.mockRejectedValue(new Error("User service unavailable"));
    render(<UserDetailPage />);
    expect(
      await screen.findByText("Error: User service unavailable"),
    ).toBeVisible();
  });
});
