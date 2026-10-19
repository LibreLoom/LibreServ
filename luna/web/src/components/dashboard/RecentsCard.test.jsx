import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import RecentsCard from "./RecentsCard.jsx";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const DRIVES = [{ id: "d1", label: "Family photos" }];

/** The three kinds, newest first, the way the dashboard hands them over. */
function threeKinds() {
  const now = Date.now();
  return [
    { kind: "file", driveId: "d1", driveLabel: "Old label", path: "Documents/note.md", at: now - 5 * MIN },
    { kind: "folder", driveId: "d1", path: "Office", at: now - 3 * HOUR },
    { kind: "drive", driveId: "d1", path: "", at: now - 2 * DAY },
  ];
}

/** `count` distinct files, newest first. */
function files(count) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    kind: "file",
    driveId: "d1",
    path: `Docs/file-${i + 1}.txt`,
    at: now - (i + 1) * MIN,
  }));
}

function renderCard(props = {}) {
  return render(
    <MemoryRouter>
      <RecentsCard items={[]} drives={DRIVES} {...props} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RecentsCard", () => {
  describe("empty", () => {
    it("renders nothing for an empty list", () => {
      const { container } = renderCard({ items: [] });
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByText("Recents")).not.toBeInTheDocument();
    });

    it("renders nothing when items are missing", () => {
      const { container } = renderCard({ items: undefined });
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByText("Recents")).not.toBeInTheDocument();
    });

    it("renders nothing when items are null", () => {
      const { container } = renderCard({ items: null });
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe("rows", () => {
    it("shows the Recents heading and one link per item", () => {
      renderCard({ items: threeKinds() });
      expect(screen.getByRole("heading", { name: "Recents" })).toBeInTheDocument();
      expect(screen.getAllByRole("link")).toHaveLength(3);
      expect(screen.getAllByRole("listitem")).toHaveLength(3);
    });

    it("links each row to its file, folder or drive", () => {
      renderCard({ items: threeKinds() });
      const [file, folder, drive] = screen.getAllByRole("link");
      expect(file).toHaveAttribute("href", "/drives/d1?path=Documents&file=note.md");
      expect(folder).toHaveAttribute("href", "/drives/d1?path=Office");
      expect(drive).toHaveAttribute("href", "/drives/d1");
    });

    it("has no separate Open button or link", () => {
      renderCard({ items: threeKinds() });
      expect(screen.queryByRole("link", { name: /^Open$/ })).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByText(/^Open$/)).toBeNull();
    });

    it("has no kind eyebrow", () => {
      renderCard({ items: threeKinds() });
      expect(screen.queryByText("File")).toBeNull();
      expect(screen.queryByText("Folder")).toBeNull();
      expect(screen.queryByText("Drive")).toBeNull();
    });

    it("shows the file name, folder name and live drive name", () => {
      renderCard({ items: threeKinds() });
      expect(screen.getByText("note.md")).toBeInTheDocument();
      expect(screen.getByText("Office")).toBeInTheDocument();
      const [, , driveLink] = screen.getAllByRole("link");
      // The whole-drive row is named after the drive itself.
      expect(within(driveLink).getByText("Family photos")).toBeInTheDocument();
    });

    it("keeps duplicate paths on different drives as separate rows without key warnings", () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const now = Date.now();
      renderCard({
        items: [
          { kind: "folder", driveId: "d1", path: "Office", at: now - MIN },
          { kind: "folder", driveId: "d2", path: "Office", at: now - 2 * MIN },
        ],
        drives: [...DRIVES, { id: "d2", label: "Backup drive" }],
      });
      expect(screen.getAllByRole("link")).toHaveLength(2);
      expect(screen.getByText("Family photos")).toBeInTheDocument();
      expect(screen.getByText("Backup drive")).toBeInTheDocument();
      expect(errors).not.toHaveBeenCalled();
    });
  });

  describe("cap of 6", () => {
    it("shows only the first six of eight, in the given order", () => {
      renderCard({ items: files(8) });
      const links = screen.getAllByRole("link");
      expect(links).toHaveLength(6);
      links.forEach((link, i) => {
        expect(within(link).getByText(`file-${i + 1}.txt`)).toBeInTheDocument();
      });
      expect(screen.queryByText("file-7.txt")).toBeNull();
      expect(screen.queryByText("file-8.txt")).toBeNull();
    });

    it("shows all six when there are exactly six", () => {
      renderCard({ items: files(6) });
      expect(screen.getAllByRole("link")).toHaveLength(6);
    });

    it("cuts at six when there are seven", () => {
      renderCard({ items: files(7) });
      expect(screen.getAllByRole("link")).toHaveLength(6);
      expect(screen.queryByText("file-7.txt")).toBeNull();
    });

    it("shows a single item", () => {
      renderCard({ items: files(1) });
      expect(screen.getAllByRole("link")).toHaveLength(1);
    });

    it("does not change the list it was given", () => {
      const list = files(8);
      renderCard({ items: list });
      expect(list).toHaveLength(8);
    });
  });

  describe("drive names and location", () => {
    it("prefers the live drive name over the one saved with the item", () => {
      renderCard({ items: threeKinds() });
      expect(screen.getByText("Family photos · Documents")).toBeInTheDocument();
      expect(screen.queryByText(/Old label/)).toBeNull();
    });

    it("falls back to the saved drive name when the drive is not in the list", () => {
      renderCard({ items: threeKinds(), drives: [] });
      expect(screen.getByText("Old label · Documents")).toBeInTheDocument();
    });

    it("falls back to the plain word Drive when no name is known", () => {
      renderCard({
        items: [{ kind: "folder", driveId: "d9", path: "Office", at: Date.now() - MIN }],
        drives: [],
      });
      expect(screen.getByText("Drive")).toBeInTheDocument();
    });

    it("shows only the drive name for an item at the top of a drive", () => {
      renderCard({
        items: [{ kind: "folder", driveId: "d1", path: "Office", at: Date.now() - MIN }],
      });
      expect(screen.getByText("Family photos")).toBeInTheDocument();
    });

    it("shows drive and parent folder for nested items", () => {
      renderCard({
        items: [{ kind: "file", driveId: "d1", path: "Work/2026/report.pdf", at: Date.now() - MIN }],
      });
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
      expect(screen.getByText("Family photos · Work/2026")).toBeInTheDocument();
    });

    it("leaves the location line out for a whole-drive item", () => {
      renderCard({
        items: [{ kind: "drive", driveId: "d1", path: "", at: Date.now() - MIN }],
      });
      const link = screen.getByRole("link");
      expect(link.querySelector("p")).toBeNull();
    });
  });

  describe("time", () => {
    it("shows relative times in <time> elements", () => {
      renderCard({ items: threeKinds() });
      expect(screen.getByText("5 min ago").tagName).toBe("TIME");
      expect(screen.getByText("3 h ago").tagName).toBe("TIME");
      expect(screen.getByText("2 days ago").tagName).toBe("TIME");
    });

    it("sets the exact moment on each <time> element", () => {
      const items = threeKinds();
      renderCard({ items });
      expect(screen.getByText("5 min ago")).toHaveAttribute(
        "datetime",
        new Date(items[0].at).toISOString(),
      );
      expect(screen.getByText("2 days ago")).toHaveAttribute(
        "datetime",
        new Date(items[2].at).toISOString(),
      );
    });

    it("says Just now for something opened a moment ago", () => {
      renderCard({
        items: [{ kind: "drive", driveId: "d1", path: "", at: Date.now() - 10_000 }],
      });
      expect(screen.getByText("Just now").tagName).toBe("TIME");
    });

    it("uses the singular for one day", () => {
      renderCard({
        items: [{ kind: "drive", driveId: "d1", path: "", at: Date.now() - DAY - MIN }],
      });
      expect(screen.getByText("1 day ago")).toBeInTheDocument();
    });

    it("switches to a calendar date after a week", () => {
      renderCard({
        items: [{ kind: "drive", driveId: "d1", path: "", at: Date.now() - 8 * DAY }],
      });
      expect(screen.queryByText(/ago$/)).toBeNull();
      expect(screen.getByRole("link").querySelector("time")).toHaveTextContent(/\w/);
    });
  });

  describe("link name", () => {
    it("includes the name, location and time", () => {
      renderCard({ items: threeKinds() });
      const [file, folder, drive] = screen.getAllByRole("link");
      expect(file).toHaveAccessibleName(/note\.md.*Family photos · Documents.*5 min ago/);
      expect(folder).toHaveAccessibleName(/Office.*Family photos.*3 h ago/);
      expect(drive).toHaveAccessibleName(/Family photos.*2 days ago/);
    });

    it("finds a row by its name alone", () => {
      renderCard({ items: threeKinds() });
      expect(screen.getByRole("link", { name: /Office/ })).toHaveAttribute(
        "href",
        "/drives/d1?path=Office",
      );
    });
  });

  describe("look", () => {
    it("shows a ring on hover and keyboard focus and no border", () => {
      renderCard({ items: threeKinds() });
      for (const link of screen.getAllByRole("link")) {
        const classes = Array.from(link.classList);
        expect(classes).toContain("hover:ring-2");
        expect(classes).toContain("hover:ring-accent");
        expect(classes).toContain("focus-visible:ring-2");
        expect(classes).toContain("focus-visible:ring-accent");
        expect(classes).toContain("no-focus-outline");
        expect(classes.some((c) => c === "border" || c.startsWith("border-"))).toBe(false);
      }
    });

    it("keeps each row on the page surface and sets no text color of its own", () => {
      renderCard({ items: threeKinds() });
      for (const link of screen.getAllByRole("link")) {
        expect(link).toHaveClass("surface-primary", "rounded-large-element");
        expect(link.querySelectorAll("[class*='text-primary'], [class*='text-secondary']")).toHaveLength(0);
        expect(link.className).not.toMatch(/text-(primary|secondary)/);
      }
    });

    it("renders the name in mono without bold", () => {
      renderCard({ items: threeKinds() });
      const name = screen.getByText("note.md");
      expect(name).toHaveClass("font-mono", "font-normal");
      expect(name.className).not.toMatch(/font-(medium|semibold|bold)/);
    });

    it("carries the location as a pill and a kind icon", () => {
      renderCard({ items: threeKinds() });
      const links = screen.getAllByRole("link");
      // File and folder rows wear the drive + folder pill.
      const pillTexts = links.map((link) => {
        const pill = link.querySelector("[data-slot='inline-pill']");
        return pill ? pill.textContent : null;
      });
      expect(pillTexts[0]).toBe("Family photos · Documents");
      expect(pillTexts[1]).toBe("Family photos");
      expect(pillTexts[2]).toBeNull();
      // Each row carries its kind's glyph, already hidden from reading order.
      for (const link of links) {
        const glyph = link.querySelector("svg");
        expect(glyph).not.toBeNull();
        expect(glyph).toHaveAttribute("aria-hidden", "true");
      }
    });
  });

  describe("all states together", () => {
    it("renders file, folder, drive, nested and the cap in one card", () => {
      const now = Date.now();
      renderCard({
        items: [
          ...threeKinds(),
          { kind: "file", driveId: "d1", path: "Work/2026/report.pdf", at: now - 4 * DAY },
          ...files(5),
        ],
      });
      expect(screen.getAllByRole("link")).toHaveLength(6);
      expect(screen.getByText("Family photos · Work/2026")).toBeInTheDocument();
    });
  });
});
