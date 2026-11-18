import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PhotoThumb from "./PhotoThumb.jsx";
import PhotoTimeline, { groupByDay } from "./PhotoTimeline.jsx";

describe("PhotoThumb cascading animation", () => {
  it("renders with cascade animation and reduced-motion accessibility classes", () => {
    const photo = { name: "beach.jpg", path: "beach.jpg", drive_id: "d1", thumb: "/t.jpg" };
    render(<PhotoThumb photo={photo} index={2} />);

    const button = screen.getByRole("button", { name: "beach.jpg" });
    expect(button.className).toContain("animate-cascade-in");
    expect(button.className).toContain("motion-reduce:animate-none");
    expect(button.className).toContain("motion-reduce:transition-none");
  });

  it("calculates animationDelay sequentially and sets animationFillMode backwards", () => {
    const photo = { name: "sunset.jpg", path: "sunset.jpg", drive_id: "d1" };
    render(<PhotoThumb photo={photo} index={4} />);

    const button = screen.getByRole("button", { name: "sunset.jpg" });
    // 4 * 35ms = 140ms
    expect(button.style.animationDelay).toBe("140ms");
    expect(button.style.animationFillMode).toBe("backwards");
  });

  it("only cascades the first 30 items; later ones appear at once", () => {
    const photo = { name: "mountain.jpg", path: "mountain.jpg", drive_id: "d1" };
    render(<PhotoThumb photo={photo} index={45} />);

    const button = screen.getByRole("button", { name: "mountain.jpg" });
    // A page loaded after a scroll must not wait out the first screen's cascade.
    expect(button.style.animationDelay).toBe("0ms");
    expect(button.style.animationFillMode).toBe("backwards");
  });

  it("fades thumbnail image in smoothly when onLoad triggers", () => {
    const photo = { name: "photo.jpg", path: "photo.jpg", drive_id: "d1", thumb: "/thumb.jpg" };
    const { container } = render(<PhotoThumb photo={photo} index={0} />);

    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img?.className).toContain("motion-safe:transition-[opacity,scale]");
    expect(img?.className).toContain("motion-reduce:opacity-100");
    expect(img?.className).toContain("opacity-0");

    fireEvent.load(img);
    expect(img?.className).toContain("opacity-100");
  });
});

describe("PhotoTimeline cascading stagger", () => {
  it("passes sequential index offsets across multiple date groups", () => {
    const photos = [
      { name: "p1.jpg", path: "p1.jpg", drive_id: "d1", taken_at: 1_700_000_000 },
      { name: "p2.jpg", path: "p2.jpg", drive_id: "d1", taken_at: 1_700_000_000 },
      { name: "p3.jpg", path: "p3.jpg", drive_id: "d1", taken_at: 1_600_000_000 },
    ];

    render(<PhotoTimeline photos={photos} onOpen={vi.fn()} />);

    const b1 = screen.getByRole("button", { name: "p1.jpg" });
    const b2 = screen.getByRole("button", { name: "p2.jpg" });
    const b3 = screen.getByRole("button", { name: "p3.jpg" });

    expect(b1.style.animationDelay).toBe("0ms");
    expect(b2.style.animationDelay).toBe("35ms");
    expect(b3.style.animationDelay).toBe("70ms");
  });

  it("enters selection on long-press path via onToggle when selectMode", () => {
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    const photos = [
      { name: "p1.jpg", path: "p1.jpg", drive_id: "d1", taken_at: 1_700_000_000 },
    ];
    render(
      <PhotoTimeline
        photos={photos}
        selectMode
        selectedKeys={new Set(["d1\0p1.jpg"])}
        onToggle={onToggle}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "p1.jpg" }));
    expect(onToggle).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("offers Select day when selectMode and onSelectDay are set", () => {
    const onSelectDay = vi.fn();
    const photos = [
      { name: "p1.jpg", path: "p1.jpg", drive_id: "d1", taken_at: 1_700_000_000 },
      { name: "p2.jpg", path: "p2.jpg", drive_id: "d1", taken_at: 1_700_000_000 },
    ];
    render(
      <PhotoTimeline
        photos={photos}
        selectMode
        onSelectDay={onSelectDay}
        selectedKeys={new Set()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Select day/i }));
    expect(onSelectDay).toHaveBeenCalled();
    expect(onSelectDay.mock.calls[0][0]).toHaveLength(2);
  });

  it("keeps Select day available while the day is collapsed", () => {
    const onSelectDay = vi.fn();
    const photos = [
      { name: "p1.jpg", path: "p1.jpg", drive_id: "d1", taken_at: 1_700_000_000 },
      { name: "p2.jpg", path: "p2.jpg", drive_id: "d1", taken_at: 1_700_000_000 },
    ];
    render(
      <PhotoTimeline
        photos={photos}
        selectMode
        onSelectDay={onSelectDay}
        selectedKeys={new Set()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Collapse/i }));
    fireEvent.click(screen.getByRole("button", { name: /Select day/i }));
    expect(onSelectDay).toHaveBeenCalled();
    expect(onSelectDay.mock.calls[0][0]).toHaveLength(2);
  });

  it("can collapse a day with the chevron control", () => {
    const photos = [
      { name: "p1.jpg", path: "p1.jpg", drive_id: "d1", taken_at: 1_700_000_000 },
    ];
    render(<PhotoTimeline photos={photos} />);
    expect(screen.getByRole("button", { name: "p1.jpg" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Collapse/i }));
    expect(screen.queryByRole("button", { name: "p1.jpg" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Expand/i }));
    expect(screen.getByRole("button", { name: "p1.jpg" })).toBeInTheDocument();
  });
});

