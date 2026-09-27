import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import NotFoundPage from "./NotFoundPage";

const auth = vi.hoisted(() => ({ value: { user: null, loading: false } }));
const api = vi.hoisted(() => ({ getJson: vi.fn(), getDrives: vi.fn() }));

vi.mock("../context/AuthContext", () => ({ useAuth: () => auth.value }));
vi.mock("../components/ui/Navbar", () => ({
  default: () => <nav aria-label="Main navigation" />,
}));
vi.mock("../lib/api", () => api);

function renderAt(path) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <NotFoundPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  auth.value = { user: null, loading: false };
  api.getJson.mockReset();
  api.getDrives.mockReset().mockResolvedValue([{ id: "d1", label: "Big Drive" }]);
});

describe("NotFoundPage", () => {
  it("shows the error code, tonight's moon, and the attempted path decoded", () => {
    renderAt("/definitely/not%20a/page?x=1");
    expect(screen.getByText("Error 404")).toBeTruthy();
    expect(screen.getByText("Tonight's moon")).toBeTruthy();
    expect(screen.getAllByText("/definitely/not a/page?x=1").length).toBeGreaterThan(0);
    expect(screen.getByText("Not found")).toBeTruthy();
  });

  it("suggests a close match for a mistyped route", () => {
    renderAt("/galery");
    expect(screen.getByRole("link", { name: "Photos" })).toHaveAttribute(
      "href",
      "/gallery",
    );
  });

  it("understands other words for a page", () => {
    renderAt("/pictures");
    expect(screen.getByRole("link", { name: "Photos" })).toHaveAttribute(
      "href",
      "/gallery",
    );
  });

  it("never suggests the same page twice", () => {
    renderAt("/files");
    expect(screen.getAllByRole("link", { name: "Files" })).toHaveLength(1);
  });

  it("hides admin pages from members", () => {
    auth.value = { user: { role: "member" }, loading: false };
    api.getJson.mockResolvedValue([]);
    renderAt("/users");
    expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
  });

  it("offers sign-in when signed out, with no file search or navbar", () => {
    renderAt("/Documents/report.pdf");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(screen.queryByText("Find a file")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    expect(api.getJson).not.toHaveBeenCalled();
  });

  it("searches for the file an old link pointed at", async () => {
    auth.value = { user: { role: "admin" }, loading: false };
    api.getJson.mockResolvedValue([
      { drive_id: "d1", path: "Taxes/Tax 2024.pdf", parent: "Taxes", name: "Tax 2024.pdf", kind: "file" },
    ]);
    renderAt("/documents/Tax%202024.pdf");

    expect(screen.getByLabelText("Search your files by name")).toHaveValue("Tax 2024.pdf");
    const hit = await screen.findByRole("link", { name: /Tax 2024\.pdf/ });
    expect(hit).toHaveAttribute("href", expect.stringContaining("select="));
    expect(await screen.findByText(/in Big Drive \/ Taxes/)).toBeTruthy();
    expect(api.getJson).toHaveBeenCalledWith("/api/v1/search?q=Tax%202024.pdf");
    // The folder hint still shows alongside the search.
    expect(screen.getByRole("link", { name: "Files" })).toHaveAttribute("href", "/drives");
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy();
  });

  it("says plainly when nothing matched", async () => {
    auth.value = { user: { role: "admin" }, loading: false };
    api.getJson.mockResolvedValue([]);
    renderAt("/summer-trip");
    expect(await screen.findByText(/Nothing named “summer trip”/)).toBeTruthy();
  });

  it("hides Go back when this is the first page in the tab", () => {
    renderAt("/xyz");
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
  });
});

describe("NotFoundPage long paths", () => {
  it("shortens the pill but keeps the full path for screen readers", () => {
    renderAt("/some/really/long/old-link-name-here");
    expect(screen.getByText("…/old-link-name-here")).toBeTruthy();
    expect(screen.getByText("/some/really/long/old-link-name-here")).toHaveClass("sr-only");
    // "some" is one letter off "home", but Home already lives in Where to next.
    expect(screen.queryByRole("navigation", { name: "Did you mean" })).toBeNull();
  });
});
