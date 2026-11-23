import { describe, expect, it } from "vitest";
import {
  collabPresenceLabel,
  COLLAB_OFFLINE_PREFIX,
  isCollabOfflinePresence,
} from "./collabPresence.js";

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
  });

  it("says plainly when live editing isn't connected after a real hub loss", () => {
    expect(collabPresenceLabel("collab-offline", peers, true, "Ada", 1)).toBe(
      "Live editing isn't connected. Changes still save to this Luna.",
    );
    expect(collabPresenceLabel("collab-offline", peers, false, "Ada", 1)).toBe(
      "Live editing isn't connected · view only",
    );
  });

  it("stays silent when the editor failed to open, so the error card can speak", () => {
    // This status also covers bad file types, start timeouts and crashes —
    // none of them can promise that changes still save.
    expect(collabPresenceLabel("error", peers, true, "Ada", 1)).toBe("");
    expect(collabPresenceLabel("error", peers, false, "Ada", 1)).toBe("");
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

describe("isCollabOfflinePresence", () => {
  it("recognises only the honest offline notice", () => {
    const offline = collabPresenceLabel("collab-offline", peers, true, "Ada", 1);
    expect(isCollabOfflinePresence(offline)).toBe(true);
    expect(isCollabOfflinePresence(`${COLLAB_OFFLINE_PREFIX} · view only`)).toBe(true);
  });

  it("does not mistake a loading line, a live line or an empty line for it", () => {
    expect(isCollabOfflinePresence("")).toBe(false);
    expect(isCollabOfflinePresence(null)).toBe(false);
    expect(isCollabOfflinePresence("Live · Sam")).toBe(false);
    expect(isCollabOfflinePresence("Opening this whiteboard…")).toBe(false);
    expect(isCollabOfflinePresence(collabPresenceLabel("error", peers, true))).toBe(false);
  });
});
