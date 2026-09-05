import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import RemoteCategory from "./RemoteCategory";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <RemoteCategory />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("RemoteCategory", () => {
  it("shows empty public-address state and Open Luna Connect CTA when off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ enabled: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    renderPage();

    expect(await screen.findByText("No public address yet")).toBeTruthy();
    expect(screen.getByText("Public address")).toBeTruthy();
    expect(screen.getByText(/yourname/i)).toBeTruthy();
    expect(screen.getByText(/\.luna\.servers\.libreloom\.org/)).toBeTruthy();
    expect(
      screen.getByText(/Pick a name on Luna Connect\. Luna shows the address here once it is ready/i),
    ).toBeTruthy();

    const cta = screen.getByRole("link", { name: /Open Luna Connect/i });
    expect(cta).toHaveAttribute("href", "https://connect.luna.libreloom.org");

    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save new address/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Turn Luna Connect off/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sync with Luna Connect/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/About → Advanced/i)).not.toBeInTheDocument();
  });

  it("shows copyable address and Manage CTA when on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              enabled: true,
              hostname: "photos.luna.servers.libreloom.org",
              domain: "photos.luna.servers.libreloom.org",
              tunnel_active: true,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    renderPage();

    expect(await screen.findByDisplayValue("https://photos.luna.servers.libreloom.org")).toBeTruthy();
    expect(screen.getByLabelText("Luna Connect address")).toBeTruthy();
    expect(screen.getByText("Public address")).toBeTruthy();
    expect(screen.getByText("On")).toBeTruthy();

    const manage = screen.getByRole("link", { name: /Manage on Luna Connect/i });
    expect(manage).toHaveAttribute("href", "https://connect.luna.libreloom.org");

    expect(screen.queryByText("No public address yet")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save new address/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Turn Luna Connect off/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("kitchen")).not.toBeInTheDocument();
  });

  it("keeps the address visible and warns when the secure tunnel is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              enabled: true,
              hostname: "photos.luna.servers.libreloom.org",
              domain: "photos.luna.servers.libreloom.org",
              tunnel_active: false,
              tunnel_error:
                "Remote access is set up, but the secure tunnel is not running yet. Luna will keep trying.",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    renderPage();

    expect(await screen.findByDisplayValue("https://photos.luna.servers.libreloom.org")).toBeTruthy();
    expect(
      screen.getByText(
        /Remote access is set up, but the secure tunnel is not running yet\. Luna will keep trying\./i,
      ),
    ).toBeTruthy();
    expect(screen.getByText("On")).toBeTruthy();
  });

  it("shows device token errors with a link to About Advanced", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              enabled: false,
              device_token_error: "Luna Connect did not accept this device token.",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    renderPage();

    expect(
      await screen.findByText("Luna Connect did not accept this device token."),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Change the device token in About → Advanced/i }),
    ).toHaveAttribute("href", "/settings#about");
    expect(screen.getByRole("link", { name: /Open Luna Connect/i })).toBeTruthy();
  });
});
