import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { contrastRatio } from "../../../shared/ui/lib/colorContrast.js";

const PASSWORD = "recoveryPassword123";
const DEVICE_TOKEN = "ABCD-EFGH-JKLM-NPQR";

async function expectReadableText(locator) {
  const read = () =>
    locator.evaluate((element) => {
      const surface = element.closest(".surface-primary, .surface-secondary");
      const ownBackground = getComputedStyle(element).backgroundColor;
      const ownChannels = ownBackground.match(/[\d.]+/g) ?? [];
      const hasOpaqueBackground = ownChannels.length === 3 || Number(ownChannels[3]) >= 1;
      if (!hasOpaqueBackground && !surface) throw new Error("Text has no opaque background surface to compare against");
      return {
        foreground: getComputedStyle(element).color,
        background: ownBackground,
        backdrop: hasOpaqueBackground ? null : getComputedStyle(surface).backgroundColor,
      };
    });
  // `html` crossfades its theme variables over 1500ms (index.css), so a color
  // read while that runs is an interpolated grey and the ratio against it is
  // meaningless. Poll until the pair settles on its final values instead of
  // measuring one arbitrary frame of the crossfade.
  await expect
    .poll(async () => {
      const colors = await read();
      return contrastRatio(colors.foreground, colors.background, colors.backdrop ?? undefined);
    }, { timeout: 5000 })
    .toBeGreaterThanOrEqual(4.5);
}

async function fillPassword(page, password = PASSWORD) {
  await page.locator("#recovery-password").fill(password);
  await page.locator("#recovery-confirm").fill(password);
}

async function chooseAccount(page, label) {
  await page.getByLabel("Account to recover").click();
  await page.getByRole("option", { name: label }).click();
}

async function downloadFile(page, user, password, filename) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download recovery file" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(filename);
  const path = await download.path();
  expect(path).toBeTruthy();
  await expect.poll(async () => readFile(path)).toEqual(Buffer.from(JSON.stringify({ user, password }), "utf8"));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/recover");
  await expect(page.getByRole("heading", { name: "Create a password recovery file" })).toBeVisible();
});

test("downloads a token-bound file with exact filename and JSON bytes", async ({ page }) => {
  await chooseAccount(page, "One existing account");
  await page.getByLabel("Username").fill("Sam");
  await page.locator("#device-token").fill(DEVICE_TOKEN);
  await fillPassword(page, "éééééééééa1");

  await downloadFile(page, "u-sam", "éééééééééa1", "luna-recover-abcdefghjk1mnpqr.luna");
  const downloadStatus = page.locator('[role="status"]');
  await expect(downloadStatus).toBeVisible();
  await expect(downloadStatus.getByText("luna-recover-abcdefghjk1mnpqr.luna", { exact: true })).toBeVisible();
});

test("downloads the tokenless filename when no token is configured", async ({ page }) => {
  await page.getByLabel("This Luna has a device token").uncheck();
  await fillPassword(page);

  await downloadFile(page, "g-admin", PASSWORD, "luna-recover.luna");
});

test("keeps recovery instructions and section headings readable in light and dark themes", async ({ page }) => {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => localStorage.setItem("theme", value), theme);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Create a password recovery file" })).toBeVisible();
    await expect.poll(() => page.locator("html").evaluate((html) => html.classList.contains("dark"))).toBe(theme === "dark");

    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to main content" });
    await expect(skipLink).toBeFocused();
    await expectReadableText(skipLink);

    for (const locator of [
      page.getByText("Put this file on a USB drive to set a new password when Luna starts. Your password never leaves this device."),
      page.getByRole("heading", { name: "Who is it for?" }),
      page.getByText("This Luna has a device token", { exact: true }),
      page.getByRole("heading", { name: "Device token" }),
      page.getByRole("heading", { name: "Set a new password" }),
      page.getByText("The selected accounts will be signed out on their other devices."),
      page.getByText("A recovery file does not change the password while Luna is already running."),
    ]) {
      await expectReadableText(locator);
    }
  }
});

