import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import DriveEncryptionSheet from "./DriveEncryptionSheet.jsx";
import { encryptionCopy, encryptionState } from "../../lib/encryption.js";

const DRIVE = {
  id: "d1",
  label: "Family photos",
  state: "as_is",
  fs_type: "ext4",
  device: "sdz",
  mount_point: "/x",
  encrypted: false,
  locked: false,
  converting: false,
};

/**
 * Stub the handful of endpoints the page touches. `encryption` is what
 * `GET /encryption` returns; `onPost` can record or override a POST.
 * @param {object} encryption
 * @param {{ role?: string, onPost?: (url: string, body: any) => Response | null }} [options]
 */
function stubApi(encryption, { role = "admin", onPost } = {}) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
    if (u.endsWith("/api/v1/drives")) return json([DRIVE]);
    if (u.endsWith("/api/v1/drives/d1/encryption")) return json(encryption);
    if (u.includes("/auth/me")) return json({ id: "u1", role, username: "max" });
    if (u.includes("/setup")) return json({ setup_completed: true });
    if (u.includes("/auth/status")) return json({ has_admin: true, needs_setup: false });
    if (u.includes("/health")) return json({});
    if (method === "POST" && onPost) {
      const handled = onPost(u, JSON.parse(String(init.body || "{}")));
      if (handled) return handled;
    }
    return json({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <AuthProvider>
            <DriveEncryptionSheet open drive={DRIVE} onClose={() => {}} />
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const UNENCRYPTED = {
  drive_id: "d1",
  label: "Family photos",
  encrypted: false,
  unlocked: false,
  converting: false,
  present: true,
  fs_type: "ext4",
  can_encrypt: true,
  cannot_encrypt_reason: "",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encryptionState", () => {
  it("reads the five states in the right order", () => {
    expect(encryptionState(undefined)).toBe("unencrypted");
    expect(encryptionState({ encrypted: false, converting: false })).toBe("unencrypted");
    expect(encryptionState({ encrypted: false, converting: true })).toBe("encrypting");
    expect(encryptionState({ encrypted: true, converting: true })).toBe("decrypting");
    expect(encryptionState({ encrypted: true, unlocked: false })).toBe("locked");
    expect(encryptionState({ encrypted: true, unlocked: true })).toBe("unlocked");
  });

  it("says a locked drive needs its password, not a repair", () => {
    const copy = encryptionCopy("locked", { label: "Family photos" });
    expect(copy.title).toBe("Locked");
    expect(copy.body).toBe("Enter the password to open it.");
  });

});

describe("DriveEncryptionSheet", () => {
  it("offers Encrypt on an unencrypted ext4 drive", async () => {
    stubApi(UNENCRYPTED);
    renderPage();
    expect(await screen.findByText("Not encrypted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Encrypt this drive" })).toBeEnabled();
  });

  it("offers Encrypt on an exFAT drive too, because encrypting wipes it", async () => {
    // The old design could only convert ext4 in place. Wiping removed that
    // limit, so the format a drive happens to have now must not disable the
    // button.
    stubApi({ ...UNENCRYPTED, fs_type: "exfat", can_encrypt: true });
    renderPage();
    expect(await screen.findByText("Not encrypted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Encrypt this drive" })).toBeEnabled();
  });

  it("explains why a drive cannot be encrypted when it is unplugged", async () => {
    stubApi({
      ...UNENCRYPTED,
      present: false,
      can_encrypt: false,
      cannot_encrypt_reason: "Plug this drive in to encrypt it.",
    });
    renderPage();
    expect(await screen.findByText("Plug this drive in to encrypt it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Encrypt this drive" })).toBeDisabled();
  });

  it("asks for the password on a locked drive and unlocks it", async () => {
    const posted = [];
    stubApi(
      { ...UNENCRYPTED, encrypted: true, locked: true, unlocked: false },
      {
        onPost: (url, body) => {
          posted.push({ url, body });
          return null;
        },
      },
    );
    renderPage();
    // A locked drive opens straight on the password dialog.
    const field = await screen.findByLabelText("Password");
    fireEvent.change(field, { target: { value: "hunter2" } });
    // The card also has an Unlock button; the dialog's is the one to press.
    // The sheet is a dialog too; the password dialog is stacked above it.
    const dialogs = screen.getAllByRole("dialog");
    const dialog = dialogs[dialogs.length - 1];
    fireEvent.click(within(dialog).getByRole("button", { name: "Unlock" }));
    await waitFor(() => {
      expect(posted.some((p) => p.url.endsWith("/unlock") && p.body.password === "hunter2")).toBe(true);
    });
  });

  it("warns that a forgotten password loses the files, before encrypting", async () => {
    stubApi(UNENCRYPTED);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Encrypt this drive" }));
    expect(
      await screen.findByText(/the files on this drive are gone/),
    ).toBeInTheDocument();
    // The password is asked for twice, so a typo cannot lock the drive forever.
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByLabelText("Password again")).toBeInTheDocument();
  });

  it("refuses to submit when the two passwords differ", async () => {
    stubApi(UNENCRYPTED);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Encrypt this drive" }));
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "one" } });
    fireEvent.change(screen.getByLabelText("Password again"), { target: { value: "two" } });
    expect(screen.getByText("Those two passwords don't match.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("offers Lock and Decrypt on an unlocked drive", async () => {
    stubApi({ ...UNENCRYPTED, encrypted: true, unlocked: true, locked: false });
    renderPage();
    expect(await screen.findByRole("button", { name: "Lock" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decrypt" })).toBeInTheDocument();
  });

  it("asks for the password before decrypting", async () => {
    stubApi({ ...UNENCRYPTED, encrypted: true, unlocked: true, locked: false });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Decrypt" }));
    expect(
      await screen.findByText(/anyone who plugs this drive in can read its files/),
    ).toBeInTheDocument();
  });

  it("shows a Member no way to change encryption", async () => {
    stubApi(UNENCRYPTED, { role: "user" });
    renderPage();
    expect(await screen.findByText("Not encrypted")).toBeInTheDocument();
    // A Member may unlock a drive they can read, but not encrypt or decrypt it.
    expect(screen.queryByRole("button", { name: "Encrypt this drive" })).toBeNull();
  });

  it("shows progress and no actions while encrypting", async () => {
    stubApi({ ...UNENCRYPTED, encrypted: false, converting: true });
    renderPage();
    expect(await screen.findByText("Encrypting")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Encrypt this drive" })).toBeNull();
  });
});