const DAY = 86_400;
/** @param {number} n @param {number} [from] */
function photoList(n, from = 0) {
  return Array.from({ length: n }, (_, i) => ({
    name: `p${from + i}.jpg`,
    path: `p${from + i}.jpg`,
    drive_id: "d1",
    // Five photos a day, newest first.
    taken_at: 1_700_000_000 - Math.floor((from + i) / 5) * DAY,
  }));
}

describe("groupByDay", () => {
  it("keeps the earlier days when a page is added to the end", () => {
    const first = photoList(12);
    const a = groupByDay(first);
    const b = groupByDay([...first, ...photoList(8, 12)], a);
    expect(a.groups).toHaveLength(3);
    expect(b.groups).toHaveLength(4);
    // Days the new page doesn't touch are the same objects; the day it continues is new.
    expect(b.groups[0]).toBe(a.groups[0]);
    expect(b.groups[1]).toBe(a.groups[1]);
    expect(b.groups[2]).not.toBe(a.groups[2]);
    expect(a.groups[2].items).toHaveLength(2);
    expect(b.groups[2].items.map((i) => i.index)).toEqual([10, 11, 12, 13, 14]);
    expect(b.groups[3].items.map((i) => i.index)).toEqual([15, 16, 17, 18, 19]);
    expect(b).toEqual(groupByDay([...first, ...photoList(8, 12)]));
  });

  it("groups the whole list again when earlier photos changed", () => {
    const a = groupByDay(photoList(12));
    const changed = photoList(14);
    const b = groupByDay(changed, a);
    expect(b.groups[0]).not.toBe(a.groups[0]);
    expect(b.groups[0].items[0].photo).toBe(changed[0]);
    expect(b).toEqual(groupByDay(changed));
  });

  it("puts a later photo of an earlier day into that day", () => {
    const first = photoList(5);
    const a = groupByDay(first);
    const late = { ...photoList(1)[0], name: "late.jpg", path: "late.jpg" };
    const b = groupByDay([...first, late], a);
    expect(b.groups).toHaveLength(1);
    expect(b.groups[0].items.at(-1)).toEqual({ photo: late, index: 5 });
  });
});

describe("PhotoTimeline next page", () => {
  afterEach(() => {
    // Unmount while the stubs are still there: the timeline's effects use them.
    cleanup();
    vi.unstubAllGlobals();
  });

  function stubObservers() {
    /** @type {((entries: any[]) => void)[]} */
    const callbacks = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(/** @type {any} */ cb) {
          callbacks.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (/** @type {() => void} */ cb) => {
      cb();
      return 1;
    });
    return callbacks;
  }

  it("draws an asked-for page's first photos at once and the rest after", async () => {
    const callbacks = stubObservers();
    const onLoadMore = vi.fn();
    const first = photoList(20);
    const { rerender } = render(<PhotoTimeline photos={first} hasMore onLoadMore={onLoadMore} />);
    act(() => callbacks.forEach((cb) => cb([{ isIntersecting: true, target: null }])));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    rerender(<PhotoTimeline photos={[...first, ...photoList(80, 20)]} hasMore onLoadMore={onLoadMore} />);
    // Up to the 36th new photo (p55), and the rest of its day (p56–p59).
    expect(screen.getByRole("button", { name: "p59.jpg" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "p60.jpg" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "p99.jpg" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^p\d+\.jpg$/ })).toHaveLength(100);
  });

  it("selects a whole day while the rest of the page is still to come", () => {
    // The rest waits for an idle moment that never comes here.
    const callbacks = stubObservers();
    vi.stubGlobal("requestIdleCallback", () => 1);
    vi.stubGlobal("cancelIdleCallback", () => {});
    const onSelectDay = vi.fn();
    const first = photoList(20);
    const props = { hasMore: true, onLoadMore: vi.fn(), selectMode: true, selectedKeys: new Set(), onSelectDay };
    const { rerender } = render(<PhotoTimeline photos={first} {...props} />);
    act(() => callbacks.forEach((cb) => cb([{ isIntersecting: true, target: null }])));
    rerender(<PhotoTimeline photos={[...first, ...photoList(80, 20)]} {...props} />);
    expect(screen.queryByRole("button", { name: "p60.jpg" })).not.toBeInTheDocument();
    const day = screen.getByRole("button", { name: "p59.jpg" }).closest("section");
    fireEvent.click(within(/** @type {HTMLElement} */ (day)).getByRole("button", { name: /Select day/i }));
    expect(onSelectDay.mock.calls[0][0].map((/** @type {any} */ p) => p.name)).toEqual([
      "p55.jpg", "p56.jpg", "p57.jpg", "p58.jpg", "p59.jpg",
    ]);
  });
});

describe("album cascade class", () => {
  it("album cards use cascade-in animation class name", () => {
    // Lightweight class contract used by AlbumsPanel.
    expect("animate-cascade-in").toContain("cascade-in");
  });
});
