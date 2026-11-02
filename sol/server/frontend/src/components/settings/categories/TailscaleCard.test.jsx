import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TailscaleCard from "./TailscaleCard.jsx";

vi.mock("@libreloom/ui/context/ToastContext.jsx", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../../lib/api.js", () => ({
  default: api,
  apiErrorMessage: (e, fallback) => e?.message || fallback,
}));

const response = (value) => ({ json: async () => value });

describe("Sol Tailscale settings", () => {
  beforeEach(() => api.mockReset());

  it("sends the chosen Headscale control server and hides public access", async () => {
    api.mockResolvedValueOnce(response({ enabled: false, installed: true, state: "off" }));
    api.mockResolvedValueOnce(response({ enabled: true, installed: true, identity_saved: true, state: "connected", control_server: "https://control.example", private_url: "https://sol.example.net" }));
    render(<TailscaleCard />);
    fireEvent.click(await screen.findByRole("radio", { name: "Headscale" }));
    fireEvent.change(screen.getByLabelText("Headscale server address"), { target: { value: "https://control.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Sol" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/network/tailscale/connect", expect.objectContaining({ body: JSON.stringify({ control_server: "https://control.example" }) })));
    expect(await screen.findByRole("link", { name: "Open private address" })).toHaveAttribute("href", "https://sol.example.net");
    expect(screen.queryByRole("button", { name: "Turn on public access" })).not.toBeInTheDocument();
  });

  it("keeps first-connect retry available after the daemon fails to start", async () => {
    api.mockResolvedValueOnce(response({ enabled: false, installed: true, state: "off" }));
    api.mockRejectedValueOnce(new Error("Could not start Tailscale."));
    api.mockResolvedValueOnce(response({ enabled: true, installed: true, state: "pending", auth_url: "https://login.tailscale.com/a/retry" }));
    render(<TailscaleCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Sol" }));
    expect(await screen.findByText("Could not start Tailscale.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect Sol" }));
    expect(await screen.findByRole("link", { name: "Approve Sol in Tailscale" })).toHaveAttribute("href", "https://login.tailscale.com/a/retry");
  });

  it("shows startup progress rather than an off or failed connection", async () => {
    api.mockResolvedValueOnce(response({ enabled: true, installed: true, state: "starting" }));
    render(<TailscaleCard />);
    expect(await screen.findByText("Connecting")).toBeInTheDocument();
    expect(screen.queryByText("Off")).not.toBeInTheDocument();
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
  });

  it("requires a separate private access step after connecting", async () => {
    api.mockResolvedValueOnce(
      response({ enabled: true, installed: true, state: "connected" }),
    );
    api.mockResolvedValueOnce(
      response({
        enabled: true,
        installed: true,
        state: "connected",
        private_url: "https://sol.tail-demo.ts.net",
      }),
    );
    render(<TailscaleCard />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Turn on private access" }),
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/network/tailscale/serve",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ public: false }),
        }),
      ),
    );
  });

  it("asks before exposing Sol through Funnel", async () => {
    api.mockResolvedValueOnce(
      response({
        enabled: true,
        installed: true,
        state: "connected",
        private_url: "https://sol.tail-demo.ts.net",
      }),
    );
    api.mockResolvedValueOnce(
      response({
        enabled: true,
        installed: true,
        state: "connected",
        private_url: "https://sol.tail-demo.ts.net",
        public_url: "https://sol.tail-demo.ts.net",
      }),
    );
    render(<TailscaleCard />);
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
      expect(api).toHaveBeenCalledWith(
        "/network/tailscale/serve",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ public: true, confirm_public: true }),
        }),
      ),
    );
  });

  it("shows a pending browser approval URL", async () => {
    api.mockResolvedValue(
      response({
        enabled: true,
        installed: true,
        state: "pending",
        auth_url: "https://login.tailscale.com/a/demo",
      }),
    );
    render(<TailscaleCard />);
    expect(
      await screen.findByRole("link", { name: "Approve Sol in Tailscale" }),
    ).toHaveAttribute("href", "https://login.tailscale.com/a/demo");
  });

  it("shows a daemon failure with a retry action", async () => {
    api.mockResolvedValue(
      response({
        enabled: true,
        installed: true,
        state: "error",
        error: "The development Tailscale service is unavailable.",
      }),
    );
    render(<TailscaleCard />);
    expect(
      await screen.findByText(
        "The development Tailscale service is unavailable.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reconnect" }),
    ).toBeInTheDocument();
  });
});
