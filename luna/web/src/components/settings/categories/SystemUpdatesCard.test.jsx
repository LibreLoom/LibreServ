import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SystemUpdatesCard from "./SystemUpdatesCard.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";

const UP_TO_DATE = {
  current_version: "0.1.0",
  latest_version: "0.1.0",
  update_available: false,
  release_notes: "",
  checksum: "",
  binary_name: "lunad-linux-amd64",
  reboot_required: false,
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ToastProvider>
    <QueryClientProvider client={client}>
      <SystemUpdatesCard />
    </QueryClientProvider>
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SystemUpdatesCard", () => {
  it("uses the comet dot spinner on Check for updates, not a circular Loader2", async () => {
    const user = userEvent.setup();
    /** @type {(value?: unknown) => void} */
    let finishCheck = () => {};
    const checkGate = new Promise((resolve) => {
      finishCheck = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (path) => {
        if (String(path).includes("force=true")) {
          await checkGate;
          return jsonResponse(UP_TO_DATE);
        }
        return jsonResponse(UP_TO_DATE);
      }),
    );

    renderCard();
    const checkButton = await screen.findByRole("button", { name: /Check for updates/i });
    await user.click(checkButton);

    const busy = await screen.findByRole("button", { name: /Checking/i });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy.querySelector('[data-slot="spinner"]')).toBeTruthy();
    expect(busy.querySelectorAll(".comet-spinner__dot")).toHaveLength(8);
    expect(busy.querySelector(".animate-spin")).toBeNull();
    expect(busy.querySelector(".lucide-loader-circle, .lucide-loader-2")).toBeNull();

    finishCheck();
    expect(await screen.findByRole("button", { name: /Check for updates/i })).toBeTruthy();
  });

  const FAILED = { ...UP_TO_DATE, os_update_failed: { version: "0.9.0" } };

  it("shows nothing about a failed update when there wasn't one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ...UP_TO_DATE, os_update_failed: null })));
    renderCard();
    await screen.findByRole("button", { name: /Check for updates/i });
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers Try again after a system update that didn't start", async () => {
    const user = userEvent.setup();
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path, init) => {
        calls.push(`${init?.method || "GET"} ${path}`);
        return jsonResponse(String(path).includes("os-failed") || String(path).endsWith("/apply") ? { ok: true } : FAILED);
      }),
    );
    renderCard();
    expect(
      await screen.findByText(/The last system update didn't start, so Luna went back to the previous version\./),
    ).toBeTruthy();
    expect(screen.getByText("0.9.0")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    // Confirm in the dialog (its button has the same label).
    const buttons = await screen.findAllByRole("button", { name: "Try again" });
    await user.click(buttons[buttons.length - 1]);
    await vi.waitFor(() => {
      expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/os-failed/clear"))).toBe(true);
      expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/system/updates/apply"))).toBe(true);
    });
  });
});
