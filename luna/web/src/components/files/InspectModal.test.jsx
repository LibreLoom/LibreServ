import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import InspectModal from "./InspectModal.jsx";

afterEach(() => vi.unstubAllGlobals());

/** The window holds the unlock prompt, which needs a query client and toasts. */
function wrap(ui) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <ToastProvider><QueryClientProvider client={client}>{ui}</QueryClientProvider></ToastProvider>;
}

const drive = { name: "sdb", model: "USB drive" };

function show(result, onAdopt = () => {}) {
  render(wrap(<InspectModal open drive={drive} result={result} error={null} adoptError={null} adopting={false} onClose={() => {}} onAdopt={onAdopt} />));
}

it("asks an encrypted drive for its password, and never adds it as it is", () => {
  show({ encrypted: true, readable: false, writable: false, entries: [] });
  expect(screen.getByText(/protected with a password/)).toBeInTheDocument();
  expect(screen.getByLabelText("Drive password")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Unlock and add" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add this drive" })).toBeNull();
  expect(screen.queryByText(/in this version yet/)).toBeNull();
});

it("lets a forgotten password lead to erasing the drive and starting over", async () => {
  const onErase = vi.fn(async () => {});
  render(wrap(<InspectModal open drive={drive} result={{ encrypted: true, readable: false, writable: false, entries: [] }} error={null} adoptError={null} adopting={false} onClose={() => {}} onAdopt={() => {}} onErase={onErase} />));
  expect(screen.getByText(/no way to get it back/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Erase and start over" }));
  await waitFor(() => expect(onErase).toHaveBeenCalledWith(drive));
});

it("collects the password for Protect with a password, then hands both over", async () => {
  const onProtect = vi.fn(async () => {});
  render(wrap(<InspectModal open drive={drive} result={{ needs_setup: true, readable: true, writable: false, entries: [], folders: 0, files: 0 }} error={null} adoptError={null} adopting={false} onClose={() => {}} onAdopt={() => {}} onErase={() => {}} onProtect={onProtect} />));
  fireEvent.click(screen.getByRole("button", { name: "Protect with a password" }));
  expect(screen.getByText(/no way to get this password back/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "brand-new-pass-2" } });
  fireEvent.change(screen.getByLabelText("Password, once more"), { target: { value: "brand-new-pass-2" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(onProtect).toHaveBeenCalledWith(drive, "brand-new-pass-2"));
});

it("doesn't offer Protect when Luna can't protect this drive, and says why", () => {
  const reason = "This is a test drive made from a folder. A folder can't be protected with a password.";
  render(wrap(<InspectModal open drive={drive} result={{ needs_setup: true, readable: true, writable: false, entries: [], folders: 0, files: 0, can_protect: false, cant_protect_reason: reason }} error={null} adoptError={null} adopting={false} onClose={() => {}} onAdopt={() => {}} onErase={() => {}} onProtect={() => {}} />));
  expect(screen.queryByRole("button", { name: "Protect with a password" })).toBeNull();
  expect(screen.getByText(reason)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Erase and set up" })).toBeInTheDocument();
});

it("offers to erase a drive that needs setting up, and never adds it as it is", async () => {
  const onErase = vi.fn(async () => {});
  render(wrap(<InspectModal open drive={drive} result={{ needs_setup: true, readable: true, writable: false, entries: [], folders: 0, files: 0 }} error={null} adoptError={null} adopting={false} onClose={() => {}} onAdopt={() => {}} onErase={onErase} />));
  expect(screen.getByText(/It has to be erased first/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add this drive" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Protect with a password" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Erase and set up" }));
  await waitFor(() => expect(onErase).toHaveBeenCalledWith(drive));
});

it("treats a damaged drive the same way, not as a locked switch", () => {
  render(wrap(<InspectModal open drive={drive} result={{ readable: false, writable: false, entries: [] }} error={null} adoptError={null} adopting={false} onClose={() => {}} onAdopt={() => {}} onErase={() => {}} />));
  expect(screen.getByText(/It has to be erased first/)).toBeInTheDocument();
  expect(screen.queryByText(/lock switch/)).toBeNull();
});

it("adds a readable, writable drive under the name the person chose", async () => {
  const onAdopt = vi.fn(async () => {});
  show({ readable: true, writable: true, entries: [], folders: 0, files: 0 }, onAdopt);
  fireEvent.change(screen.getByLabelText("Drive name"), { target: { value: "Photos" } });
  fireEvent.click(screen.getByRole("button", { name: "Add this drive" }));
  await waitFor(() => expect(onAdopt).toHaveBeenCalledWith("Photos"));
});

it("explains a drive Luna can't save to", () => {
  show({ readable: true, writable: false, entries: [], folders: 0, files: 0 });
  expect(screen.getByText(/can't save files to this drive/)).toBeInTheDocument();
});
