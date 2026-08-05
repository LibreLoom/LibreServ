import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../../../test/test-utils";
import NetworkCategory from "../NetworkCategory";

vi.mock("../../../../lib/network-api", () => ({
  getCaddyStatus: vi.fn(),
  listRoutes: vi.fn(),
  getCaddyfile: vi.fn().mockResolvedValue("# Caddyfile\n{\n\tauto_https off\n}"),
  getConnectivityStatus: vi.fn().mockResolvedValue(null),
  getUPnPStatus: vi.fn().mockResolvedValue(null),
  getDDNSStatus: vi.fn().mockResolvedValue(null),
  getTunnelStatus: vi.fn().mockResolvedValue({ available: false, enabled: false }),
  ddnsForceUpdate: vi.fn(),
  ddnsSetInterval: vi.fn(),
  getNetworkReport: vi.fn().mockResolvedValue(null),
  getNetworkPlans: vi.fn().mockResolvedValue({ plans: [] }),
}));

const mockRequest = vi.fn().mockImplementation((path) => {
  if (path === "/apps") {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        apps: [
          { id: "app-nextcloud", name: "Nextcloud", status: "running", backends: [{ name: "ui", url: "http://localhost:8080" }] },
        ],
        total: 1,
      }),
    });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
});

vi.mock("../../../../hooks/useAuth", () => ({
  useAuth: () => ({
    request: mockRequest,
  }),
}));

vi.mock("../../../../components/cards/Card", () => ({
  default: ({ children }) => <>{children}</>,
}));

let RoutesCardProps = null;
vi.mock("../../../../components/network/RoutesCard", () => ({
  default: (props) => {
    RoutesCardProps = props;
    return <div data-testid="routes-card" />;
  },
}));

let DebugCardProps = null;
vi.mock("../../../../components/network/DebugCard", () => ({
  default: (props) => {
    DebugCardProps = props;
    return <div data-testid="debug-card" />;
  },
}));

vi.mock("../../../../context/ToastContext", () => ({
  useToast: () => ({
    addToast: vi.fn(),
    dismissToast: vi.fn(),
    clearToasts: vi.fn(),
    toasts: [],
  }),
}));

import { getCaddyStatus, listRoutes, getCaddyfile, getNetworkReport, getNetworkPlans } from "../../../../lib/network-api";

const mockRoutes = [
  {
    id: "route-1",
    subdomain: "nextcloud",
    domain: "example.com",
    backend: "http://localhost:8080",
    app_id: "app-nextcloud",
    ssl: true,
    enabled: true,
  },
  {
    id: "route-2",
    subdomain: "",
    domain: "wiki.example.com",
    backend: "http://localhost:3000",
    app_id: null,
    ssl: true,
    enabled: false,
  },
];

const mockStatus = {
  running: true,
  version: "v2.8.1",
  config_valid: true,
  routes: 2,
  domains: ["example.com", "wiki.example.com"],
};

beforeEach(() => {
  vi.clearAllMocks();
  RoutesCardProps = null;
  DebugCardProps = null;
  /** @type {any} */ (listRoutes).mockResolvedValue(mockRoutes);
  /** @type {any} */ (getCaddyStatus).mockResolvedValue(mockStatus);
  /** @type {any} */ (getCaddyfile).mockResolvedValue("# Caddyfile\n{\n\tauto_https off\n}");
});

async function openAdvanced() {
  await waitFor(() => {
    expect(screen.getByRole("button", { name: /Advanced/i })).toBeInTheDocument();
  });
  act(() => {
    screen.getByRole("button", { name: /Advanced/i }).click();
  });
}

