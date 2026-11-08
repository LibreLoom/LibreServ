import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import InspectModal from "./InspectModal.jsx";

afterEach(() => vi.unstubAllGlobals());
it("unlocks and adds an existing encrypted drive without formatting", async () => {
  const fetchMock = vi.fn(async (_url, _init = /** @type {any} */ ({})) => new Response(JSON.stringify({ ok: true, drive_id: "d1" }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  render(<QueryClientProvider client={new QueryClient()}><ToastProvider><InspectModal open drive={{ name: "sdb", model: "USB drive" }} result={{ locked: true, readable: false, writable: false, entries: [] }} error={null} adoptError={null} adopting={false} onClose={() => {}} onFormat={() => {}} onAdopt={() => {}} /></ToastProvider></QueryClientProvider>);
  fireEvent.change(screen.getByLabelText("Drive password"), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock and add" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/drives/sdb/unlock-and-add");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ password: "secret" });
});
