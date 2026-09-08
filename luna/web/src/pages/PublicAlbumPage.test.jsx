import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PublicAlbumPage from "./PublicAlbumPage.jsx";

vi.mock("../lib/api", () => ({
  apiErrorMessage: (e, f) => e?.message || f || "error",
  getJson: vi.fn(),
  postForm: vi.fn(),
}));

vi.mock("../components/gallery/PhotoLightbox.jsx", () => ({
  default: function MockLightbox({ mode }) {
    return <div data-testid="lightbox" data-mode={mode || "owner"} />;
  },
  ABOVE_LIGHTBOX_OVERLAY_CLASS: "z-[90]",
  resolveDisplaySrc: (photo, opts) => opts?.contentSrc || photo?.thumb || "",
  resolveDownloadSrc: (photo, opts) => opts?.downloadSrc || photo?.download || "",
}));

import { getJson } from "../lib/api";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/a/tok123"]}>
        <Routes>
          <Route path="/a/:token" element={<PublicAlbumPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PublicAlbumPage", () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset();
  });

  it("shows download album and guest-safe chrome", async () => {
    vi.mocked(getJson).mockResolvedValue({
      album: { name: "Trip", id: "a1" },
      can_upload: false,
      has_more: false,
      next_offset: 1,
      items: [
        {
          drive_id: "d1",
          path: "p.jpg",
          name: "p.jpg",
          thumb: "/api/v1/public/albums/tok123/thumb?drive_id=d1&path=p.jpg",
          content: "/api/v1/public/albums/tok123/content?drive_id=d1&path=p.jpg",
          download: "/api/v1/public/albums/tok123/download?drive_id=d1&path=p.jpg",
          kind: "image",
        },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/1 item/i)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /download album/i })).toHaveAttribute(
      "href",
      "/api/v1/public/albums/tok123/zip",
    );
    expect(screen.queryByText(/add photos/i)).not.toBeInTheDocument();
  });

  it("opens guest lightbox mode", async () => {
    const { userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    vi.mocked(getJson).mockResolvedValue({
      album: { name: "Trip", id: "a1" },
      can_upload: false,
      items: [
        {
          drive_id: "d1",
          path: "p.jpg",
          name: "p.jpg",
          thumb: "/t",
          content: "/c",
          download: "/d",
          kind: "image",
        },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("p.jpg")).toBeInTheDocument());
    await user.click(screen.getByLabelText("p.jpg"));
    expect(screen.getByTestId("lightbox")).toHaveAttribute("data-mode", "guest");
  });
});
