import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import PublicSharePage from "./PublicSharePage";

describe("PublicSharePage", () => {
  it("asks for the link password in plain language", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "This link needs its password." }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    )));
    render(
      <MemoryRouter initialEntries={["/s/abc"]}>
        <Routes>
          <Route path="/s/:token" element={<PublicSharePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/This link is locked/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Password for this link/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Open$/i })).toBeInTheDocument();
  });

  it("lists a shared folder and offers downloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        kind: "folder",
        path: "photos",
        entries: [
          { name: "beach.jpg", kind: "file", size: 12, hidden: false },
          { name: "album", kind: "dir", size: 0, hidden: false },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    render(
      <MemoryRouter initialEntries={["/s/abc"]}>
        <Routes>
          <Route path="/s/:token" element={<PublicSharePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.getByText("album")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download/i })).toHaveAttribute(
      "href",
      "/s/abc?path=beach.jpg&download=1",
    );
  });
});
