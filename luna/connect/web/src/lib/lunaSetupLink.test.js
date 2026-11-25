import { describe, expect, it } from "vitest";
import { buildLunaSetupLink } from "./lunaSetupLink.js";

const HOST = "kitchen.luna.servers.libreloom.org";
const GRANT = "setup-grant_123";

describe("buildLunaSetupLink", () => {
  it("builds a hostname-only display and puts the grant in the fragment", () => {
    const { display, href } = buildLunaSetupLink(HOST, GRANT);
    expect(display).toBe(HOST);
    expect(href).toBe(`https://${HOST}/setup#setup_grant=${GRANT}`);
    expect(new URL(href).search).toBe("");
    expect(new URL(href).hash).toBe(`#setup_grant=${GRANT}`);
    expect(display).not.toMatch(/[?#]/);
    expect(display).not.toMatch(/\/setup/i);
  });

  it("omits the fragment when no setup grant is available", () => {
    expect(buildLunaSetupLink(HOST, "").href).toBe(`https://${HOST}/setup`);
  });

  it("accepts an absolute hostname URL and removes its old query and fragment", () => {
    const { display, href } = buildLunaSetupLink(`https://${HOST}/?old=1#old`, GRANT);
    expect(display).toBe(HOST);
    expect(href).toBe(`https://${HOST}/setup#setup_grant=${GRANT}`);
  });

  it("keeps an existing /setup path without doubling it", () => {
    const { display, href } = buildLunaSetupLink(`${HOST}/setup`, GRANT);
    expect(display).toBe(HOST);
    expect(href).toBe(`https://${HOST}/setup#setup_grant=${GRANT}`);
  });

  it("encodes special characters in the grant", () => {
    const { href } = buildLunaSetupLink("host.example", "AB CD/EF");
    expect(href).toBe("https://host.example/setup#setup_grant=AB%20CD%2FEF");
  });
});
