import { describe, expect, it } from "vitest";
import { buildLunaSetupLink } from "./lunaSetupLink.js";

describe("buildLunaSetupLink", () => {
  it("builds a hostname-only display and a tokenized /setup href", () => {
    const { display, href } = buildLunaSetupLink(
      "kitchen.luna.servers.libreloom.org",
      "ABCD-EFGH-IJKM-NPQR-STUV",
    );
    expect(display).toBe("kitchen.luna.servers.libreloom.org");
    expect(href).toBe(
      "https://kitchen.luna.servers.libreloom.org/setup?token=ABCD-EFGH-IJKM-NPQR-STUV",
    );
    expect(display).not.toMatch(/\?/);
    expect(display).not.toMatch(/\/setup/i);
  });

  it("omits the query when no device token is available", () => {
    const { display, href } = buildLunaSetupLink("kitchen.luna.servers.libreloom.org", "");
    expect(display).toBe("kitchen.luna.servers.libreloom.org");
    expect(href).toBe("https://kitchen.luna.servers.libreloom.org/setup");
  });

  it("accepts an absolute hostname URL", () => {
    const { display, href } = buildLunaSetupLink(
      "https://kitchen.luna.servers.libreloom.org/",
      "TOKEN",
    );
    expect(display).toBe("kitchen.luna.servers.libreloom.org");
    expect(href).toBe("https://kitchen.luna.servers.libreloom.org/setup?token=TOKEN");
  });

  it("strips a trailing /setup from the display when already present", () => {
    const { display, href } = buildLunaSetupLink(
      "kitchen.luna.servers.libreloom.org/setup",
      "TOKEN",
    );
    expect(display).toBe("kitchen.luna.servers.libreloom.org");
    expect(href).toBe("https://kitchen.luna.servers.libreloom.org/setup?token=TOKEN");
  });

  it("encodes special characters in the token", () => {
    const { href } = buildLunaSetupLink("host.example", "AB CD");
    expect(href).toBe("https://host.example/setup?token=AB%20CD");
  });
});