test("keeps recovery credentials in the local download", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => requests.push({
    method: request.method(),
    url: request.url(),
    body: request.postData(),
  }));

  await page.locator("#device-token").fill(DEVICE_TOKEN);
  await fillPassword(page);
  await downloadFile(page, "g-admin", PASSWORD, "luna-recover-abcdefghjk1mnpqr.luna");

  const localOrigin = new URL(page.url()).origin;
  expect(requests.every(({ url }) => new URL(url).origin === localOrigin)).toBe(true);
  expect(requests.filter(({ method }) => method !== "GET")).toEqual([]);
  expect(requests.every(({ url, body }) =>
    !url.includes(PASSWORD) && !url.includes(DEVICE_TOKEN) &&
    !body?.includes(PASSWORD) && !body?.includes(DEVICE_TOKEN)
  )).toBe(true);
});

test("encodes every daemon account selector in the downloaded file", async ({ page }) => {
  const selectors = [
    ["All Admin accounts", "g-admin", ""],
    ["All Member accounts", "g-member", ""],
    ["All accounts", "g-all", ""],
    ["One existing account", "u-sam", "Sam"],
    ["Create a new Admin account", "n-casey", "Casey"],
    ["Use an account or create it if missing", "f-jordan-1", "Jordan-1"],
  ];

  for (const [label, selector, username] of selectors) {
    await chooseAccount(page, label);
    if (username) await page.getByLabel("Username").fill(username);
    await page.locator("#device-token").fill(DEVICE_TOKEN);
    await fillPassword(page);
    await downloadFile(page, selector, PASSWORD, "luna-recover-abcdefghjk1mnpqr.luna");
    await page.reload();
  }
});

test("announces field errors and associates them with the invalid input", async ({ page }) => {
  await chooseAccount(page, "One existing account");
  await page.getByLabel("Username").fill("bad name");
  await page.locator("#device-token").fill(DEVICE_TOKEN);
  await fillPassword(page);
  await page.getByRole("button", { name: "Download recovery file" }).click();

  const username = page.getByLabel("Username");
  await expect(page.getByRole("alert")).toContainText("3-32 letters, numbers");
  await expect(username).toHaveAttribute("aria-invalid", "true");
  const errorId = await username.getAttribute("aria-describedby");
  expect(errorId).toBe("recovery-username-error");
  await expect(page.locator(`#${errorId}`)).toContainText("3-32 letters, numbers");
});

test("supports keyboard access to the skip link and account choices", async ({ page }) => {
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await page.keyboard.press("Tab");
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();

  const trigger = page.getByLabel("Account to recover");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveText(/All Member accounts/);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("shows a recovery-file error and allows a successful retry", async ({ page }) => {
  let downloads = 0;
  page.on("download", () => { downloads += 1; });

  await page.locator("#device-token").fill("bad");
  await fillPassword(page);
  await page.getByRole("button", { name: "Download recovery file" }).click();
  await expect(page.getByRole("alert")).toContainText("16 to 32 character device token");
  expect(downloads).toBe(0);

  await page.locator("#device-token").fill(DEVICE_TOKEN);
  await page.evaluate(() => {
    const createObjectURL = URL.createObjectURL.bind(URL);
    let shouldFail = true;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (blob) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("local download unavailable");
        }
        return createObjectURL(blob);
      },
    });
  });
  await page.getByRole("button", { name: "Download recovery file" }).click();
  await expect(page.getByRole("alert")).toContainText("The recovery file could not be created. Try again.");
  expect(downloads).toBe(0);

  await fillPassword(page, "ééééa1");
  await page.getByRole("button", { name: "Download recovery file" }).click();
  await expect(page.getByRole("alert")).toContainText("at least 12 characters");
  expect(downloads).toBe(0);

  await fillPassword(page, "recoveryPassword123");
  await downloadFile(page, "g-admin", PASSWORD, "luna-recover-abcdefghjk1mnpqr.luna");
  expect(downloads).toBe(1);
});
