import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import FilesPage from "./FilesPage";

describe("FilesPage", () => {
  it("shows the drop zone and empty folder", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "d1", label: "Photos Drive", state: "as_is", fs_type: "ext4", device: "sdz", mount_point: "/x" }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/files?")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 500 });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/drives/d1"]}>
          <Routes><Route path="/drives/:id" element={<FilesPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.getAllByText(/Drop files here/i).length).toBeGreaterThan(0);
  });
});
