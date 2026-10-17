import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UnlockCard } from "./UnlockCard.jsx";

describe("UnlockCard", () => {
  it("shows the phishing line with the host", () => {
    render(<UnlockCard onUnlock={vi.fn()} />);
    expect(screen.getByText(/Only type your recovery phrase on/)).toBeTruthy();
    expect(screen.getByText("connect.luna.libreloom.org").className).toMatch(/rounded-pill/);
    expect(screen.getByLabelText("Recovery phrase")).toBeTruthy();
  });

  it("calls onUnlock with the typed words and clears the field", async () => {
    const onUnlock = vi.fn().mockResolvedValue(undefined);
    render(<UnlockCard onUnlock={onUnlock} />);
    const field = screen.getByLabelText("Recovery phrase");
    fireEvent.change(field, { target: { value: "one two three" } });
    fireEvent.click(screen.getByRole("button", { name: "Open backups" }));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith("one two three"));
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("shows a rejection message in an alert", async () => {
    const onUnlock = vi.fn().mockRejectedValue(new Error("That phrase did not open these backups."));
    render(<UnlockCard onUnlock={onUnlock} />);
    fireEvent.change(screen.getByLabelText("Recovery phrase"), { target: { value: "wrong words" } });
    fireEvent.click(screen.getByRole("button", { name: "Open backups" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That phrase did not open these backups.");
    expect(screen.getByLabelText("Recovery phrase").value).toBe("");
  });
});
