import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import NeedsYou from "./NeedsYou.jsx";

/** @typedef {import("./NeedsYou.jsx").NeedsYouItem} NeedsYouItem */

/** @returns {NeedsYouItem} */
function problem(overrides = {}) {
  return {
    id: "drive-failed:d1",
    rank: 10,
    tone: "problem",
    title: [{ name: "Backup drive" }, " ran into a problem"],
    ...overrides,
  };
}

/** @returns {NeedsYouItem} */
function info(overrides = {}) {
  return {
    id: "new-drive",
    rank: 70,
    tone: "info",
    title: ["New drive plugged in"],
    ...overrides,
  };
}

/** `count` plain problem rows named Item 1, Item 2, ... in that order. */
function manyItems(count) {
  return Array.from({ length: count }, (_, i) =>
    problem({ id: `check:item-${i + 1}`, rank: 20 + i, title: [`Item ${i + 1}`] }),
  );
}

function renderZone(items, onAction = vi.fn()) {
  const view = render(
    <MemoryRouter>
      <NeedsYou items={items} onAction={onAction} />
    </MemoryRouter>,
  );
  return { ...view, onAction };
}

describe("NeedsYou", () => {
  describe("nothing to show", () => {
    it("renders nothing for an empty list", () => {
      const { container } = renderZone([]);
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole("region")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    });

    it("renders nothing when items is undefined", () => {
      const { container } = renderZone(undefined);
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole("region")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    });
  });

  describe("frame", () => {
    it("is a labelled region with a visible heading", () => {
      renderZone([problem()]);
      expect(screen.getByRole("region", { name: "Needs you" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Needs you" })).toBeVisible();
    });

    it("lists the rows as a list", () => {
      renderZone([problem(), info()]);
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });
  });

  describe("tone", () => {
    it("shows the warning triangle for a problem row", () => {
      renderZone([problem()]);
      const row = screen.getByRole("listitem");
      expect(row).toHaveAttribute("data-tone", "problem");
      const icon = row.querySelector("svg");
      expect(icon).toHaveClass("lucide-triangle-alert");
      expect(icon).toHaveClass("text-error");
      expect(icon).toHaveAttribute("aria-hidden", "true");
    });

    it("shows the info icon for an info row", () => {
      renderZone([info()]);
      const row = screen.getByRole("listitem");
      expect(row).toHaveAttribute("data-tone", "info");
      const icon = row.querySelector("svg");
      expect(icon).toHaveClass("lucide-info");
      expect(icon).toHaveClass("text-info");
      expect(icon).toHaveAttribute("aria-hidden", "true");
    });

    it("keeps status colors off the text", () => {
      renderZone([problem({ detail: "Check the cable." }), info({ detail: "Nothing changes yet." })]);
      const text = screen.getByRole("region").querySelectorAll("p");
      for (const p of text) {
        expect(p.className).not.toMatch(/text-(error|info|warning|success)/);
      }
    });
  });

  describe("title", () => {
    it("wears names as pills and leaves plain text alone", () => {
      renderZone([problem({ title: [{ name: "Photos" }, " backup didn't finish"] })]);
      const row = screen.getByRole("listitem");
      const pill = row.querySelector('[data-slot="inline-pill"]');
      expect(pill).not.toBeNull();
      expect(pill).toHaveTextContent("Photos");
      expect(pill?.nextSibling?.textContent).toBe(" backup didn't finish");
    });

    it("adds no quote characters or extra spaces around names", () => {
      renderZone([problem({ title: [{ name: "Photos" }, " backup didn't finish"] })]);
      const title = screen.getByRole("listitem").querySelector("p");
      expect(title?.textContent).toBe("Photos backup didn't finish");
      expect(title?.textContent).not.toMatch(/["“”]/);
    });

    it("renders several names in order", () => {
      renderZone([
        problem({ title: [{ name: "Photos" }, " is copied to ", { name: "Backup drive" }] }),
      ]);
      const pills = screen.getByRole("listitem").querySelectorAll('[data-slot="inline-pill"]');
      expect([...pills].map((p) => p.textContent)).toEqual(["Photos", "Backup drive"]);
      expect(screen.getByRole("listitem").querySelector("p")?.textContent).toBe(
        "Photos is copied to Backup drive",
      );
    });

    it("renders an all-text title without a pill", () => {
      renderZone([info({ title: ["Check your recovery phrase"] })]);
      expect(screen.getByText("Check your recovery phrase")).toBeInTheDocument();
      expect(screen.getByRole("listitem").querySelector('[data-slot="inline-pill"]')).toBeNull();
    });
  });

  describe("detail", () => {
    it("shows the detail sentence when there is one", () => {
      renderZone([problem({ detail: "The last copy did not finish." })]);
      expect(screen.getByText("The last copy did not finish.")).toBeVisible();
    });

    it("shows no detail line when there is none", () => {
      renderZone([problem()]);
      expect(screen.getByRole("listitem").querySelectorAll("p")).toHaveLength(1);
    });
  });

  describe("actions", () => {
    it("renders a link for an href action", () => {
      renderZone([problem({ action: { label: "Open Files", href: "/files" } })]);
      const link = screen.getByRole("link", { name: "Open Files" });
      expect(link).toHaveAttribute("href", "/files");
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("keeps a hash in the link target", () => {
      renderZone([problem({ action: { label: "Open system checks", href: "/settings#about" } })]);
      expect(screen.getByRole("link", { name: "Open system checks" })).toHaveAttribute(
        "href",
        "/settings#about",
      );
    });

    it("lets ariaLabel override the link's accessible name", () => {
      renderZone([
        problem({ action: { label: "Open", ariaLabel: "Open Photos backup", href: "/files" } }),
      ]);
      expect(screen.getByRole("link", { name: "Open Photos backup" })).toHaveTextContent("Open");
      expect(screen.queryByRole("link", { name: "Open" })).not.toBeInTheDocument();
    });

    it("leaves aria-label off a link when ariaLabel is not given", () => {
      renderZone([problem({ action: { label: "Open Files", href: "/files" } })]);
      expect(screen.getByRole("link")).not.toHaveAttribute("aria-label");
    });

    it("renders a button for an intent action and calls onAction once with the item", async () => {
      const item = info({ action: { label: "Add drive", intent: "open-backup" } });
      const { onAction } = renderZone([item]);
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Add drive" }));
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(onAction.mock.calls[0][0]).toBe(item);
    });

    it("passes the payload along inside the item", async () => {
      const row = { id: "b1", source_name: "Photos" };
      const item = problem({
        id: "backup:drive:b1",
        action: { label: "Open", intent: "open-backup", payload: row },
      });
      const { onAction } = renderZone([item]);
      await userEvent.click(screen.getByRole("button", { name: "Open" }));
      expect(onAction).toHaveBeenCalledWith(item);
      expect(onAction.mock.calls[0][0].action.payload).toBe(row);
    });

    it("lets ariaLabel override the button's accessible name", async () => {
      const item = problem({
        action: { label: "Open", ariaLabel: "Open Photos backup", intent: "open-backup" },
      });
      const { onAction } = renderZone([item]);
      expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Open Photos backup" }));
      expect(onAction).toHaveBeenCalledTimes(1);
    });

    it("leaves aria-label off a button when ariaLabel is not given", () => {
      renderZone([info({ action: { label: "Check now", intent: "check-phrase" } })]);
      expect(screen.getByRole("button", { name: "Check now" })).not.toHaveAttribute("aria-label");
    });

    it("calls onAction for the row that was pressed", async () => {
      const first = problem({
        id: "backup:drive:a",
        action: { label: "Open", ariaLabel: "Open Photos backup", intent: "open-backup" },
      });
      const second = problem({
        id: "backup:drive:b",
        rank: 41,
        action: { label: "Open", ariaLabel: "Open Music backup", intent: "open-backup" },
      });
      const { onAction } = renderZone([first, second]);
      await userEvent.click(screen.getByRole("button", { name: "Open Music backup" }));
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(onAction.mock.calls[0][0]).toBe(second);
    });

    it("does not call onAction for a link", async () => {
      const { onAction } = renderZone([problem({ action: { label: "Open Files", href: "/files" } })]);
      await userEvent.click(screen.getByRole("link", { name: "Open Files" }));
      expect(onAction).not.toHaveBeenCalled();
    });

    it("renders no button or link for a row without an action", () => {
      renderZone([info({ id: "no-drives", detail: "Plug a USB drive into Luna to get started." })]);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("renders no button for an action with neither href nor intent", () => {
      renderZone([info({ action: { label: "Nothing to press" } })]);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("gives each row at most one action", () => {
      renderZone([
        problem({ action: { label: "Open Files", href: "/files" } }),
        info({ action: { label: "Add drive", intent: "open-backup" } }),
        info({ id: "no-drives", rank: 100 }),
      ]);
      for (const row of screen.getAllByRole("listitem")) {
        expect(within(row).queryAllByRole("button").length + within(row).queryAllByRole("link").length)
          .toBeLessThanOrEqual(1);
      }
    });
  });

  describe("order", () => {
    it("keeps the order of the items prop", () => {
      const items = [
        info({ id: "phrase-check", rank: 90, title: ["Check your recovery phrase"] }),
        problem({ id: "drive-failed:d1", rank: 10, title: ["Zebra drive"] }),
        problem({ id: "backup:drive:b1", rank: 40, title: ["Apple backup"] }),
      ];
      renderZone(items);
      const rows = screen.getAllByRole("listitem");
      expect(rows.map((r) => r.querySelector("p")?.textContent)).toEqual([
        "Check your recovery phrase",
        "Zebra drive",
        "Apple backup",
      ]);
    });
  });

  describe("long lists", () => {
    it("shows every row and no toggle for up to five items", () => {
      renderZone(manyItems(5));
      expect(screen.getAllByRole("listitem")).toHaveLength(5);
      expect(screen.queryByRole("button", { name: /show/i })).not.toBeInTheDocument();
    });

    it("shows one row and no toggle for a single item", () => {
      renderZone(manyItems(1));
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: /show/i })).not.toBeInTheDocument();
    });

    it("folds the rest behind a toggle at six items", () => {
      renderZone(manyItems(6));
      expect(screen.getAllByRole("listitem")).toHaveLength(5);
      expect(screen.getByRole("button", { name: "Show 1 more" })).toBeInTheDocument();
    });

    it("shows five of seven rows, expands to all seven, and folds back", async () => {
      renderZone(manyItems(7));
      expect(screen.getAllByRole("listitem")).toHaveLength(5);
      expect(screen.queryByText("Item 6")).not.toBeInTheDocument();

      const more = screen.getByRole("button", { name: "Show 2 more" });
      expect(more).toHaveAttribute("aria-expanded", "false");
      await userEvent.click(more);
      expect(screen.getAllByRole("listitem")).toHaveLength(7);
      expect(screen.getByText("Item 7")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Show 2 more" })).not.toBeInTheDocument();

      const fewer = screen.getByRole("button", { name: "Show fewer" });
      expect(fewer).toHaveAttribute("aria-expanded", "true");
      await userEvent.click(fewer);
      expect(screen.getAllByRole("listitem")).toHaveLength(5);
      expect(screen.queryByText("Item 6")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show 2 more" })).toBeInTheDocument();
    });

    it("keeps the order when expanded", async () => {
      renderZone(manyItems(7));
      await userEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
      const titles = screen.getAllByRole("listitem").map((r) => r.querySelector("p")?.textContent);
      expect(titles).toEqual(["Item 1", "Item 2", "Item 3", "Item 4", "Item 5", "Item 6", "Item 7"]);
    });

    it("keeps the row buttons working while expanded", async () => {
      const items = [
        ...manyItems(5),
        problem({
          id: "backup:drive:last",
          rank: 99,
          title: ["Last row"],
          action: { label: "Open", ariaLabel: "Open Last row", intent: "open-backup" },
        }),
      ];
      const { onAction } = renderZone(items);
      expect(screen.queryByRole("button", { name: "Open Last row" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Show 1 more" }));
      await userEvent.click(screen.getByRole("button", { name: "Open Last row" }));
      expect(onAction).toHaveBeenCalledWith(items[5]);
    });

    it("drops the toggle when the list shrinks to five", async () => {
      const items = manyItems(7);
      const { rerender } = renderZone(items);
      await userEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
      rerender(
        <MemoryRouter>
          <NeedsYou items={items.slice(0, 5)} onAction={vi.fn()} />
        </MemoryRouter>,
      );
      expect(screen.getAllByRole("listitem")).toHaveLength(5);
      expect(screen.queryByRole("button", { name: /show/i })).not.toBeInTheDocument();
    });

    it("disappears when the list empties", () => {
      const { rerender, container } = renderZone(manyItems(2));
      rerender(
        <MemoryRouter>
          <NeedsYou items={[]} onAction={vi.fn()} />
        </MemoryRouter>,
      );
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe("every state together", () => {
    it("renders problem, info, link, intent and bare rows with a folded long list", async () => {
      const items = [
        problem({
          id: "drive-failed:d1",
          detail: "Plug it in again or check the cable.",
          action: { label: "Open Files", href: "/files" },
        }),
        problem({
          id: "backup:drive:b1",
          rank: 40,
          title: [{ name: "Photos" }, " backup didn't finish"],
          detail: "The last copy did not finish.",
          action: { label: "Open", ariaLabel: "Open Photos backup", intent: "open-backup" },
        }),
        info({ action: { label: "Add drive", intent: "open-backup" } }),
        info({
          id: "no-drives",
          rank: 100,
          title: ["No drives yet"],
          detail: "Plug a USB drive into Luna to get started.",
        }),
        ...manyItems(4),
      ];
      renderZone(items);
      expect(screen.getAllByRole("listitem")).toHaveLength(5);
      await userEvent.click(screen.getByRole("button", { name: "Show 3 more" }));
      expect(screen.getAllByRole("listitem")).toHaveLength(8);
      await userEvent.click(screen.getByRole("button", { name: "Show fewer" }));
      expect(screen.getAllByRole("listitem")).toHaveLength(5);
    });
  });

  describe("hints and detail segments", () => {
    it("shows an info hint next to a row that has one", () => {
      renderZone([
        problem({
          id: "check:disk_space",
          title: ["Storage space"],
          hint: "Luna keeps its own software and settings on a small built-in disk, separate from your drives.",
        }),
      ]);
      expect(screen.getByRole("button", { name: "More about this" })).toBeInTheDocument();
    });

    it("puts names in a detail line in a pill", () => {
      renderZone([problem({ detail: [{ name: "Backup drive" }, " (the backup drive) is full."] })]);
      const pills = screen.getAllByText("Backup drive");
      expect(pills.some((el) => el.getAttribute("data-slot") === "inline-pill")).toBe(true);
    });
  });
});
