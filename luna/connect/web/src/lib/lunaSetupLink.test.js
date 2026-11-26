import { describe, expect, it } from "vitest";
import { buildLunaSetupLink } from "./lunaSetupLink.js";

const HOST = "kitchen.luna.servers.libreloom.org";
const TOKEN = "7K4M-2Q9X-R8N3-6T5W-1PZH";

describe("buildLunaSetupLink", () => {
  it("builds a hostname-only display and puts the token in the fragment", () => {
    const { display, href } = buildLunaSetupLink(HOST, TOKEN);
    expect(display).toBe(HOST);
    expect(href).toBe(`https://${HOST}/setup#token=${TOKEN}`);
    expect(new URL(href).search).toBe("");
    expect(new URL(href).hash).toBe(`#token=${TOKEN}`);
    expect(display).not.toMatch(/[?#]/);
    expect(display).not.toMatch(/\/setup/i);
  });

  it("omits the fragment when no device token is available", () => {
    expect(buildLunaSetupLink(HOST, "").href).toBe(`https://${HOST}/setup`);
  });

  it("accepts an absolute hostname URL and removes its old query and fragment", () => {
    const { display, href } = buildLunaSetupLink(`https://${HOST}/?old=1#old`, TOKEN);
    expect(display).toBe(HOST);
    expect(href).toBe(`https://${HOST}/setup#token=${TOKEN}`);
  });

  it("keeps an existing /setup path without doubling it", () => {
    const { display, href } = buildLunaSetupLink(`${HOST}/setup`, TOKEN);
    expect(display).toBe(HOST);
    expect(href).toBe(`https://${HOST}/setup#token=${TOKEN}`);
  });

  it("encodes special characters in the token", () => {
    const { href } = buildLunaSetupLink("host.example", "AB CD/EF");
    expect(href).toBe("https://host.example/setup#token=AB%20CD%2FEF");
  });
});
