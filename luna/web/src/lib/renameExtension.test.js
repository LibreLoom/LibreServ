import { describe, expect, it } from "vitest";
import { extensionOf, renameExtensionWarning } from "./renameExtension.js";

describe("extensionOf", () => {
  it("lowercases and keeps the dot", () => {
    expect(extensionOf("Notes.TXT")).toBe(".txt");
    expect(extensionOf("a.tar.gz")).toBe(".gz");
  });
  it("treats dotfiles and trailing dots as extensionless", () => {
    expect(extensionOf(".env")).toBe("");
    expect(extensionOf("name.")).toBe("");
    expect(extensionOf("plain")).toBe("");
  });
});

describe("renameExtensionWarning", () => {
  it("is null when only the base name changes, ignoring case", () => {
    expect(renameExtensionWarning("a.txt", "b.txt")).toBeNull();
    expect(renameExtensionWarning("a.txt", "b.TXT")).toBeNull();
    expect(renameExtensionWarning("a", "b")).toBeNull();
  });
  it("is null for folders", () => {
    expect(renameExtensionWarning("v1.0", "v2", true)).toBeNull();
  });
  it("describes a changed extension", () => {
    expect(renameExtensionWarning("a.txt", "a.md")).toMatchObject({
      kind: "change",
      title: "Change .txt to .md?",
    });
  });
  it("describes a removed extension", () => {
    expect(renameExtensionWarning("a.txt", "a")).toMatchObject({
      kind: "remove",
      title: "Remove the .txt ending?",
    });
    expect(renameExtensionWarning("a.txt", ".txt")).toMatchObject({ kind: "remove" });
  });
  it("describes an added extension", () => {
    expect(renameExtensionWarning("a", "a.md")).toMatchObject({
      kind: "add",
      title: "Add a .md ending?",
    });
    expect(renameExtensionWarning(".env", "env.md")).toMatchObject({ kind: "add" });
  });
  it("uses the form message when a form loses .lunaform", () => {
    const w = renameExtensionWarning("Survey.lunaform", "Survey.txt");
    expect(w?.kind).toBe("form");
    expect(w?.message).toBe("Its answers will stay in Survey.lunaform.responses.");
    expect(renameExtensionWarning("Survey.LunaForm", "Survey")?.kind).toBe("form");
  });
  it("does not warn when a form keeps .lunaform", () => {
    expect(renameExtensionWarning("Survey.lunaform", "Poll.lunaform")).toBeNull();
  });
});
