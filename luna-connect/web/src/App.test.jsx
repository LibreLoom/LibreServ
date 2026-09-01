import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByText(/\$8 \/ terabyte \/ month/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add a payment card/i })).toBeTruthy();
  });

  it("lists files when unlocked", () => {
    wrap(
      <BackupsTab
        me={{ has_card: true, estimated_month: 3.5 }}
        objects={[{ device_id: "d1", relative_path: "Photos/a.jpg" }]}
        note="This is the latest copy we have, not a history of old versions."
        paired
        onRefresh={vi.fn()}
        setError={vi.fn()}
        error=""
      />,
    );
    expect(screen.getByTestId("backups-open")).toBeTruthy();
    expect(screen.getByTestId("backup-monthly-cost")).toBeTruthy();
    expect(screen.getByText("$3.50")).toBeTruthy();
    expect(screen.getByTestId("backup-browser")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Photos" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Photos" }));
    expect(screen.getByText("a.jpg")).toBeTruthy();
    expect(screen.getByText(/latest copy/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Turn off payment/i })).toBeTruthy();
  });

  it("shows a prominent empty state when nothing is stored", () => {
    wrap(
      <BackupsTab
        me={{ has_card: true, estimated_month: 0 }}
        objects={[]}
        note=""
        paired
        onRefresh={vi.fn()}
        setError={vi.fn()}
        error=""
      />,
    );
    expect(screen.getByTestId("backup-empty-state")).toBeTruthy();
    expect(screen.getByText("Nothing stored yet")).toBeTruthy();
    expect(screen.getByText(/choose folders or a whole drive/i)).toBeTruthy();
  });

  it("opens a confirmation panel before turning payment off", () => {
    wrap(
      <BackupsTab
        me={{ has_card: true, estimated_month: 0 }}
        objects={[]}
        note=""
        paired
        onRefresh={vi.fn()}
        setError={vi.fn()}
        error=""
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Turn off payment/i }));
    expect(screen.getByTestId("backup-cancel-confirm")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Keep payment on/i })).toBeTruthy();
  });

  it("shows remaining days and add-card when a purge clock is running", () => {
    const later = Math.floor(Date.now() / 1000) + 10 * 86400;
    wrap(
      <BackupsTab
        me={{ has_card: false, backup_purge_after: later }}
        objects={[{ device_id: "d1", relative_path: "Photos/a.jpg" }]}
        note=""
        paired={false}
        onRefresh={vi.fn()}
        setError={vi.fn()}
        error=""
      />,
    );
    expect(screen.getByTestId("backups-purging")).toBeTruthy();
    expect(screen.getByText(/10 more days/i)).toBeTruthy();
    expect(screen.getByText(/Download anything you need/i)).toBeTruthy();
    expect(screen.getByText(/no longer paired/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add a payment card/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Photos" })).toBeTruthy();
  });
});
