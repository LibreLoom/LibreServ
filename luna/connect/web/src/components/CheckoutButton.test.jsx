import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CheckoutButton } from "./CheckoutButton.jsx";
import { api } from "../api.js";

vi.mock("../api.js", () => ({ api: vi.fn() }));

describe("CheckoutButton", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks Connect for the payment page for this kind and page", async () => {
    api.mockResolvedValue({ ok: true, done: true });
    const onDone = vi.fn();
    render(
      <div className="surface-secondary">
        <CheckoutButton kind="backup" returnTo="backups" onDone={onDone}>
          Add a payment card
        </CheckoutButton>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add a payment card" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith("/api/v1/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ kind: "backup", return_to: "backups" }),
    });
  });

  it("reports a refusal and lets the person try again", async () => {
    const err = Object.assign(new Error("Your last cloud backup payment didn't go through."), { status: 409 });
    api.mockRejectedValue(err);
    const onError = vi.fn();
    render(
      <div className="surface-secondary">
        <CheckoutButton kind="backup" returnTo="backups" onError={onError}>
          Add a payment card
        </CheckoutButton>
      </div>,
    );
    const button = screen.getByRole("button", { name: "Add a payment card" });
    fireEvent.click(button);
    await waitFor(() => expect(onError).toHaveBeenCalledWith(err));
    expect(button.disabled).toBe(false);
  });
});
