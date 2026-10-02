import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@libreloom/ui/context/ThemeContext.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { AuthProvider } from "../../context/AuthContext";
import DriveFileExplorer from "./DriveFileExplorer.jsx";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function renderExplorer() {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    let body = null;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push([method, u, body]);
    if (u.endsWith("/api/v1/auth/me")) {
      return json({ id: "u1", username: "max", role: "admin" });
    }
    if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: true });
    if (u.endsWith("/api/v1/setup")) return json({ setup_completed: true });
    if (u.endsWith("/api/v1/drives")) return json([{ id: "d1", label: "Photos", state: "mounted" }]);
    if (u.includes("/files/mkdir") || u.includes("/files/create") || u.includes("/files/upload")) {
      return json({ ok: true });
    }
    if (u.includes("/api/v1/drives/d1/files")) return json([]);
    return json([]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider>
    <ToastProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AuthProvider>
            <DriveFileExplorer driveId="d1" driveLabel="Photos" isAdmin />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ToastProvider>
    </ThemeProvider>,
  );
  return calls;
}

async function openNewMenu() {
  fireEvent.click(await screen.findByRole("button", { name: "New" }));
  return screen.findByRole("menu", { name: "New" });
}

describe("DriveFileExplorer private folders", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists Private folder right after Folder in the New menu — folders only", async () => {
    renderExplorer();
    const menu = await openNewMenu();
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "Private folder" })).toBeInTheDocument());
    const items = within(menu).getAllByRole("menuitem").map((el) => el.textContent);
    expect(items.indexOf("Private folder")).toBe(items.indexOf("Folder") + 1);
    expect(within(menu).queryByRole("menuitem", { name: "Private file" })).not.toBeInTheDocument();
  });

  it("creates a private folder with private: true", async () => {
    const calls = renderExplorer();
    const menu = await openNewMenu();
    fireEvent.click(await within(menu).findByRole("menuitem", { name: "Private folder" }));
    const field = await screen.findByLabelText("Name for this private folder");
    fireEvent.change(field, { target: { value: "Taxes" } });
    // The one-line reality check sits on the surface; the rest is a tap away.
    expect(
      screen.getByText(/private folder is only visible to you and the people you share it with/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create private folder" }));
    await waitFor(() => {
      expect(calls.find(([m, u]) => m === "POST" && u.endsWith("/files/mkdir"))?.[2])
        .toEqual({ path: "Taxes", private: true });
    });
  });
});
