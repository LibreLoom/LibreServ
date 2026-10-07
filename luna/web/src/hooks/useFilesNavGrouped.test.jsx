import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FILES_NAV_GROUPED_KEY, useFilesNavGrouped } from "./useFilesNavGrouped.js";

function Reader({ label }) {
  const [grouped, setGrouped] = useFilesNavGrouped();
  return (
    <button type="button" onClick={() => setGrouped(!grouped)}>
      {label}: {grouped ? "on" : "off"}
    </button>
  );
}

describe("useFilesNavGrouped", () => {
  beforeEach(() => {
    window.localStorage.removeItem(FILES_NAV_GROUPED_KEY);
  });

  it("is off when nothing is stored", () => {
    render(<Reader label="nav" />);
    expect(screen.getByRole("button", { name: "nav: off" })).toBeTruthy();
  });

  it("wakes every mounted reader in the same page when one flips it", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Reader label="switch" />
        <Reader label="navbar" />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "switch: off" }));

    // The second reader (the nav bar's copy) re-renders without a reload.
    expect(screen.getByRole("button", { name: "switch: on" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "navbar: on" })).toBeTruthy();
    expect(window.localStorage.getItem(FILES_NAV_GROUPED_KEY)).toBe("1");

    await user.click(screen.getByRole("button", { name: "switch: on" }));
    expect(screen.getByRole("button", { name: "navbar: off" })).toBeTruthy();
    expect(window.localStorage.getItem(FILES_NAV_GROUPED_KEY)).toBeNull();
  });
});
