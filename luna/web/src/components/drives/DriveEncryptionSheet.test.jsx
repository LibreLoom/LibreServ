import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import DriveEncryptionSheet from "./DriveEncryptionSheet.jsx";

afterEach(() => vi.unstubAllGlobals());

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const PLAIN = { id: "d1", label: "Family photos", encrypted: false, locked: false };
const OPEN = { id: "d1", label: "Family photos", encrypted: true, locked: false };
const LOCKED = { id: "d1", label: "Family photos", encrypted: true, locked: true };

/** Answers the state route for the drive, and records every other request. */
function stub(status, others = {}, extra = {}) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const u = String(url);
    if (u.endsWith("/encryption")) return reply({ drive_id: "d1", status, present: status !== "unplugged", ...extra });
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const [tail, answer] of Object.entries(others)) if (u.endsWith(tail)) return answer;
    return reply({ ok: true });
  }));
  return calls;
}

function show(drive, props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const handlers = { onClose: vi.fn(), onProtect: vi.fn(), onRemove: vi.fn() };
  render(
    <ToastProvider>
      <QueryClientProvider client={client}>
        <DriveEncryptionSheet drive={drive} {...handlers} {...props} />
      </QueryClientProvider>
    </ToastProvider>,
  );
  return handlers;
}

const GOOD = "brand-new-pass-2";
const fill = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("DriveEncryptionSheet: a plain drive", () => {
  it("says it isn't protected and offers only Protect", async () => {
    stub("not_encrypted");
    show(PLAIN);
    expect(await screen.findByText("Not protected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Protect with a password" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Lock" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Erase drive/ })).toBeNull();
  });

  it("doesn't offer Protect when Luna can't protect this drive, and says why", async () => {
    stub("not_encrypted", {}, { can_protect: false, cant_protect_reason: "This is a test drive made from a folder. A folder can't be protected with a password." });
    show(PLAIN);
    expect(await screen.findByText(/test drive made from a folder/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Protect with a password" })).toBeNull();
  });

  it("asks for the password twice with the no-recovery warning, and refuses an empty or unmatched one", async () => {
    stub("not_encrypted");
    const { onProtect } = show(PLAIN);
    fireEvent.click(await screen.findByRole("button", { name: "Protect with a password" }));
    expect(screen.getByText(/no way to get this password back/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Enter a password.")).toBeInTheDocument();
    fill("Password", GOOD);
    fill("Password, once more", "different-pass-3");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("The two passwords don't match.")).toBeInTheDocument();
    expect(onProtect).not.toHaveBeenCalled();
  });

  it("hands the password to the erase window, and sends nothing itself", async () => {
    const calls = stub("not_encrypted");
    const { onProtect } = show(PLAIN);
    fireEvent.click(await screen.findByRole("button", { name: "Protect with a password" }));
    fill("Password", GOOD);
    fill("Password, once more", GOOD);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onProtect).toHaveBeenCalledWith(PLAIN, GOOD));
    expect(calls).toEqual([]);
  });
});

describe("DriveEncryptionSheet: a protected drive", () => {
  it("offers Lock, Change password and Remove protection when it is open", async () => {
    stub("unlocked");
    show(OPEN);
    expect(await screen.findByText("Protected · Unlocked")).toBeInTheDocument();
    for (const name of ["Lock", "Change password", "Remove protection"]) expect(screen.getByRole("button", { name })).toBeEnabled();
    expect(screen.queryByLabelText("Drive password")).toBeNull();
  });

  it("locks it", async () => {
    const calls = stub("unlocked");
    show(OPEN);
    fireEvent.click(await screen.findByRole("button", { name: "Lock" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/v1/drives/d1/lock"))).toBe(true));
  });

  it("shows why locking was refused, in the sheet", async () => {
    stub("unlocked", { "/lock": reply({ error: "Something is still using this drive. Close any files open from it, then try again.", code: "drive_busy" }, 409) });
    show(OPEN);
    fireEvent.click(await screen.findByRole("button", { name: "Lock" }));
    expect(await screen.findByText(/Something is still using this drive/)).toBeInTheDocument();
  });

  it("shows the unlock prompt and no Lock when it is locked", async () => {
    stub("locked");
    show(LOCKED);
    expect(await screen.findByText("Protected · Locked")).toBeInTheDocument();
    expect(screen.getByLabelText("Drive password")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lock" })).toBeNull();
  });

  it("changes the password with the current one, and says a wrong current one under its field", async () => {
    const calls = stub("unlocked", { "/password": reply({ error: "That password didn't work.", code: "wrong_password" }, 401) });
    show(OPEN);
    fireEvent.click(await screen.findByRole("button", { name: "Change password" }));
    fill("Current password", "nope");
    fill("New password", GOOD);
    fill("New password, once more", GOOD);
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("That password didn't work.")).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith("/password"))?.body).toEqual({ current_password: "nope", new_password: GOOD });
  });

  it("says plainly that removing protection erases the drive, then hands off without a password", async () => {
    const calls = stub("unlocked");
    const { onRemove } = show(OPEN);
    fireEvent.click(await screen.findByRole("button", { name: "Remove protection" }));
    expect(screen.getByText(/erases everything on/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove protection and erase" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith(OPEN));
    expect(calls).toEqual([]);
  });

  it("turns every button off for an unplugged drive", async () => {
    stub("unplugged");
    show(LOCKED);
    expect(await screen.findByText("Plug it in to change its protection.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change password" })).toBeDisabled();
    expect(screen.queryByLabelText("Drive password")).toBeNull();
  });
});
