import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../context/AuthContext";
import { notfound as quips } from "../assets/greetings.jsx";
import NotFoundPage from "./NotFoundPage";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage(path = "/this-page-is-not-real") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <NotFoundPage />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NotFoundPage", () => {
  it("explains the miss, shows the path, and offers a way home", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("/auth/me")) return jsonResponse({ error: "nope" }, 401);
        if (u.includes("/api/v1/setup")) return jsonResponse({ name: "Luna", setup_completed: true });
        return jsonResponse({}, 404);
      }),
    );
    renderPage("/missing-room");
    expect(await screen.findByRole("heading", { name: "Nothing here" })).toBeTruthy();
    expect(screen.getByText("This isn't a place on Luna")).toBeTruthy();
    expect(screen.getByText("/missing-room")).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Home$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Go back/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Drives/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Photos/i })).toBeTruthy();
    const body = document.body.textContent || "";
    expect(quips.some((line) => body.includes(line))).toBe(true);
  });
});
