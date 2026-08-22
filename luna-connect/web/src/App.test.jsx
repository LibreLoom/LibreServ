import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BackupsTab } from "./pages/BackupsPage.jsx";

function wrap(ui) {
  return render(ui);
}

describe("Cloud backups tab", () => {
  it("asks for a card when backups are locked", () => {
    wrap(
      <BackupsTab
        me={{ has_card: false }}
        objects={[]}
        note=""
        onRefresh={vi.fn()}
        setError={vi.fn()}
        error=""
      />,
    );
    expect(screen.getByTestId("backups-gated")).toBeTruthy();
    expect(screen.getByText(/\$7 per terabyte each month/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add a payment card/i })).toBeTruthy();
  });

  it("lists files when unlocked", () => {
    wrap(
      <BackupsTab
        me={{ has_card: true, estimated_month: 3.5 }}
        objects={[{ device_id: "d1", relative_path: "Photos/a.jpg" }]}
        note="This is the latest copy we have, not a history of old versions."
        onRefresh={vi.fn()}
        setError={vi.fn()}
        error=""
      />,
    );
    expect(screen.getByTestId("backups-open")).toBeTruthy();
    expect(screen.getByText("Photos/a.jpg")).toBeTruthy();
    expect(screen.getByText(/latest copy/i)).toBeTruthy();
  });
});
