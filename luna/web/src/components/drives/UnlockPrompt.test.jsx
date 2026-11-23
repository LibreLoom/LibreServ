import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import UnlockPrompt from "./UnlockPrompt.jsx";

afterEach(() => vi.unstubAllGlobals());

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function show(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ToastProvider>
      <QueryClientProvider client={client}>
        <div className="surface-secondary text-primary p-4"><UnlockPrompt driveId="d1" {...props} /></div>
      </QueryClientProvider>
    </ToastProvider>,
  );
}

function type(password) {
  fireEvent.change(screen.getByLabelText("Drive password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /Unlock/ }));
}

describe("UnlockPrompt", () => {
  it("won't send an empty password", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    show();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unlocks a drive Luna has, and tells the caller", async () => {
    const fetchMock = vi.fn(async () => reply({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const onUnlocked = vi.fn();
    show({ onUnlocked });
    type("correct-horse-1");
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    const [url, init] = /** @type {any} */ (fetchMock.mock.calls[0]);
    expect(url).toBe("/api/v1/drives/d1/unlock");
    expect(JSON.parse(init.body)).toEqual({ password: "correct-horse-1" });
    expect(screen.getByLabelText("Drive password")).toHaveValue("");
  });

  it("shows a wrong password under the field, as a field error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "That password didn't work.", code: "wrong_password", locked_out: false }, 401)));
    show();
    type("nope");
    expect(await screen.findByText("That password didn't work.")).toBeInTheDocument();
    expect(screen.getByLabelText("Drive password")).toHaveAttribute("aria-invalid", "true");
  });

  it("says to wait when there have been too many tries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "Too many wrong tries. Wait a few minutes, then try again.", code: "too_many_tries" }, 429)));
    show();
    type("anything");
    expect(await screen.findByText(/Wait a few minutes/)).toBeInTheDocument();
  });

  it("says when Luna is busy with the drive, without shaking or painting the field red", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "Luna is already working on this drive. Wait until it finishes.", code: "drive_busy" }, 409)));
    show();
    type("anything");
    expect(await screen.findByText(/already working on this drive/)).toBeInTheDocument();
    expect(screen.getByLabelText("Drive password")).toHaveAttribute("aria-invalid", "false");
    expect(document.querySelector("#unlock-d1-error")).toBeNull();
  });

  it("keeps a lock-out message plain too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "Too many wrong tries. Wait a few minutes, then try again.", code: "too_many_tries" }, 429)));
    show();
    type("anything");
    expect(await screen.findByText(/Wait a few minutes/)).toBeInTheDocument();
    expect(screen.getByLabelText("Drive password")).toHaveAttribute("aria-invalid", "false");
  });

  it("announces a busy notice politely, with an id under the field and no error styling", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "Luna is already working on this drive. Wait until it finishes.", code: "drive_busy" }, 409)));
    show();
    type("anything");
    const notice = await screen.findByRole("status");
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(notice.textContent).toMatch(/already working on this drive/);
    expect(document.getElementById("unlock-d1-notice")).toBe(notice);
    expect(screen.getByLabelText("Drive password")).toHaveAttribute("aria-describedby", "unlock-d1-notice");
    expect(screen.getByLabelText("Drive password")).toHaveAttribute("aria-invalid", "false");
    expect(document.querySelector("#unlock-d1-error")).toBeNull();
  });

  it("adds a drive Luna hasn't added through unlock-and-add, letting go of the look first", async () => {
    const order = [];
    const fetchMock = vi.fn(async () => { order.push("send"); return reply({ ok: true, drive_id: "d9" }); });
    vi.stubGlobal("fetch", fetchMock);
    const onUnlocked = vi.fn();
    show({ driveId: undefined, deviceName: "sdq", buttonLabel: "Unlock and add", beforeSend: async () => { order.push("release"); }, onUnlocked });
    type("correct-horse-1");
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith({ ok: true, drive_id: "d9" }));
    expect(/** @type {any} */ (fetchMock.mock.calls[0])[0]).toBe("/api/v1/drives/sdq/unlock-and-add");
    expect(order).toEqual(["release", "send"]);
  });
});
