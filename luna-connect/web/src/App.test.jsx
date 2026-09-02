import { describe, expect, it } from "vitest";

describe("App", () => {
  it("exports BackupsTab from BackupsPage", async () => {
    const mod = await import("./pages/BackupsPage.jsx");
    expect(mod.BackupsTab).toBeTruthy();
  });
});
