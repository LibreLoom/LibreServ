import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TailscaleCard from "./TailscaleCard.jsx";

vi.mock("@libreloom/ui/context/ToastContext.jsx", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

const { getJson, postJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
}));
vi.mock("../../../lib/api.js", () => ({
  getJson,
  postJson,
  apiErrorMessage: (e, fallback) => e?.message || fallback,
}));

function renderCard(client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })) {
  return render(
    <QueryClientProvider client={client}>
      <TailscaleCard />
    </QueryClientProvider>,
  );
}

describe("TailscaleCard", () => {
  beforeEach(() => {
    getJson.mockReset();
    postJson.mockReset();
  });

  it("warns when public exposure is unknown and offers to stop Tailscale", async () => {
    getJson.mockResolvedValue({ installed: true, enabled: false, identity_saved: true, state: "error", residual_exposure: true });
    postJson.mockResolvedValue({ installed: true, enabled: false, state: "off" });
    renderCard();
    expect(await screen.findByText("Public access may still be on. Turn off Tailscale and check again.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn off Tailscale" }));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith("/api/v1/tailscale/disable", {}));
  });

  it("connects to the selected Headscale server and does not offer Funnel", async () => {
    getJson.mockResolvedValue({ installed: true, enabled: false, identity_saved: false, state: "off" });
    const connected = { installed: true, enabled: true, identity_saved: true, state: "connected", control_server: "https://control.example", private_url: "https://luna.example.net" };
    postJson.mockImplementation(async () => { getJson.mockResolvedValue(connected); return connected; });
    renderCard();
    fireEvent.click(await screen.findByRole("radio", { name: "Headscale" }));
    const address = screen.getByLabelText("Headscale server address");
    fireEvent.change(address, { target: { value: "http://control.example" } });
    expect(screen.getByRole("button", { name: "Connect Luna" })).toBeDisabled();
    fireEvent.change(address, { target: { value: "https://control.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Luna" }));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith("/api/v1/tailscale/connect", { control_server: "https://control.example" }));
    expect(await screen.findByRole("link", { name: "Open private address" })).toHaveAttribute("href", "https://luna.example.net");
    expect(screen.queryByRole("button", { name: "Turn on public access" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Tailscale" })).toHaveAttribute("aria-disabled", "true");
  });

  it("does not replace a completed change with an older status response", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    /** @type {(value: any) => void} */
    let finishOld = () => {};
    const oldStatus = new Promise((resolve) => { finishOld = resolve; });
    const off = { installed: true, enabled: false, state: "off" };
    const connected = { installed: true, enabled: true, state: "connected" };
    getJson.mockResolvedValueOnce(off).mockReturnValueOnce(oldStatus).mockResolvedValue(connected);
    postJson.mockResolvedValue(connected);
    renderCard(client);
    await screen.findByRole("button", { name: "Connect Luna" });
    void client.refetchQueries({ queryKey: ["tailscale-status"] });
    await waitFor(() => expect(getJson).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Connect Luna" }));
    await screen.findByRole("button", { name: "Turn on private access" });
    finishOld(off);
    await waitFor(() => expect(screen.getByRole("button", { name: "Turn on private access" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Connect Luna" })).not.toBeInTheDocument();
  });

  it("keeps first-connect retry available after the daemon fails to start", async () => {
    getJson.mockResolvedValue({ installed: true, enabled: false, state: "off" });
    postJson.mockRejectedValueOnce(new Error("Could not start Tailscale."));
    const pending = { installed: true, enabled: true, state: "pending", auth_url: "https://login.tailscale.com/a/retry" };
    postJson.mockImplementationOnce(async () => { getJson.mockResolvedValue(pending); return pending; });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Luna" }));
    expect(await screen.findByText("Could not start Tailscale.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect Luna" }));
    expect(await screen.findByRole("link", { name: "Approve Luna in Tailscale" })).toHaveAttribute("href", "https://login.tailscale.com/a/retry");
  });

  it("shows browser approval while a device is pending", async () => {
    getJson.mockResolvedValue({
      installed: true,
      enabled: true,
      state: "pending",
      auth_url: "https://login.tailscale.com/a/demo",
    });
    renderCard();
    expect(
      await screen.findByRole("link", { name: "Approve Luna in Tailscale" }),
    ).toHaveAttribute("href", "https://login.tailscale.com/a/demo");
  });

  it("shows a daemon failure with a retry action", async () => {
    getJson.mockResolvedValue({
      installed: true,
      enabled: true,
      state: "error",
      error: "The development Tailscale service is unavailable.",
    });
    renderCard();
    expect(
      await screen.findByText(
        "The development Tailscale service is unavailable.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reconnect" }),
    ).toBeInTheDocument();
  });

  it("connects first, then requires a separate private Serve action", async () => {
    getJson.mockResolvedValue({
      installed: true,
      enabled: true,
      state: "connected",
    });
    postJson.mockResolvedValue({
      installed: true,
      enabled: true,
      state: "connected",
      private_url: "https://luna.tail-demo.ts.net",
    });
    renderCard();
    expect(screen.queryByText(/Install Tailscale on each/)).not.toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "Turn on private access" }),
    );
    await waitFor(() =>
      expect(postJson).toHaveBeenCalledWith("/api/v1/tailscale/serve", {
        public: false,
      }),
    );
  });

  it("turns off private access while keeping Tailscale connected", async () => {
    getJson.mockResolvedValue({ installed: true, enabled: true, state: "connected", private_url: "https://luna.tail-demo.ts.net" });
    const connected = { installed: true, enabled: true, state: "connected", private_url: "" };
    postJson.mockImplementation(async () => { getJson.mockResolvedValue(connected); return connected; });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Turn off private access" }));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith("/api/v1/tailscale/stop-serve", {}));
    expect(await screen.findByRole("button", { name: "Turn on private access" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn off Tailscale" })).toBeInTheDocument();
  });

  it("requires confirmation before making Funnel public", async () => {
    getJson.mockResolvedValue({
      installed: true,
      enabled: true,
      state: "connected",
      private_url: "https://luna.tail-demo.ts.net",
    });
    postJson.mockResolvedValue({
      installed: true,
      enabled: true,
      state: "connected",
      private_url: "https://luna.tail-demo.ts.net",
      public_url: "https://luna.tail-demo.ts.net",
    });
    renderCard();
    fireEvent.click(
      await screen.findByRole("button", { name: "Turn on public access" }),
    );
    expect(
      screen.getByText(/Visitors do not need Tailscale/),
    ).toBeInTheDocument();
    const confirmButtons = screen.getAllByRole("button", {
      name: "Turn on public access",
    });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() =>
      expect(postJson).toHaveBeenCalledWith("/api/v1/tailscale/serve", {
        public: true,
        confirm_public: true,
      }),
    );
  });
  it("labels a Funnel address public and never private", async () => {
    getJson.mockResolvedValue({
      installed: true,
      enabled: true,
      state: "connected",
      private_url: "https://luna.tail-demo.ts.net",
      public_url: "https://luna.tail-demo.ts.net",
    });
    renderCard();
    expect(
      await screen.findByRole("link", { name: "Open public address" }),
    ).toHaveAttribute("href", "https://luna.tail-demo.ts.net");
    expect(
      screen.queryByRole("textbox", { name: "Tailscale private address" }),
    ).not.toBeInTheDocument();
  });

  it("does not enable public access when confirmation is cancelled", async () => {
    getJson.mockResolvedValue({
      installed: true,
      enabled: true,
      state: "connected",
      private_url: "https://luna.tail-demo.ts.net",
    });
    renderCard();
    fireEvent.click(
      await screen.findByRole("button", { name: "Turn on public access" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(postJson).not.toHaveBeenCalled();
  });

  it("keeps connect hidden while initial status is loading", () => {
    getJson.mockReturnValue(new Promise(() => {}));
    renderCard();
    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect Luna" }),
    ).not.toBeInTheDocument();
  });
});
