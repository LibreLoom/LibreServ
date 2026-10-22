import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const PASSWORD = "recoveryPassword123";
const DEVICE_TOKEN = "ABCD-EFGH-JKLM-NPQR";

async function fillPassword(page, password = PASSWORD) {
  await page.locator("#recovery-password").fill(password);
  await page.locator("#recovery-confirm").fill(password);
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
  await page.getByLabel("One existing account").check();
  await page.getByLabel("Username").fill("Sam");
  await page.locator("#device-token").fill(DEVICE_TOKEN);
  await fillPassword(page, "éééééééééa1");

  await downloadFile(page, "u-sam", "éééééééééa1", "luna-recover-abcdefghjk1mnpqr.luna");
  await expect(page.getByRole("status")).toContainText("luna-recover-abcdefghjk1mnpqr.luna");
});

test("downloads the tokenless filename when no token is configured", async ({ page }) => {
  await page.getByLabel("This Luna has a device token").uncheck();
  await fillPassword(page);

  await downloadFile(page, "g-admin", PASSWORD, "luna-recover.luna");
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
    await page.getByLabel(label).check();
    if (username) await page.getByLabel("Username").fill(username);
    await page.locator("#device-token").fill(DEVICE_TOKEN);
    await fillPassword(page);
    await downloadFile(page, selector, PASSWORD, "luna-recover-abcdefghjk1mnpqr.luna");
    await page.reload();
  }
});

test("announces field errors and associates them with the invalid input", async ({ page }) => {
  await page.getByLabel("One existing account").check();
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

  const admins = page.getByRole("radio", { name: "All Admin accounts" });
  await admins.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: "All Member accounts" })).toBeFocused();
  await expect(page.getByRole("radio", { name: "All Member accounts" })).toBeChecked();
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
