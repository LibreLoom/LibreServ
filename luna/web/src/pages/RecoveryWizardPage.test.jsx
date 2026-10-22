import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RecoveryWizardPage from "./RecoveryWizardPage.jsx";

function renderPage() {
  return render(<MemoryRouter initialEntries={["/recover"]}><Routes><Route path="/recover" element={<RecoveryWizardPage />} /></Routes></MemoryRouter>);
}

function fillPasswords(password = "recoveryPassword123") {
  fireEvent.change(screen.getByLabelText("New password*", { exact: true }), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm new password*", { exact: true }), { target: { value: password } });
}

function deviceTokenInput() {
  return screen.getByLabelText("Device token*", { exact: true });
}

describe("RecoveryWizardPage", () => {
  let clicked;
  let createObjectURL;
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(window, "setTimeout").mockImplementation(() => 0);
    clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
      clicked.anchor = this;
    });
    createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recovery");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("downloads token-bound JSON for the selected existing user", async () => {
    renderPage();
    fireEvent.click(screen.getByLabelText("One existing account"));
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "Sam" } });
    fireEvent.change(deviceTokenInput(), { target: { value: "ABCD-EFGH-JKLM-NPQR" } });
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(clicked).toHaveBeenCalledOnce();
    expect(clicked.anchor.download).toBe("luna-recover-abcdefghjk1mnpqr.luna");
    expect(await createObjectURL.mock.calls[0][0].text()).toBe('{"user":"u-sam","password":"recoveryPassword123"}');
    expect(screen.getByRole("status")).toHaveTextContent("recovery file downloaded");
  });

  it("downloads tokenless recovery JSON for all admins", async () => {
    renderPage();
    fireEvent.click(screen.getByLabelText("This Luna has a device token"));
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(clicked.anchor.download).toBe("luna-recover.luna");
    expect(clicked.anchor.href).toBe("blob:recovery");
    expect(await createObjectURL.mock.calls[0][0].text()).toBe('{"user":"g-admin","password":"recoveryPassword123"}');
  });

  it("measures password minimum using UTF-8 bytes like the Luna daemon", async () => {
    renderPage();
    fireEvent.click(screen.getByLabelText("This Luna has a device token"));
    fillPasswords(`${"é".repeat(9)}a1`);
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(clicked).toHaveBeenCalledOnce();
    expect(await createObjectURL.mock.calls[0][0].text()).toBe(`{"user":"g-admin","password":"${"é".repeat(9)}a1"}`);
  });

  it("rejects passwords shorter than 12 UTF-8 bytes", () => {
    renderPage();
    fireEvent.click(screen.getByLabelText("This Luna has a device token"));
    fillPasswords(`${"é".repeat(4)}a1`);
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(screen.getByRole("alert")).toHaveTextContent("at least 12 characters");
    expect(clicked).not.toHaveBeenCalled();
  });

  it.each([
    ["All Member accounts", "g-member"],
    ["All accounts", "g-all"],
  ])("supports the %s account selector", async (label, selector) => {
    renderPage();
    fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(screen.getByLabelText("This Luna has a device token"));
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(await createObjectURL.mock.calls[0][0].text()).toBe(`{"user":"${selector}","password":"recoveryPassword123"}`);
  });

  it("encodes a new Admin selector and validates the username", async () => {
    renderPage();
    fireEvent.click(screen.getByLabelText("Create a new Admin account"));
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "Casey" } });
    fireEvent.click(screen.getByLabelText("This Luna has a device token"));
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(await createObjectURL.mock.calls[0][0].text()).toBe('{"user":"n-casey","password":"recoveryPassword123"}');
  });

  it("encodes the fallback selector for an existing or new Admin account", async () => {
    renderPage();
    fireEvent.click(screen.getByLabelText("Use an account or create it if missing"));
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "Jordan-1" } });
    fireEvent.click(screen.getByLabelText("This Luna has a device token"));
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(await createObjectURL.mock.calls[0][0].text()).toBe('{"user":"f-jordan-1","password":"recoveryPassword123"}');
  });

  it.each(["ab", "a".repeat(33), "bad name"])("rejects username %s", (username) => {
    renderPage();
    fireEvent.click(screen.getByLabelText("Create a new Admin account"));
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: username } });
    fireEvent.click(screen.getByLabelText("This Luna has a device token"));
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(screen.getByRole("alert")).toHaveTextContent("3-32 letters, numbers");
    expect(clicked).not.toHaveBeenCalled();
  });

  it("rejects weak or mismatched passwords and invalid token without downloading", () => {
    renderPage();
    fireEvent.change(deviceTokenInput(), { target: { value: "bad" } });
    fillPasswords("short1");
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(screen.getByRole("alert")).toHaveTextContent("16 to 32 character device token");
    fireEvent.change(deviceTokenInput(), { target: { value: "ABCDEFGHIJKLMNOP" } });
    fireEvent.change(screen.getByLabelText("New password*", { exact: true }), { target: { value: "short1" } });
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(screen.getByRole("alert")).toHaveTextContent("at least 12 characters");
    fillPasswords("longpassword123");
    fireEvent.change(screen.getByLabelText("Confirm new password*", { exact: true }), { target: { value: "different123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(screen.getByRole("alert")).toHaveTextContent("passwords do not match");
    expect(clicked).not.toHaveBeenCalled();
  });

  it("shows a file creation error and allows a retry", () => {
    renderPage();
    fireEvent.change(deviceTokenInput(), { target: { value: "ABCDEFGHIJKLMNOP" } });
    fillPasswords();
    createObjectURL.mockImplementationOnce(() => { throw new Error("local download unavailable"); });
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The recovery file could not be created. Try again.");
    expect(clicked).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(clicked).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("recovery file downloaded");
  });
});
