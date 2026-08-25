import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";
import LoadingBar from "./LoadingBar";

function NavProbe() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/drives")}>
      Go
    </button>
  );
}

describe("LoadingBar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts hidden and shows on navigation", () => {
    const { container, getByRole } = render(
      <MemoryRouter initialEntries={["/"]}>
        <LoadingBar />
        <Routes>
          <Route path="/" element={<NavProbe />} />
          <Route path="/drives" element={<div>Drives</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const bar = container.querySelector(".loading-bar");
    expect(bar).toBeTruthy();
    expect(bar.style.display).toBe("none");

    act(() => {
      getByRole("button", { name: "Go" }).click();
    });

    // Callback ref re-fires on remount when location.key changes — bar enters.
    expect(bar.className).toContain("loading-bar-enter");
    expect(bar.style.display).toBe("block");

    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(bar.className).not.toContain("loading-bar-enter");
    expect(bar.className).not.toContain("loading-bar-exit");

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(bar.className).toContain("loading-bar-exit");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(bar.style.display).toBe("none");
  });
});
