import { describe, expect, it } from "vitest";
import { collabWsUrl } from "./collabSocket.js";

describe("collabSocket", () => {
  it("builds a same-origin collab websocket URL", () => {
    expect(collabWsUrl("luna.local", false, "drive-1", "Docs/a.docx")).toBe(
      "ws://luna.local/api/v1/collab/ws?drive_id=drive-1&path=Docs%2Fa.docx",
    );
    expect(collabWsUrl("luna.local", true, "drive-1", "a.docx")).toBe(
      "wss://luna.local/api/v1/collab/ws?drive_id=drive-1&path=a.docx",
    );
  });
});
