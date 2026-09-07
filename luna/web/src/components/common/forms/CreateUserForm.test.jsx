import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateUserForm, { mapCreateUserApiError } from "./CreateUserForm";

vi.mock("../../ui/Button.jsx", () => ({
  default: ({ children, disabled, loading, onClick, type = "button" }) => (
    <button type={type} disabled={disabled || loading} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("../Dropdown.jsx", () => ({
  default: ({ options, value, onChange, "aria-label": ariaLabel }) => (
    <select
      aria-label={ariaLabel || "Role"}
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

describe("mapCreateUserApiError", () => {
  it("points username conflicts at the username field", () => {
    expect(mapCreateUserApiError("That username is already taken.")).toEqual({
      username: "That username is already taken.",
    });
  });

  it("points password policy failures at the password field", () => {
    expect(mapCreateUserApiError("Passwords need at least 12 characters.")).toEqual({
      password: "Passwords need at least 12 characters.",
    });
  });

  it("keeps unknown failures as form errors", () => {
    expect(mapCreateUserApiError("Couldn't add this user. Try again.")).toEqual({
      form: "Couldn't add this user. Try again.",
    });
  });
});

describe("CreateUserForm", () => {
  beforeEach(() => {
    window.matchMedia = (query) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  });

  it("validates on submit and shows the shared strength checklist while typing", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    Element.prototype.animate = animate;
    Element.prototype.getAnimations = vi.fn(() => []);

    render(<CreateUserForm onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: /Add user/i }));
    expect(screen.getByText("Enter a username.")).toBeVisible();
    expect(screen.getByText("Enter a password.")).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/^Username/i), "jamie");
    const password = screen.getByLabelText(/^Password/i);
    expect(password.getAttribute("placeholder")).toBe('Not "a1!", please.');

    animate.mockClear();
    await user.type(password, "short1");
    expect(screen.getByText("12+ chars")).toBeVisible();
    expect(screen.getByText("Not strong enough yet")).toBeVisible();
    expect(screen.getByText("Fair")).toBeVisible();
    expect(screen.queryByText(/Passwords need at least 12 characters/i)).toBeNull();
    // Live unmet requirements must not re-shake the field on each keystroke.
    expect(animate).not.toHaveBeenCalled();
    // Full-size checklist (same as setup) — not the compact size=sm variant.
    expect(
      document.querySelector("[data-slot='password-strength-checklist']"),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Add user/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("12+ chars")).toBeVisible();
    // Policy copy stays in the checklist — not a second error line under the field.
    expect(screen.queryByText(/Passwords need at least 12 characters/i)).toBeNull();

    await user.clear(password);
    await user.type(password, "abcdefghijkl");
    await user.click(screen.getByRole("button", { name: /Add user/i }));
    expect(screen.getByText("numbers")).toBeVisible();
    expect(screen.queryByText(/Passwords need at least one letter and one number/i)).toBeNull();

    await user.clear(password);
    await user.type(password, "LongPassword123!");
    expect(screen.getByText("✓ Acceptable")).toBeVisible();
    expect(screen.getByText("Strong")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveAttribute("type", "text");

    await user.selectOptions(screen.getByLabelText("Role"), "admin");
    await user.type(screen.getByLabelText(/^Name$/i), "Jamie");
    await user.click(screen.getByRole("button", { name: /Add user/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      username: "jamie",
      display_name: "Jamie",
      password: "LongPassword123!",
      role: "admin",
    });
  });

  it("maps API submit errors onto the matching field", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CreateUserForm onSubmit={vi.fn()} submitError={null} />,
    );

    await user.type(screen.getByLabelText(/^Username/i), "jamie");
    await user.type(screen.getByLabelText(/^Password/i), "hunter22hunter1");
    rerender(
      <CreateUserForm
        onSubmit={vi.fn()}
        submitError="That username is already taken."
      />,
    );
    expect(await screen.findByText("That username is already taken.")).toBeVisible();
  });

  it("keeps Admin InfoHint plain-language copy on the role row", () => {
    render(<CreateUserForm onSubmit={vi.fn()} />);
    const form = document.querySelector('[data-slot="create-user-form"]');
    expect(form).toBeTruthy();
    expect(within(form).getByLabelText(/What Admin means/i)).toBeTruthy();
  });
});
