import { Suspense } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import lazyWithPreload from "./lazyWithPreload.js";

function Page() {
  return <p>Page content</p>;
}

describe("lazyWithPreload", () => {
  it("renders a preloaded page without showing the fallback", async () => {
    const loader = vi.fn(() => Promise.resolve({ default: Page }));
    const LazyPage = lazyWithPreload(loader);
    await LazyPage.preload();

    render(
      <Suspense fallback={<p>Loading</p>}>
        <LazyPage />
      </Suspense>,
    );

    expect(screen.getByText("Page content")).toBeInTheDocument();
    expect(screen.queryByText("Loading")).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("still loads on first render when nothing preloaded it", async () => {
    const LazyPage = lazyWithPreload(() => Promise.resolve({ default: Page }));

    render(
      <Suspense fallback={<p>Loading</p>}>
        <LazyPage />
      </Suspense>,
    );

    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(await screen.findByText("Page content")).toBeInTheDocument();
  });

  it("tries again after a failed preload", async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ default: Page });
    const LazyPage = lazyWithPreload(loader);

    await expect(LazyPage.preload()).rejects.toThrow("offline");
    await act(() => LazyPage.preload());

    render(
      <Suspense fallback={<p>Loading</p>}>
        <LazyPage />
      </Suspense>,
    );
    expect(screen.getByText("Page content")).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
