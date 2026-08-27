import { describe, expect, it } from "vitest";
import { isImageFile, isTextFile, isVideoFile, openableKind } from "./fileKinds.js";

describe("fileKinds", () => {
  it("classifies images, video, and text", () => {
    expect(isImageFile("DCIM/a.JPG")).toBe(true);
    expect(isVideoFile("clip.mp4")).toBe(true);
    expect(isTextFile("notes.txt")).toBe(true);
    expect(isTextFile("README")).toBe(true);
    expect(openableKind("photo.png")).toBe("image");
    expect(openableKind("movie.webm")).toBe("video");
    expect(openableKind("todo.md")).toBe("text");
    expect(openableKind("archive.zip")).toBe(null);
  });
});
