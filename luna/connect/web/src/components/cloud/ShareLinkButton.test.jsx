import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ShareLinkButton } from "./ShareLinkButton.jsx";
import { createShareLink } from "../../lib/shareLinks.js";

vi.mock("../../lib/shareLinks.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createShareLink: vi.fn(),
}));

const TOKEN = "b".repeat(43);

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ShareLinkButton", () => {
  it("creates a link and shows the URL and the user-scope sentence", async () => {
    createShareLink.mockResolvedValue({ id: "s1", token: TOKEN, expires_at: 1 });
    const onCreated = vi.fn();
    render(<ShareLinkButton lunaId="l1" scope={{ kind: "user", value: "abc" }} label="Alex" onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "Share link" }));
    expect(await screen.findByDisplayValue(new RegExp(`#${TOKEN}$`))).toBeTruthy();
    expect(screen.getByText(/Anyone with this link and Alex's recovery phrase can download these backups for 7 days/)).toBeTruthy();
    expect(createShareLink).toHaveBeenCalledWith("l1", { kind: "user", value: "abc" });
    expect(onCreated).toHaveBeenCalled();
  });

  it("shows the backup-scope sentence for a backup link", async () => {
    createShareLink.mockResolvedValue({ id: "s2", token: TOKEN, expires_at: 1 });
    render(<ShareLinkButton lunaId="l1" scope={{ kind: "backup", value: "p1" }} label="Photos" />);
    fireEvent.click(screen.getByRole("button", { name: "Share link" }));
    expect(await screen.findByText(/the recovery phrase of someone who has Photos can download it for 7 days/)).toBeTruthy();
  });

  it("copies the link and shows Copied", async () => {
    createShareLink.mockResolvedValue({ id: "s1", token: TOKEN, expires_at: 1 });
    render(<ShareLinkButton lunaId="l1" scope={{ kind: "user", value: "abc" }} label="Alex" />);
    fireEvent.click(screen.getByRole("button", { name: "Share link" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining(`#${TOKEN}`));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("Done hides the URL", async () => {
    createShareLink.mockResolvedValue({ id: "s1", token: TOKEN, expires_at: 1 });
    render(<ShareLinkButton lunaId="l1" scope={{ kind: "user", value: "abc" }} label="Alex" />);
    fireEvent.click(screen.getByRole("button", { name: "Share link" }));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(screen.queryByDisplayValue(new RegExp(TOKEN))).toBeNull();
    expect(screen.getByRole("button", { name: "Share link" })).toBeTruthy();
  });

  it("shows a 409 message in an alert", async () => {
    createShareLink.mockRejectedValue(Object.assign(new Error("You already have 20 active links."), { status: 409 }));
    render(<ShareLinkButton lunaId="l1" scope={{ kind: "user", value: "abc" }} label="Alex" />);
    fireEvent.click(screen.getByRole("button", { name: "Share link" }));
    expect((await screen.findByRole("alert")).textContent).toBe("You already have 20 active links.");
  });
});
