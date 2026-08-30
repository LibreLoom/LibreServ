import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SystemUpdatesCard from "./SystemUpdatesCard.jsx";

const UP_TO_DATE = {
  current_version: "0.1.0",
  latest_version: "luna-v0.1.0",
  update_available: false,
  release_notes: "",
  url: "",
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
    <QueryClientProvider client={client}>
      <SystemUpdatesCard />
    </QueryClientProvider>,
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
});
