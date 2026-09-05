import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DiscoveryPaths from "./DiscoveryPaths";

vi.mock("../../lib/api", () => ({
  getDiscoveryPaths: vi.fn(),
}));

vi.mock("../../hooks/useDeviceName", () => ({
  useDeviceName: () => ({ deviceName: "luna-test", isLoading: false }),
}));

import { getDiscoveryPaths } from "../../lib/api";

function renderWithClient(ui) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("DiscoveryPaths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state while fetching", () => {
    getDiscoveryPaths.mockReturnValue(new Promise(() => {}));
    renderWithClient(<DiscoveryPaths />);
    expect(screen.getByText(/Looking up ways to reach this Luna/i)).toBeInTheDocument();
  });

  it("shows addresses when paths are available", async () => {
    getDiscoveryPaths.mockResolvedValue({
      paths: [
        { type: "mdns", url: "http://luna.local", label: "Local network (mDNS)" },
        { type: "lan", url: "http://192.168.1.50", label: "Local network (IP)" },
      ],
    });
    renderWithClient(<DiscoveryPaths />);
    expect(await screen.findByText("Access luna-test here:")).toBeInTheDocument();
    expect(screen.getByText("Local network (mDNS)")).toBeInTheDocument();
    expect(screen.getByText("Local network (IP)")).toBeInTheDocument();
    expect(screen.getByText("http://luna.local")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "http://luna.local" })).toHaveAttribute(
      "href",
      "http://luna.local",
    );
    expect(screen.getByRole("link", { name: "http://192.168.1.50" })).toHaveAttribute(
      "href",
      "http://192.168.1.50",
    );
  });

  it("includes a cloud path when present", async () => {
    getDiscoveryPaths.mockResolvedValue({
      paths: [
        { type: "mdns", url: "http://luna.local", label: "Local network (mDNS)" },
        { type: "cloud", url: "https://my-luna.luna.servers.libreloom.org", label: "From anywhere (cloud)" },
      ],
    });
    renderWithClient(<DiscoveryPaths />);
    expect(await screen.findByText("From anywhere (cloud)")).toBeInTheDocument();
    expect(screen.getByText("https://my-luna.luna.servers.libreloom.org")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "https://my-luna.luna.servers.libreloom.org" }),
    ).toHaveAttribute("href", "https://my-luna.luna.servers.libreloom.org");
  });

  it("shows empty state when no paths", async () => {
    getDiscoveryPaths.mockResolvedValue({ paths: [] });
    renderWithClient(<DiscoveryPaths />);
    expect(
      await screen.findByText(/No network addresses yet/i),
    ).toBeInTheDocument();
  });

  it("shows empty state on error", async () => {
    getDiscoveryPaths.mockRejectedValue(new Error("network"));
    renderWithClient(<DiscoveryPaths />);
    expect(
      await screen.findByText(/No network addresses yet/i),
    ).toBeInTheDocument();
  });
});
