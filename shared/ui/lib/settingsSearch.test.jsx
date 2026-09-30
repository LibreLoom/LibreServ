import { describe, expect, it } from "vitest";
import { createElement } from "react";
import SettingsCard from "../components/settings/SettingsCard.jsx";
import SettingsRow from "../components/settings/SettingsRow.jsx";
import {
  buildSettingsIndex,
  extractSettingsItems,
  findSettingsTarget,
  normalize,
  searchSettings,
} from "./settingsSearch.js";

function Appearance() {
  return (
    <div>
      <SettingsCard title="Theme" padding={false}>
        <SettingsRow label="Color Scheme" description="Choose light, dark, or follow system preference">
          <span />
        </SettingsRow>
      </SettingsCard>
      <SettingsCard title="Haptics">
        <p>Feel a small buzz on touch screens.</p>
      </SettingsCard>
    </div>
  );
}

function Devices() {
  return (
    <SettingsCard title="Mobile App">
      <p>Back up your photos from your phone.</p>
    </SettingsCard>
  );
}

function Broken() {
  throw new Error("needs live data");
}

const categories = [
  { id: "appearance", label: "Appearance", Component: Appearance },
  { id: "devices", label: "Devices", Component: Devices },
  { id: "broken", label: "Broken", Component: Broken },
];

describe("settings search", () => {
  it("reads cards and rows from whatever the shared components draw", async () => {
    const errors = [];
    const index = await buildSettingsIndex(categories, (node) => node, {
      onError: (id) => errors.push(id),
    });
    expect(errors).toEqual(["broken"]);
    expect(index.map((h) => `${h.kind}:${h.title}`)).toEqual([
      "category:Appearance",
      "card:Theme",
      "row:Color Scheme",
      "card:Haptics",
      "category:Devices",
      "card:Mobile App",
      "category:Broken",
    ]);
    const row = index.find((h) => h.kind === "row");
    expect(row).toMatchObject({ cardTitle: "Theme", categoryId: "appearance" });
    expect(row?.text).toMatch(/follow system/);
  });

  it("finds hits by name first, then by the small print", async () => {
    const index = await buildSettingsIndex(categories, (node) => node);
    expect(searchSettings(index, "color")[0]).toMatchObject({ title: "Color Scheme" });
    expect(searchSettings(index, "buzz").map((h) => h.title)).toEqual(["Haptics"]);
    expect(searchSettings(index, "photos phone").map((h) => h.title)).toEqual(["Mobile App"]);
    expect(searchSettings(index, "dark theme").map((h) => h.title)).toEqual(["Color Scheme"]);
    expect(searchSettings(index, "nope")).toEqual([]);
    expect(searchSettings(index, "   ")).toEqual([]);
  });

  it("ignores case and accents", () => {
    expect(normalize("  Café  MODE ")).toBe("cafe mode");
  });

  it("finds the same card or row again in the live page", async () => {
    const index = await buildSettingsIndex(categories, (node) => node);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    await act(async () => {
      createRoot(host).render(createElement(Appearance));
    });
    const row = index.find((h) => h.kind === "row");
    const card = index.find((h) => h.title === "Haptics");
    expect(findSettingsTarget(host, row).textContent).toMatch(/Color Scheme/);
    expect(findSettingsTarget(host, card).textContent).toMatch(/buzz/);
    expect(findSettingsTarget(host, { ...card, title: "Missing" })).toBeNull();
    host.remove();
  });

  it("keeps words from neighbouring elements apart", () => {
    const doc = new DOMParser().parseFromString(
      '<div data-settings-item="card"><h2>Connect</h2><div><b>Off</b><span>Public address</span></div></div>',
      "text/html",
    );
    expect(extractSettingsItems(doc.body)[0].text).toBe("Off Public address");
  });

  it("leaves out cards without a title", () => {
    const doc = new DOMParser().parseFromString(
      '<div data-settings-item="card"><p>no heading</p></div>',
      "text/html",
    );
    expect(extractSettingsItems(doc.body)).toEqual([]);
  });
});
