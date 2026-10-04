import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import ResetLunaCard from "./ResetLunaCard.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <ToastProvider>
      <QueryClientProvider client={client}>
        <ResetLunaCard />
      </QueryClientProvider>
    </ToastProvider>,
  );
}

describe("ResetLunaCard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps Reset disabled until a password is typed, then posts it", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "That password is wrong. Reset was not started." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: "Reset this Luna" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset this Luna?" });
    const confirm = within(dialog).getByRole("button", { name: "Reset this Luna" });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/Type your password/i), "hunter22");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = /** @type {any} */ (fetchMock.mock.calls[0]);
    expect(String(url)).toContain("/api/v1/system/factory-reset");
    expect(JSON.parse(init.body)).toEqual({ confirm: true, password: "hunter22" });
    // A wrong password stays inside the dialog.
    expect(await within(dialog).findByText(/password is wrong/i)).toBeTruthy();
  });
});
