import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import RemoteCategory from "./RemoteCategory";

let mockRole = "admin";
vi.mock("../../../context/AuthContext", () => ({
  useOptionalAuth: () => ({ user: { id: "1", role: mockRole } }),
}));

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

function answer(status) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
}

describe("RemoteCategory", () => {
  afterEach(() => {
    mockRole = "admin";
    vi.unstubAllGlobals();
  });

  it("does not treat a saved device token as an active Connect binding", async () => {
    answer({ paired: false, connect_active: true, device_token_set: true });
    renderPage();

    expect(await screen.findByText("Not paired")).toBeInTheDocument();
    expect(screen.getByText(/Pair this Luna in Luna Connect with its device token/)).toBeInTheDocument();
    expect(screen.getByText("No public address yet")).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/^https:/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Luna Connect/i })).toHaveAttribute(
      "href",
      "https://connect.luna.libreloom.org",
    );
  });

  it("shows a copyable address and Manage CTA for a bound Luna", async () => {
    answer({
      state: "bound",
      paired: true,
      connect_active: true,
      hostname: "photos.luna.servers.libreloom.org",
      domain: "photos.luna.servers.libreloom.org",
      tunnel_active: true,
    });
    renderPage();

    expect(await screen.findByDisplayValue("https://photos.luna.servers.libreloom.org")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Manage on Luna Connect/i })).toHaveAttribute(
      "href",
      "https://connect.luna.libreloom.org",
    );
  });

  it("keeps the address visible and warns when the secure tunnel is down", async () => {
    answer({
      paired: true,
      connect_active: true,
      hostname: "photos.luna.servers.libreloom.org",
      tunnel_active: false,
      tunnel_error: "Remote access is set up, but it is not running yet. Luna will keep trying.",
    });
    renderPage();

    expect(await screen.findByDisplayValue("https://photos.luna.servers.libreloom.org")).toBeTruthy();
    expect(screen.getByText(/Remote access is set up, but it is not running yet/)).toBeTruthy();
  });

  it("shows pending-disconnect state without offering the old public address", async () => {
    answer({
      paired: true,
      connect_active: false,
      unbind_pending: true,
      hostname: "photos.luna.servers.libreloom.org",
    });
    renderPage();

    expect(await screen.findByText("Disconnect pending")).toBeInTheDocument();
    expect(screen.getByText(/Remote access and pairing are off/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("https://photos.luna.servers.libreloom.org")).not.toBeInTheDocument();
  });

  it("shows Connect errors without sending Members to an Admin-only settings page", async () => {
    mockRole = "member";
    answer({ paired: false, connect_active: false, connect_error: "Luna Connect needs attention." });
    renderPage();

    expect(await screen.findByText("Luna Connect needs attention.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Change the device token/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Luna Connect/i })).toBeInTheDocument();
  });

  it("sends an Admin from a Connect error to the device token", async () => {
    answer({ paired: false, connect_active: false, connect_error: "Luna Connect needs attention." });
    renderPage();

    expect(await screen.findByText("Luna Connect needs attention.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Device token/i })).toHaveAttribute("href", "/settings#about");
  });

  it("sends an Admin from a revoked Luna to the device token", async () => {
    answer({ state: "revoked", paired: false, connect_active: false });
    renderPage();

    expect(await screen.findByRole("link", { name: /Open Device token/i })).toHaveAttribute("href", "/settings#about");
  });

  it("shows where the device token lives for an unpaired Admin", async () => {
    answer({ state: "unbound", paired: false, connect_active: false, device_token_set: true });
    renderPage();

    expect(await screen.findByText("Device token")).toBeInTheDocument();
    expect(screen.getByText("Advanced")).toBeInTheDocument();
  });
});
