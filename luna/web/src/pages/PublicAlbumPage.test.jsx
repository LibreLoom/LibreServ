import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PublicAlbumPage from "./PublicAlbumPage.jsx";

function renderPublicAlbum(token = "tok123") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/a/${token}`]}>
        <Routes>
          <Route path="/a/:token" element={<PublicAlbumPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PublicAlbumPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders read-only album with View only label and no upload button", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/public/albums/ro-token")) {
        return new Response(
          JSON.stringify({
            album: { name: "Paris Holiday" },
            can_upload: false,
            items: [
              {
                drive_id: "d1",
                path: "eiffel.jpg",
                name: "eiffel.jpg",
                thumb: "/t1",
                kind: "image",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPublicAlbum("ro-token");

    expect(await screen.findByText("Paris Holiday")).toBeInTheDocument();
    expect(screen.getByText(/1 item · View only/i)).toBeInTheDocument();
    expect(screen.queryByText("Add photos")).not.toBeInTheDocument();
  });

  it("renders contributor album with upload button", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/public/albums/ru-token")) {
        return new Response(
          JSON.stringify({
            album: { name: "Collaborative Trip" },
            can_upload: true,
            items: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPublicAlbum("ru-token");

    expect(await screen.findByText("Collaborative Trip")).toBeInTheDocument();
    expect(screen.getByText(/You can add photos and videos/i)).toBeInTheDocument();
    expect(screen.getByText("Add photos")).toBeInTheDocument();
  });
});
