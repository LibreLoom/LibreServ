import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import RoutesCard from "./RoutesCard";

const makeRoute = (overrides = {}) => ({
  id: "r1",
  subdomain: "app",
  domain: "example.com",
  backend: "http://localhost:8080",
  app_id: "inst1",
  enabled: true,
  ssl: false,
  ...overrides,
});

// RoutesCard's props are all destructured (inferred required by tsc), so every
// render supplies a full base and overrides per test.
const defaultProps = {
  routes: [],
  apps: [],
  loading: false,
  error: undefined,
  onRetry: vi.fn(),
  onAdd: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onToggle: vi.fn(),
  togglingId: undefined,
};

describe("RoutesCard", () => {
  it("shows a loading spinner while loading", () => {
    render(<RoutesCard {...defaultProps} loading={true} />);
    expect(document.querySelector(".animate-spin")).toBeTruthy();
  });

  it("shows the error message and a Retry button that calls onRetry", () => {
    const onRetry = vi.fn();
    render(<RoutesCard {...defaultProps} error="Something broke" onRetry={onRetry} />);
    expect(screen.getByText("Something broke")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state with an add-first-route button that calls onAdd", () => {
    const onAdd = vi.fn();
    render(<RoutesCard {...defaultProps} onAdd={onAdd} />);
    expect(screen.getByText(/no routes configured/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /add your first route/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("renders the full domain (subdomain.domain) for each route", () => {
    const routes = [makeRoute({ id: "r1", subdomain: "app", domain: "example.com" })];
    render(<RoutesCard {...defaultProps} routes={routes} />);
    expect(screen.getByText("app.example.com")).toBeTruthy();
  });

  it("renders the domain only when there is no subdomain", () => {
    const routes = [makeRoute({ id: "r2", subdomain: "", domain: "example.com" })];
    render(<RoutesCard {...defaultProps} routes={routes} />);
    expect(screen.getByText("example.com")).toBeTruthy();
  });

  it("shows the app name when the route's app_id matches a known app", () => {
    const routes = [makeRoute({ app_id: "inst1" })];
    const apps = [{ id: "inst1", name: "Nextcloud" }];
    render(<RoutesCard {...defaultProps} routes={routes} apps={apps} />);
    expect(screen.getByText("Nextcloud")).toBeTruthy();
  });

  it("falls back to the backend host when no app matches", () => {
    const routes = [makeRoute({ app_id: "unknown" })];
    render(
      <RoutesCard
        {...defaultProps}
        routes={routes}
        apps={[{ id: "inst1", name: "Nextcloud" }]}
      />,
    );
    // formatBackend("http://localhost:8080") -> "localhost:8080"
    expect(screen.getByText("localhost:8080")).toBeTruthy();
  });

  it("shows an SSL badge only for routes with ssl=true", () => {
    const routes = [
      makeRoute({ id: "r1", ssl: true }),
      makeRoute({ id: "r2", ssl: false }),
    ];
    render(<RoutesCard {...defaultProps} routes={routes} />);
    expect(screen.getAllByText("SSL")).toHaveLength(1);
  });

  it("calls onEdit and onDelete with the route", () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const routes = [makeRoute({ id: "r1" })];
    render(
      <RoutesCard {...defaultProps} routes={routes} onEdit={onEdit} onDelete={onDelete} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /edit route/i }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }));
    fireEvent.click(screen.getByRole("button", { name: /delete route/i }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }));
  });
});