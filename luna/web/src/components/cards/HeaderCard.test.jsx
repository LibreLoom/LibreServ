import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import HeaderCard from "./HeaderCard";

describe("HeaderCard auto-split", () => {
  /** @type {ResizeObserverCallback[]} */
  let observers = [];
  /** @type {{ clientWidth: number, scrollWidth: number }} */
  let defaultContainer;
  /** @type {{ clientWidth: number, scrollWidth: number }} */
  let defaultProbe;

  beforeEach(() => {
    observers = [];
    defaultContainer = { clientWidth: 900, scrollWidth: 900 };
    defaultProbe = { clientWidth: 200, scrollWidth: 200 };

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        if (this.getAttribute?.("data-slot")?.startsWith("header-card")) {
          return defaultContainer.clientWidth;
        }
        if (this.parentElement?.getAttribute?.("aria-hidden") === "true") {
          return defaultProbe.clientWidth;
        }
        return 800;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get() {
        if (this.parentElement?.getAttribute?.("aria-hidden") === "true") {
          return defaultProbe.scrollWidth;
        }
        if (this.getAttribute?.("data-slot")?.startsWith("header-card")) {
          return defaultContainer.scrollWidth;
        }
        return 800;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return 32;
      },
    });

    globalThis.ResizeObserver = class {
      /** @param {ResizeObserverCallback} cb */
      constructor(cb) {
        observers.push(cb);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    // @ts-expect-error cleanup test polyfill
    delete HTMLElement.prototype.clientWidth;
    // @ts-expect-error cleanup test polyfill
    delete HTMLElement.prototype.scrollWidth;
    // @ts-expect-error cleanup test polyfill
    delete HTMLElement.prototype.offsetHeight;
  });

  it("keeps a single combined pill when title and chrome fit", async () => {
    vi.useFakeTimers();
    defaultContainer = { clientWidth: 900, scrollWidth: 900 };
    defaultProbe = { clientWidth: 200, scrollWidth: 200 };

    const { container } = render(
      <HeaderCard title="Home" rightContent={<span>OK</span>} />,
    );

    await act(async () => {
      vi.advanceTimersByTime(60);
      observers.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });

    expect(container.querySelector("[data-slot=header-card-combined]")).toBeTruthy();
    expect(container.querySelector("[data-slot=header-card-split]")).toBeNull();
    expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
  });

  it("splits into stacked cards when chrome does not fit the pill", async () => {
    vi.useFakeTimers();
    defaultContainer = { clientWidth: 280, scrollWidth: 280 };
    defaultProbe = { clientWidth: 500, scrollWidth: 500 };

    const { container } = render(
      <HeaderCard
        title="Hello there, long greeting"
        rightContent={<span>Everything looks good</span>}
      />,
    );

    await act(async () => {
      vi.advanceTimersByTime(60);
      observers.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });

    expect(container.querySelector("[data-slot=header-card-split]")).toBeTruthy();
    expect(container.querySelector("[data-slot=header-card-combined]")).toBeNull();
    expect(screen.getByRole("heading", { name: "Hello there, long greeting" })).toBeTruthy();
    const splitRoot = container.querySelector("[data-slot=header-card-split]");
    expect(splitRoot?.textContent).toContain("Everything looks good");
    // Visible status card plus the aria-hidden measure probe.
    expect(screen.getAllByText("Everything looks good").length).toBeGreaterThanOrEqual(1);
  });

  it("stays a single card when there is no side chrome", () => {
    const { container } = render(<HeaderCard title="Drives" />);
    expect(container.querySelector("[data-slot=header-card-combined]")).toBeTruthy();
    expect(container.querySelector("[data-slot=header-card-split]")).toBeNull();
    expect(container.querySelector("[aria-hidden=true]")).toBeNull();
  });
});
