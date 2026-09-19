import { beforeEach, describe, expect, it } from "vitest";
import {
  RECENT_ITEMS_LIMIT,
  formatRecentAgo,
  readRecentItems,
  recentItemFromLocation,
  recentItemHref,
  recentItemLocationLine,
  recentItemName,
  recordRecentItem,
} from "./recentItems.js";

const USER = "max";
const KEY = "luna.recentItems.max";

function seed(items, username = USER) {
  window.localStorage.setItem(
    `luna.recentItems.${username}`,
    JSON.stringify(items),
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("recentItemFromLocation", () => {
  it("ignores routes that are not a drive browser", () => {
    expect(recentItemFromLocation({ pathname: "/" })).toBeNull();
    expect(recentItemFromLocation({ pathname: "/drives" })).toBeNull();
    expect(recentItemFromLocation({ pathname: "/gallery" })).toBeNull();
    expect(recentItemFromLocation({ pathname: "/settings" })).toBeNull();
  });

  it("records a bare drive URL as a drive", () => {
    expect(recentItemFromLocation({ pathname: "/drives/d1" })).toEqual({
      kind: "drive",
      driveId: "d1",
      path: "",
    });
    expect(recentItemFromLocation({ pathname: "/drives/d1/" })).toEqual({
      kind: "drive",
      driveId: "d1",
      path: "",
    });
  });

  it("records a folder when path is set", () => {
    expect(
      recentItemFromLocation({ pathname: "/drives/d1", search: "?path=Documents" }),
    ).toEqual({ kind: "folder", driveId: "d1", path: "Documents" });
    expect(
      recentItemFromLocation({
        pathname: "/drives/d1",
        search: "?path=Documents/Office",
      }),
    ).toEqual({ kind: "folder", driveId: "d1", path: "Documents/Office" });
  });

  it("records an openable ?file= as a file inside its folder", () => {
    expect(
      recentItemFromLocation({
        pathname: "/drives/d1",
        search: "?path=Documents&file=note.md",
      }),
    ).toEqual({ kind: "file", driveId: "d1", path: "Documents/note.md" });
    expect(
      recentItemFromLocation({ pathname: "/drives/d1", search: "?file=pic.png" }),
    ).toEqual({ kind: "file", driveId: "d1", path: "pic.png" });
  });

  it("records ?open= and hash file candidates the same way FilesPage does", () => {
    expect(
      recentItemFromLocation({
        pathname: "/drives/d1",
        search: "?path=Docs&open=report.docx",
      }),
    ).toEqual({ kind: "file", driveId: "d1", path: "Docs/report.docx" });
    expect(
      recentItemFromLocation({ pathname: "/drives/d1", hash: "#song.mp3" }),
    ).toEqual({ kind: "file", driveId: "d1", path: "song.mp3" });
  });

  it("keeps a full path candidate as-is", () => {
    expect(
      recentItemFromLocation({
        pathname: "/drives/d1",
        search: "?file=Documents/note.md",
      }),
    ).toEqual({ kind: "file", driveId: "d1", path: "Documents/note.md" });
  });

  it("falls back to the folder when the file is not openable in Luna", () => {
    expect(
      recentItemFromLocation({
        pathname: "/drives/d1",
        search: "?path=Documents&file=backup.dat",
      }),
    ).toEqual({ kind: "folder", driveId: "d1", path: "Documents" });
    expect(
      recentItemFromLocation({ pathname: "/drives/d1", search: "?file=backup.dat" }),
    ).toEqual({ kind: "drive", driveId: "d1", path: "" });
  });

  it("ignores the skip-link hash and trash view", () => {
    expect(
      recentItemFromLocation({ pathname: "/drives/d1", hash: "#main-content" }),
    ).toEqual({ kind: "drive", driveId: "d1", path: "" });
    expect(
      recentItemFromLocation({ pathname: "/drives/d1", search: "?view=trash" }),
    ).toBeNull();
    expect(
      recentItemFromLocation({
        pathname: "/drives/d1",
        search: "?path=X&view=trash",
      }),
    ).toBeNull();
  });

  it("records the folder for a search-select link", () => {
    expect(
      recentItemFromLocation({
        pathname: "/drives/d1",
        search: "?path=Photos&select=Photos/beach.jpg",
      }),
    ).toEqual({ kind: "folder", driveId: "d1", path: "Photos" });
  });
});

describe("recordRecentItem / readRecentItems", () => {
  it("reads an empty list when nothing is stored", () => {
    expect(readRecentItems(USER)).toEqual([]);
    expect(readRecentItems("nobody")).toEqual([]);
  });

  it("puts the newest item first and stamps it", () => {
    recordRecentItem(USER, { kind: "drive", driveId: "d1", path: "" }, 1000);
    recordRecentItem(USER, { kind: "folder", driveId: "d1", path: "Docs" }, 2000);
    const items = readRecentItems(USER);
    expect(items.map((i) => i.kind)).toEqual(["folder", "drive"]);
    expect(items[0].at).toBe(2000);
  });

  it("dedupes the same object and keeps the freshest visit", () => {
    recordRecentItem(USER, { kind: "folder", driveId: "d1", path: "Docs" }, 1000);
    recordRecentItem(USER, { kind: "file", driveId: "d1", path: "a.md" }, 2000);
    recordRecentItem(USER, { kind: "folder", driveId: "d1", path: "Docs" }, 3000);
    const items = readRecentItems(USER);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "folder", path: "Docs", at: 3000 });
  });

  it("keeps a file and a folder at the same path as separate entries", () => {
    recordRecentItem(USER, { kind: "folder", driveId: "d1", path: "x" }, 1000);
    recordRecentItem(USER, { kind: "file", driveId: "d1", path: "x" }, 2000);
    expect(readRecentItems(USER)).toHaveLength(2);
  });

  it("caps the list at the limit", () => {
    for (let i = 0; i < RECENT_ITEMS_LIMIT + 4; i += 1) {
      recordRecentItem(
        USER,
        { kind: "file", driveId: "d1", path: `f${i}.md` },
        i,
      );
    }
    const items = readRecentItems(USER);
    expect(items).toHaveLength(RECENT_ITEMS_LIMIT);
    expect(items[0].path).toBe(`f${RECENT_ITEMS_LIMIT + 3}.md`);
    expect(items[items.length - 1].path).toBe("f4.md");
  });

  it("keeps separate lists per user", () => {
    recordRecentItem("max", { kind: "drive", driveId: "d1", path: "" }, 1);
    recordRecentItem("jamie", { kind: "folder", driveId: "d2", path: "y" }, 1);
    expect(readRecentItems("max")[0].driveId).toBe("d1");
    expect(readRecentItems("jamie")[0].driveId).toBe("d2");
  });

  it("returns [] for corrupt storage and drops malformed entries", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(readRecentItems(USER)).toEqual([]);

    seed([
      { kind: "file", driveId: "d1", path: "ok.md", at: 5 },
      { kind: "mystery", driveId: "d1", path: "x", at: 5 },
      { kind: "file", driveId: "d1", path: "no-time.md" },
      "garbage",
      null,
    ]);
    expect(readRecentItems(USER)).toEqual([
      { kind: "file", driveId: "d1", path: "ok.md", at: 5 },
    ]);
  });
});

