import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import TipPill from "./TipPill.jsx";
import { readTipState } from "../../lib/tips.js";

function renderPill() {
  return render(
    <ToastProvider>
      <TipPill />
      <Toaster />
    </ToastProvider>,
  );
}

describe("TipPill", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal("matchMedia", (query) => ({ matches: true, media: query }));
  });

  it("shows the keyboard shortcut tip", () => {
    renderPill();
    expect(screen.getByText("Press ? for shortcuts")).toBeInTheDocument();
  });

  it("skips the keyboard tip on touch devices", () => {
    vi.stubGlobal("matchMedia", (query) => ({ matches: false, media: query }));
    renderPill();
    expect(screen.queryByText(/for shortcuts/)).not.toBeInTheDocument();
  });

  it("keeps the same tip when the page reloads in one session", () => {
    const first = renderPill();
    first.unmount();
    renderPill();
    expect(screen.getByText(/for shortcuts/)).toBeInTheDocument();
  });

  it("hides just this tip", async () => {
    renderPill();
    await userEvent.click(screen.getByRole("button", { name: "Hide tips" }));
    await userEvent.click(screen.getByRole("option", { name: "Hide this tip" }));
    expect(screen.queryByText(/for shortcuts/)).not.toBeInTheDocument();
    expect(readTipState().dismissed).toEqual(["keyboard-shortcuts"]);
    expect(readTipState().enabled).toBe(true);
  });

  it("turns off all tips and says where to turn them back on", async () => {
    renderPill();
    await userEvent.click(screen.getByRole("button", { name: "Hide tips" }));
    await userEvent.click(screen.getByRole("option", { name: "Turn off all tips" }));
    expect(screen.queryByText(/for shortcuts/)).not.toBeInTheDocument();
    expect(readTipState().enabled).toBe(false);
    expect(await screen.findByText(/Settings → Appearance/)).toBeInTheDocument();
  });

  it("shows nothing when tips are off", () => {
    localStorage.setItem("luna-tips", JSON.stringify({ enabled: false }));
    renderPill();
    expect(screen.queryByText(/for shortcuts/)).not.toBeInTheDocument();
  });
});
