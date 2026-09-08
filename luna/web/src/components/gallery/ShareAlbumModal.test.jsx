import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ShareAlbumModal from "./ShareAlbumModal.jsx";

const ALBUM = {
  id: "alb-test-1",
  home_drive_id: "d1",
  name: "Summer Trip",
};

function renderModal(props = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ShareAlbumModal
        open
        album={ALBUM}
        onClose={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("ShareAlbumModal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders active invites and allows creating a link", async () => {
    const fetchMock = vi.fn(async (url, options) => {
      const u = String(url);
      const method = (options?.method || "GET").toUpperCase();

      if (u.includes("/gallery/albums/d1/alb-test-1/invites") && method === "GET") {
        return new Response(
          JSON.stringify([
            {
              id: "inv-existing",
              album_id: "alb-test-1",
              token: "tokexisting",
              url: "/a/tokexisting",
              role: "viewer",
              expires_at: null,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (u.includes("/gallery/albums/d1/alb-test-1/invites") && method === "POST") {
        return new Response(
          JSON.stringify({
            id: "inv-new",
            album_id: "alb-test-1",
            token: "toknew",
            url: "/a/toknew",
            role: "contributor",
            expires_at: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderModal();

    expect(screen.getByRole("heading", { name: 'Share "Summer Trip"' })).toBeInTheDocument();
    expect(await screen.findByText("View only")).toBeInTheDocument();
    expect(screen.getByText("Active links (1)")).toBeInTheDocument();

    // Click Generate link
    const generateBtn = screen.getByRole("button", { name: /Generate link/i });
    await user.click(generateBtn);

    expect(await screen.findByText("Link ready to share")).toBeInTheDocument();
  });

  it("allows revoking an existing invite link", async () => {
    let deleted = false;
    const fetchMock = vi.fn(async (url, options) => {
      const u = String(url);
      const method = (options?.method || "GET").toUpperCase();

      if (u.includes("/gallery/albums/d1/alb-test-1/invites/inv-revoke") && method === "DELETE") {
        deleted = true;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (u.includes("/gallery/albums/d1/alb-test-1/invites") && method === "GET") {
        return new Response(
          JSON.stringify(
            deleted
              ? []
              : [
                  {
                    id: "inv-revoke",
                    album_id: "alb-test-1",
                    token: "tokrevoke",
                    url: "/a/tokrevoke",
                    role: "contributor",
                    expires_at: null,
                  },
                ],
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderModal();

    expect(await screen.findByText("Can view & add")).toBeInTheDocument();
    const revokeBtn = screen.getByRole("button", { name: "Revoke link" });
    await user.click(revokeBtn);

    await waitFor(() => {
      expect(deleted).toBe(true);
    });
  });
});
