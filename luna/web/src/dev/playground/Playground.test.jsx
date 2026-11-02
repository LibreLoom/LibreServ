import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { ShortcutsProvider } from "@libreloom/ui/context/ShortcutsContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import Playground from "./Playground.jsx";

function renderPlayground() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ShortcutsProvider>
          <Playground />
          <Toaster />
        </ShortcutsProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("file operation playground", () => {
  it("renders the knobs and the card's own controls", () => {
    renderPlayground();
    expect(screen.getByRole("heading", { name: "File operation card" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "What the next upload does" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "What the next copy or move does" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "One file" })).toBeTruthy();
  });

  it("starts an upload that reaches the dock", async () => {
    renderPlayground();
    fireEvent.click(screen.getByRole("button", { name: "One file" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "File tasks" })).toBeTruthy(),
    );
    expect(screen.getByText("Working on your files")).toBeTruthy();
  });

  it("shows the store state behind the card", async () => {
    renderPlayground();
    expect(screen.getByText("Nothing in the store.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "One file" }));
    await waitFor(() => expect(screen.getByText(/upload ·/)).toBeTruthy());
  });
});