describe("NetworkCategory", () => {
  it("renders caddy status card on success", async () => {
    renderWithProviders(<NetworkCategory settings={{}} />);
    await openAdvanced();

    await waitFor(() => {
      expect(screen.getByText("Running")).toBeInTheDocument();
    });

    expect(screen.getByText("v2.8.1")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("renders RoutesCard with correct data", async () => {
    renderWithProviders(<NetworkCategory settings={{}} />);
    await openAdvanced();

    await waitFor(() => {
      expect(RoutesCardProps?.loading).toBe(false);
    });

    expect(RoutesCardProps).toMatchObject({
      routes: mockRoutes,
      apps: expect.arrayContaining([
        expect.objectContaining({ id: "app-nextcloud", name: "Nextcloud" }),
      ]),
      loading: false,
      error: null,
    });
  });

  it("passes loading and error state to RoutesCard", async () => {
    /** @type {any} */ (listRoutes).mockImplementation(() => new Promise(() => {}));
    /** @type {any} */ (getCaddyStatus).mockImplementation(() => new Promise(() => {}));

    renderWithProviders(<NetworkCategory settings={{}} />);
    await openAdvanced();

    await waitFor(() => {
      expect(RoutesCardProps).toMatchObject({ loading: true, error: null });
    });
  });

  it("passes error to RoutesCard on load failure", async () => {
    /** @type {any} */ (listRoutes).mockRejectedValue(new Error("Network error"));

    renderWithProviders(<NetworkCategory settings={{}} />);
    await openAdvanced();

    await waitFor(() => {
      expect(RoutesCardProps).toMatchObject({ loading: false, error: "Network error" });
    });
  });

  it("shows domain connection message when no domain is set", async () => {
    renderWithProviders(<NetworkCategory settings={{}} />);
    await openAdvanced();

    await waitFor(() => {
      expect(screen.getByText(/No domain configured/)).toBeInTheDocument();
    });
  });

  it("shows current domain when default domain is set", async () => {
    renderWithProviders(<NetworkCategory settings={{ proxy: { default_domain: "example.com" } }} />);
    await openAdvanced();

    await waitFor(() => {
      expect(screen.getByText(/Current:\s*example\.com/)).toBeInTheDocument();
    });
  });

  it("RoutesCard onAdd opens add route modal", async () => {
    renderWithProviders(<NetworkCategory settings={{}} />);
    await openAdvanced();

    await waitFor(() => expect(screen.getByTestId("routes-card")).toBeInTheDocument());

    act(() => {
      RoutesCardProps.onAdd();
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Add Route", { selector: "h2" })).toBeInTheDocument();
    });
  });

  it("RoutesCard onEdit opens edit modal", async () => {
    renderWithProviders(<NetworkCategory settings={{}} />);
    await openAdvanced();

    await waitFor(() => expect(screen.getByTestId("routes-card")).toBeInTheDocument());

    act(() => {
      RoutesCardProps.onEdit(mockRoutes[0]);
    });

    await waitFor(() => {
      expect(screen.getByText("Edit Route", { selector: "h2" })).toBeInTheDocument();
    });
  });

  it("RoutesCard onDelete opens delete confirmation", async () => {
    renderWithProviders(<NetworkCategory settings={{}} />);
    await openAdvanced();

    await waitFor(() => expect(screen.getByTestId("routes-card")).toBeInTheDocument());

    act(() => {
      RoutesCardProps.onDelete(mockRoutes[0]);
    });

    await waitFor(() => {
      expect(screen.getByText("Delete Route", { selector: "h2" })).toBeInTheDocument();
    });
  });

  it("renders DebugCard with caddyfile content", async () => {
    renderWithProviders(<NetworkCategory settings={{}} />);
    await openAdvanced();

    await waitFor(() => {
      expect(screen.getByTestId("debug-card")).toBeInTheDocument();
    });

    // The caddyfile is fetched asynchronously; wait for it to land in
    // DebugCard's props rather than asserting immediately after render (race fix).
    await waitFor(() => {
      expect(DebugCardProps).toMatchObject({
        content: "# Caddyfile\n{\n\tauto_https off\n}",
      });
    });
    expect(DebugCardProps.onReload).toBeDefined();
  });
});

describe("NetworkCategory report + plans", () => {
  beforeEach(() => {
    /** @type {any} */ (getNetworkReport).mockResolvedValue(null);
    /** @type {any} */ (getNetworkPlans).mockResolvedValue({ plans: [] });
  });

  it("renders reachability headline and coverage", async () => {
    /** @type {any} */ (getNetworkReport).mockResolvedValue({
      generated_at: Date.now() / 1000,
      stacks: { v4: { available: true, public_addr: "203.0.113.10", inbound_open: true }, v6: { available: false } },
      nat: { type: "open", behind_double_nat: false },
      upnp: { discovered: false },
      connect: { active: true, tunnel_ok: true },
      domain: { source: "connect_subdomain", name: "dev.free.servers.libreloom.org" },
      headline: "Your apps are reachable from the internet.",
    });
    renderWithProviders(<NetworkCategory settings={{}} />);

    await waitFor(() => {
      expect(screen.getByText("Your apps are reachable from the internet.")).toBeInTheDocument();
    });
    expect(screen.getByText("Everyone")).toBeInTheDocument();
    expect(screen.getByText("203.0.113.10")).toBeInTheDocument();
  });

  it("renders per-app plan cards", async () => {
    /** @type {any} */ (getNetworkPlans).mockResolvedValue({
      plans: [
        {
          app_id: "app-mc", app_name: "Minecraft", path: "upnp",
          message: "We opened the ports your apps need on your router.",
          coverage_v4: true, coverage_v6: false, addon_needed: false, ports: [{ protocol: "tcp", port: 25565 }, { protocol: "udp", port: 25565 }],
        },
        {
          app_id: "app-nc", app_name: "Nextcloud", path: "cloudflared",
          message: "Your app is reachable from the internet through a protected connection.",
          coverage_v4: true, coverage_v6: true, addon_needed: false,
        },
      ],
    });
    renderWithProviders(<NetworkCategory settings={{}} />);

    await waitFor(() => {
      expect(screen.getByText("We opened the ports your apps need on your router.")).toBeInTheDocument();
    });
    expect(screen.getByText(/Needs ports tcp 25565, udp 25565/)).toBeInTheDocument();
    expect(screen.getByText("Your app is reachable from the internet through a protected connection.")).toBeInTheDocument();
    expect(screen.getByText("Ports opened on your router")).toBeInTheDocument();
    expect(screen.getByText("Reachable via protected connection")).toBeInTheDocument();
  });

  it("shows addon upsell when plan needs it", async () => {
    /** @type {any} */ (getNetworkPlans).mockResolvedValue({
      plans: [
        {
          app_id: "app-mc", app_name: "Minecraft", path: "lan_only",
          message: "Only people on your home network can use these apps right now.",
          addon_needed: true, ports: [{ protocol: "udp", port: 25565 }],
        },
      ],
    });
    renderWithProviders(<NetworkCategory settings={{}} />);

    await waitFor(() => {
      expect(screen.getByText(/dedicated address would make this reachable/)).toBeInTheDocument();
    });
  });
});
