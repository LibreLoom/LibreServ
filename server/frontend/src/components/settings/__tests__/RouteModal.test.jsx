import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../../test/test-utils";
import RouteModal from "../RouteModal";

vi.mock("../../../lib/network-api", () => ({
  testBackend: vi.fn().mockResolvedValue({ reachable: true }),
}));

const mockRequest = vi.fn();

vi.mock("../../../hooks/useAuth", () => ({
  useAuth: () => ({ request: mockRequest }),
}));

vi.mock("../../../components/cards/ModalCard", () => ({
  default: ({ title, children }) => (
    <div role="dialog" aria-label={typeof title === "string" ? title : "modal"}>
      {children}
    </div>
  ),
}));

const runningApp = {
  id: "app-nextcloud",
  name: "Nextcloud",
  status: "running",
  backends: [{ name: "ui", url: "http://localhost:8080" }],
};

function renderModal(overrides = {}) {
  return renderWithProviders(
    <RouteModal
      open
      onClose={vi.fn()}
      mode="create"
      route={null}
      defaultDomain="example.com"
      apps={[]}
      onSuccess={vi.fn()}
      {...overrides}
    />
  );
}

describe("RouteModal — create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not require an app — shows the destination field with no app gate", () => {
    renderModal();
    expect(screen.getByLabelText(/Forward to/)).toBeInTheDocument();
    // The old "No running apps" blocker must be gone.
    expect(screen.queryByText(/No running apps/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Install and start an app/i)).not.toBeInTheDocument();
    // No app dropdown when nothing is running.
    expect(screen.queryByRole("button", { name: /Choose an app/ })).not.toBeInTheDocument();
  });

  it("requires a destination address", async () => {
    mockRequest.mockResolvedValue({ ok: true, json: async () => ({ id: "r1" }) });
    renderModal();
    fireEvent.change(screen.getByLabelText(/Subdomain/), { target: { value: "nextcloud" } });
    // Destination left empty.
    fireEvent.click(screen.getByRole("button", { name: "Add Route" }));

    await waitFor(() => {
      expect(screen.getByText(/Enter the address on this device to forward to/)).toBeInTheDocument();
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("rejects a destination that is not host:port", async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText(/Subdomain/), { target: { value: "nextcloud" } });
    fireEvent.change(screen.getByLabelText(/Forward to/), { target: { value: "localhost" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Route" }));

    await waitFor(() => {
      expect(screen.getByText(/Enter it as host:port/)).toBeInTheDocument();
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("submits subdomain + domain + destination with no app", async () => {
    mockRequest.mockResolvedValue({ ok: true, json: async () => ({ id: "r1" }) });
    renderModal();
    fireEvent.change(screen.getByLabelText(/Subdomain/), { target: { value: "nextcloud" } });
    fireEvent.change(screen.getByLabelText(/Forward to/), { target: { value: "localhost:8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Route" }));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        "/network/routes",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            subdomain: "nextcloud",
            domain: "example.com",
            backend: "localhost:8080",
            ssl: true,
          }),
        })
      );
    });
  });

  it("links a running app by filling the destination with its backend", async () => {
    renderModal({ apps: [runningApp] });

    // The app dropdown appears only when a running app exists. "Manual
    // address" is the default selection; pick the running app from it.
    fireEvent.click(screen.getByRole("button", { name: /Manual address/ }));
    fireEvent.click(screen.getByRole("option", { name: "Nextcloud" }));

    await waitFor(() => {
      expect(screen.getByLabelText(/Forward to/)).toHaveValue("http://localhost:8080");
    });
  });
});

describe("RouteModal — edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const manualRoute = {
    id: "route-manual",
    subdomain: "photos",
    domain: "example.com",
    backend: "192.168.1.50:3000",
    app_id: "",
    ssl: true,
    enabled: true,
  };

  it("edits a manual (app-less) route — destination + enabled", async () => {
    mockRequest.mockResolvedValue({ ok: true, json: async () => ({ id: "route-manual" }) });
    renderWithProviders(
      <RouteModal open onClose={vi.fn()} mode="edit" route={manualRoute} defaultDomain="example.com" apps={[]} onSuccess={vi.fn()} />
    );

    // The route's current backend is prefilled and editable.
    expect(screen.getByLabelText(/Forward to/)).toHaveValue("192.168.1.50:3000");
    fireEvent.change(screen.getByLabelText(/Forward to/), { target: { value: "192.168.1.50:4000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        "/network/routes/route-manual",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ backend: "192.168.1.50:4000", enabled: true }),
        })
      );
    });
  });
});
