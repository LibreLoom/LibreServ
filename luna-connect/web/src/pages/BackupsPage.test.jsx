import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BackupsTab } from "./BackupsPage.jsx";

function wrap(ui) {
  return render(ui);
}

describe("BackupsPage", () => {
  it("asks for a card when backups are locked", () => {
    wrap(
      <BackupsTab
        me={{ has_card: false }}
        objects={[]}
        note=""
        paired
        onRefresh={vi.fn()}
        setError={vi.fn()}
        error=""
      />,
    );
    expect(screen.getByTestId("backups-gated")).toBeTruthy();
    expect(screen.getByTestId("backups-files")).toBeTruthy();
    expect(screen.getByText(/\$8 \/ terabyte \/ month/i)).toBeTruthy();
    expect(screen.getByText(/Free each month/i)).toBeTruthy();
    expect(screen.getByText(/average storage/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add a payment card/i })).toBeTruthy();
    expect(screen.getByTestId("backup-empty-state")).toBeTruthy();
  });

  it("lists files in a separate card when unlocked", () => {
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
    expect(screen.getByTestId("backups-files")).toBeTruthy();
    expect(screen.getByTestId("backup-monthly-cost")).toBeTruthy();
    expect(screen.getByTestId("backup-browser")).toBeTruthy();
    expect(screen.getByText("$3.50")).toBeTruthy();
    expect(screen.getByText(/This month/i)).toBeTruthy();
    expect(screen.getByText(/\$0\.01 \/ GB/i)).toBeTruthy();
    expect(screen.getByText(/latest copy/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Turn off payment/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Photos" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Photos" }));
    expect(screen.getByText("a.jpg")).toBeTruthy();
  });

  it("uses destructive variant for turn off payment", () => {
    wrap(
      <BackupsTab
        me={{ has_card: true, estimated_month: 1 }}
        objects={[]}
        note=""
        paired
        onRefresh={vi.fn()}
        setError={vi.fn()}
        error=""
      />,
    );
    const turnOff = screen.getByRole("button", { name: /Turn off payment/i });
    expect(turnOff.className).toMatch(/destructive/);
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
    expect(screen.getByTestId("backups-files")).toBeTruthy();
    expect(screen.getByText(/10 more days/i)).toBeTruthy();
    expect(screen.getByText(/Download anything you need/i)).toBeTruthy();
    expect(screen.getByText(/no longer paired/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add a payment card/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Photos" })).toBeTruthy();
  });
});
