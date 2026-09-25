import { describe, expect, it } from "vitest";
import { collabPresenceLabel } from "./collabPresence.js";

const peers = [
  { peer_id: 1, username: "Ada" },
  { peer_id: 2, username: "Sam" },
];

describe("collabPresenceLabel", () => {
  it("names the other people in the room", () => {
    expect(collabPresenceLabel("ready", peers, true, "Ada", 1)).toBe("Live · Sam");
  });

  it("says when you are the only one here", () => {
    expect(
      collabPresenceLabel("ready", [{ peer_id: 1, username: "Ada" }], true, "Ada", 1),
    ).toBe("Live · only you");
  });

  it("uses the loading label until the editor is up", () => {
    expect(collabPresenceLabel("loading", [], true, "", null, "Opening this diagram…")).toBe(
      "Opening this diagram…",
    );
    expect(collabPresenceLabel("loading", [], true)).toBe("Starting EuroOffice…");
    expect(collabPresenceLabel("error", peers, true, "Ada", 1)).toBe("Live · Sam");
  });

  it("marks a session that cannot edit", () => {
    expect(collabPresenceLabel("ready", peers, false, "Ada", 1)).toBe(
      "Live · Sam · view only",
    );
  });

  it("falls back to the display name when the room has not assigned an id yet", () => {
    expect(collabPresenceLabel("ready", peers, true, "ada", null)).toBe("Live · Sam");
  });
});
