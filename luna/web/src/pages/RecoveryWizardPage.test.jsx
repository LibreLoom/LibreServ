import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecoveryWizardPage from "./RecoveryWizardPage.jsx";

function renderPage() {
  return render(<MemoryRouter initialEntries={["/recover"]}><Routes><Route path="/recover" element={<RecoveryWizardPage />} /></Routes></MemoryRouter>);
}

function fillPasswords(password = "recoveryPassword123") {
  fireEvent.change(screen.getByLabelText("New password*", { exact: true }), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm new password*", { exact: true }), { target: { value: password } });
}

function chooseAccount(label) {
  fireEvent.click(screen.getByLabelText("Account to recover"));
  fireEvent.click(screen.getByRole("option", { name: label }));
}

describe("RecoveryWizardPage", () => {
  let clicked;
  let clickedAnchor;
  let createObjectURL;
  let fetchMock;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchMock = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "setTimeout").mockImplementation(() => /** @type {ReturnType<typeof window.setTimeout>} */ (/** @type {unknown} */ (0)));
    clickedAnchor = undefined;
    clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(/** @this {HTMLAnchorElement} */ function () {
      clickedAnchor = this;
    });
    createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recovery");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads luna-recover.luna JSON without a Verification code or Connect check", async () => {
    renderPage();
    expect(screen.getByText(/USB recovery works whether Luna Connect is on or off/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Verification code*", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("This Luna has a Verification code")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Device token" })).not.toBeInTheDocument();

    chooseAccount("One existing account");
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "Sam" } });
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));

    expect(clicked).toHaveBeenCalledOnce();
    expect(clickedAnchor.download).toBe("luna-recover.luna");
    expect(await createObjectURL.mock.calls[0][0].text()).toBe('{"user":"u-sam","password":"recoveryPassword123"}');
    expect(screen.getByRole("status")).toHaveTextContent("started to download the recovery file");
    expect(screen.getByRole("status")).toHaveTextContent("luna-recover.luna");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads recovery JSON for all admins", async () => {
    renderPage();
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));

    expect(clickedAnchor.download).toBe("luna-recover.luna");
    expect(clickedAnchor.href).toBe("blob:recovery");
    expect(await createObjectURL.mock.calls[0][0].text()).toBe('{"user":"g-admin","password":"recoveryPassword123"}');
  });

  it("measures password minimum using UTF-8 bytes like the Luna daemon", async () => {
    renderPage();
    fillPasswords(`${"é".repeat(9)}a1`);
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));

    expect(clicked).toHaveBeenCalledOnce();
    expect(await createObjectURL.mock.calls[0][0].text()).toBe(`{"user":"g-admin","password":"${"é".repeat(9)}a1"}`);
  });

  it("rejects passwords shorter than 12 UTF-8 bytes", () => {
    renderPage();
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
    chooseAccount(label);
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));

    expect(clicked).toHaveBeenCalledOnce();
    expect(await createObjectURL.mock.calls[0][0].text()).toBe(`{"user":"${selector}","password":"recoveryPassword123"}`);
  });

  it("encodes a new Admin selector and validates the username", async () => {
    renderPage();
    chooseAccount("Create a new Admin account");
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "Casey" } });
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));

    expect(clicked).toHaveBeenCalledOnce();
    expect(await createObjectURL.mock.calls[0][0].text()).toBe('{"user":"n-casey","password":"recoveryPassword123"}');
  });

  it("encodes the fallback selector for an existing or new Admin account", async () => {
    renderPage();
    chooseAccount("Use an account or create it if missing");
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "Jordan-1" } });
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));

    expect(clicked).toHaveBeenCalledOnce();
    expect(await createObjectURL.mock.calls[0][0].text()).toBe('{"user":"f-jordan-1","password":"recoveryPassword123"}');
  });

  it.each(["ab", "a".repeat(33), "bad name"])("rejects username %s", (username) => {
    renderPage();
    chooseAccount("Create a new Admin account");
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: username } });
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));

    expect(screen.getByRole("alert")).toHaveTextContent("3-32 letters, numbers");
    expect(clicked).not.toHaveBeenCalled();
  });

  it("rejects weak or mismatched passwords without downloading", () => {
    renderPage();
    fillPasswords("short1");
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(screen.getByRole("alert")).toHaveTextContent("at least 12 characters");

    fillPasswords("longpassword123");
    fireEvent.change(screen.getByLabelText("Confirm new password*", { exact: true }), { target: { value: "different123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(screen.getByRole("alert")).toHaveTextContent("passwords do not match");
    expect(clicked).not.toHaveBeenCalled();
  });

  it("shows a file creation error and allows a retry", async () => {
    renderPage();
    fillPasswords();
    createObjectURL.mockImplementationOnce(() => { throw new Error("local download unavailable"); });
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));

    expect(screen.getByRole("alert")).toHaveTextContent("The recovery file could not be created. Try again.");
    expect(clicked).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download recovery file" }));
    expect(clicked).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("started to download the recovery file");
  });
});
