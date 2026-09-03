import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ConnectSetupCodeForm from "./ConnectSetupCodeForm";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderForm(connectStatus) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).includes("/api/v1/connect/status")) {
        return jsonResponse(connectStatus);
      }
      return jsonResponse({ ok: true });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConnectSetupCodeForm />
    </QueryClientProvider>,
  );
}

describe("ConnectSetupCodeForm", () => {
  it("shows how to change a rejected device token", async () => {
    renderForm({
      connect_active: true,
      enabled: false,
      device_token_error:
        "Luna Connect did not accept this device token. It may be mistyped, revoked, or meant for a different Luna. Open Luna on a phone or computer, then go to Settings → About → Advanced and paste a new device token.",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/did not accept this device token/i);
    expect(screen.getByText(/Settings → About → Advanced/i)).toBeTruthy();
    expect(screen.getByLabelText("Device token from Luna Connect")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByRole("button", { name: /Save device token/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Remove device token/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sync with Luna Connect/i })).toBeNull();
  });

  it("keeps the unbound sync path when the token is still accepted", async () => {
    renderForm({ connect_active: true, enabled: false });
    expect(await screen.findByRole("button", { name: /Sync with Luna Connect/i })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText("Device token from Luna Connect")).toBeNull();
  });
});