describe("recentItemHref", () => {
  it("opens a file in the viewer inside its folder", () => {
    expect(
      recentItemHref({ kind: "file", driveId: "d1", path: "Documents/note.md" }),
    ).toBe("/drives/d1?path=Documents&file=note.md");
    expect(recentItemHref({ kind: "file", driveId: "d1", path: "root.md" })).toBe(
      "/drives/d1?file=root.md",
    );
  });

  it("opens folders and drives in the browser", () => {
    expect(
      recentItemHref({ kind: "folder", driveId: "d1", path: "Documents" }),
    ).toBe("/drives/d1?path=Documents");
    expect(recentItemHref({ kind: "drive", driveId: "d1", path: "" })).toBe(
      "/drives/d1",
    );
  });
});

describe("recentItemName / recentItemLocationLine", () => {
  it("names files and folders by basename", () => {
    expect(
      recentItemName({ kind: "file", driveId: "d1", path: "a/b/note.md" }),
    ).toBe("note.md");
    expect(
      recentItemName({ kind: "folder", driveId: "d1", path: "a/b" }),
    ).toBe("b");
  });

  it("names a drive by its label", () => {
    expect(
      recentItemName({ kind: "drive", driveId: "d1", path: "" }, "Family photos"),
    ).toBe("Family photos");
    expect(
      recentItemName({ kind: "drive", driveId: "d1", path: "", driveLabel: "Stick" }),
    ).toBe("Stick");
    expect(recentItemName({ kind: "drive", driveId: "d1", path: "" })).toBe(
      "Drive",
    );
  });

  it("shows the drive and containing folder for context", () => {
    expect(
      recentItemLocationLine(
        { kind: "file", driveId: "d1", path: "Documents/note.md" },
        "Family photos",
      ),
    ).toBe("Family photos · Documents");
    expect(
      recentItemLocationLine({ kind: "folder", driveId: "d1", path: "Office" }, "Docs"),
    ).toBe("Docs");
    expect(
      recentItemLocationLine({ kind: "drive", driveId: "d1", path: "" }),
    ).toBeNull();
  });
});

describe("formatRecentAgo", () => {
  const now = Date.parse("2026-09-12T12:00:00Z");

  it("buckets recent times", () => {
    expect(formatRecentAgo(now, now)).toBe("Just now");
    expect(formatRecentAgo(now - 30_000, now)).toBe("Just now");
    expect(formatRecentAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatRecentAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(formatRecentAgo(now - 2 * 86_400_000, now)).toBe("2 days ago");
    expect(formatRecentAgo(now - 86_400_000, now)).toBe("1 day ago");
  });

  it("falls back to a short date past a week", () => {
    const stamp = formatRecentAgo(now - 10 * 86_400_000, now);
    expect(stamp).toMatch(/Sep/);
    expect(stamp).toMatch(/2/);
  });
});
