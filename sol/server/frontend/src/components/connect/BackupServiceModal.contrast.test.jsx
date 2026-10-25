import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserRouter } from "react-router-dom";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import BackupServiceModal from "./BackupServiceModal.jsx";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ default: apiMock }));

function renderModal() {
  return render(<BrowserRouter><ToastProvider><div className="surface-primary"><BackupServiceModal open service={{ state: "byo" }} repos={[]} onClose={vi.fn()} onSaved={vi.fn()} /></div></ToastProvider></BrowserRouter>);
}

describe("backup destination controls with real shared components", () => {
  beforeEach(() => {
    apiMock.mockImplementation((path) => Promise.resolve(new Response(JSON.stringify(path === "/apps" ? { apps: [{ id: "notes", name: "Notes" }] } : { repositories: [] }), { status: 200 })));
  });

  it("keeps save and cancel visible on the destination form", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole("button", { name: "Add Destination" }));
    const save = await screen.findByRole("button", { name: "Save destination" });
    await waitFor(() => expect(save).toBeEnabled());
    expect(save).toHaveAttribute("data-variant", "secondary");
    const cancel = screen.getAllByRole("button", { name: "Cancel" })[0];
    expect(cancel).toHaveAttribute("data-surface", "primary");
  });

  it("does not call a retained app destination shared after uninstall", async () => {
    apiMock.mockImplementation((path) => Promise.resolve(new Response(JSON.stringify(path === "/apps" ? { apps: [] } : { repositories: [{ id: "retained", app_id: "", repo_type: "local", repo_path: "/backups/retained", connect_managed: false, connect_ownership_known: true }] }), { status: 200 })));
    renderModal();
    expect(await screen.findByText("Saved backup destination")).toBeVisible();
    expect(screen.queryByText("Shared destination")).not.toBeInTheDocument();
  });

  it("keeps the app load error and retry visible on the destination form", async () => {
    apiMock.mockImplementation((path) => path === "/apps" ? Promise.reject(new Error("offline")) : Promise.resolve(new Response(JSON.stringify({ repositories: [] }), { status: 200 })));
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole("button", { name: "Add Destination" }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(retry).toHaveAttribute("data-surface", "primary");
    expect(screen.getByRole("alert")).toHaveClass("text-secondary");
  });
});
