import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import DriveEncryptionSheet from "./DriveEncryptionSheet.jsx";

function renderSheet() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider><MemoryRouter><AuthProvider><DriveEncryptionSheet open drive={{ id: "d1", label: "Photos" }} onClose={() => {}} onFormat={() => {}} /></AuthProvider></MemoryRouter></ToastProvider></QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());
it("shows a locked drive and offers unlock to a member", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => new Response(JSON.stringify(String(url).includes("encryption") ? { present: true, encrypted: true, unlocked: false, converting: false } : { id: "u1", role: "user" }), { status: 200, headers: { "Content-Type": "application/json" } })));
  renderSheet();
  expect(await screen.findByText("Encrypted and locked")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();
  expect(screen.queryByText("Set up encryption")).not.toBeInTheDocument();
});
it("does not describe a failed status request as unencrypted", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => new Response(JSON.stringify({ error: "Unavailable" }), { status: String(url).includes("encryption") ? 500 : 200, headers: { "Content-Type": "application/json" } })));
  renderSheet();
  expect(await screen.findByText("Could not check encryption for this drive.")).toBeInTheDocument();
  expect(screen.queryByText("Not encrypted")).not.toBeInTheDocument();
});

it("unlocks for an existing member and refreshes the drive state", async () => {
  let unlocked = false;
  const fetchMock = vi.fn(async (url, _init = /** @type {any} */ ({})) => {
    const path = String(url);
    if (path.endsWith("/unlock")) unlocked = true;
    const data = path.endsWith("/encryption") ? { present: true, encrypted: true, unlocked, converting: false } : path.includes("/auth/me") ? { id: "u1", role: "user", username: "member" } : { ok: true };
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderSheet();
  fireEvent.click(await screen.findByRole("button", { name: "Unlock" }));
  fireEvent.change(screen.getByLabelText("Drive password"), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
  expect(await screen.findByText("Encrypted and unlocked")).toBeInTheDocument();
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/unlock"));
  expect(JSON.parse(/** @type {any} */ (call)[1].body)).toEqual({ password: "secret" });
});

it("confirms that locking affects everyone before sending the request", async () => {
  const fetchMock = vi.fn(async (url, _init = /** @type {any} */ ({})) => {
    const data = String(url).endsWith("/encryption") ? { present: true, encrypted: true, unlocked: true, converting: false } : String(url).includes("/auth/me") ? { id: "u1", role: "admin", username: "admin" } : { ok: true };
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderSheet();
  fireEvent.click(await screen.findByRole("button", { name: "Lock" }));
  expect(screen.getByText(/unavailable to everyone/)).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/lock"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Lock drive" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/lock"))).toBe(true));
});

it("requires matching new passwords before an Admin changes the drive password", async () => {
  const fetchMock = vi.fn(async (url, _init = /** @type {any} */ ({})) => {
    const data = String(url).endsWith("/encryption") ? { present: true, encrypted: true, unlocked: true, converting: false } : String(url).includes("/auth/me") ? { id: "u1", role: "admin", username: "admin" } : { ok: true };
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderSheet();
  fireEvent.click(await screen.findByRole("button", { name: "Change password" }));
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old" } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new" } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "different" } });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(screen.getByText("The new passwords must match.")).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/password"))).toBe(false);
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/password"))).toBe(true));
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/password"));
  expect(JSON.parse(/** @type {any} */ (call)[1].body)).toEqual({ current_password: "old", new_password: "new" });
});

it("does not offer unlock when an encrypted drive is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => new Response(JSON.stringify(String(url).includes("encryption") ? { present: true, encrypted: true, unlocked: false, converting: false, status: "unavailable" } : { id: "u1", role: "user" }), { status: 200, headers: { "Content-Type": "application/json" } })));
  renderSheet();
  expect(await screen.findByText("Unavailable")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Unlock" })).not.toBeInTheDocument();
});
