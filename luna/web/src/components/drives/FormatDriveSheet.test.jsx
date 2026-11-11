import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import FormatDriveSheet from "./FormatDriveSheet.jsx";

afterEach(() => vi.unstubAllGlobals());
it("shows the server's review before allowing the whole drive to be erased", async () => {
  const now = Math.floor(Date.now() / 1000);
  const plan = { id: "p1", label: "Photos", device: "sdb", size_bytes: 1000, filesystem: "exfat", encrypted: false, partitions: [{ device: "sdb1", label: "Old files", size_bytes: 1000, readable: true, files: 1, folders: 0, entries: [{ name: "photo.jpg", kind: "file" }] }], consequences: [], review_ready_at: null };
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = String(url);
    const data = path.includes("capabilities") ? { filesystems: [{ id: "exfat", label: "exFAT", description: "Works on many devices.", encryption_supported: false }] } : path.includes("operations") ? { operations: [] } : path.endsWith("/review") ? { ...plan, review_ready_at: now + 30 } : plan;
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider><FormatDriveSheet open drive={{ id: "d1", label: "Photos", device: "sdb" }} onClose={() => {}} /></ToastProvider></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText("Format"), { target: { value: "exfat" } });
  fireEvent.click(screen.getByRole("button", { name: "Review drive" }));
  expect(await screen.findByText("photo.jpg")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Format and erase" })).toBeDisabled();
});

it("recovers the saved operation when the start response is lost", async () => {
  const plan = { id: "p1", label: "Photos", device: "sdb", size_bytes: 1000, filesystem: "exfat", encrypted: false, partitions: [], consequences: [], review_ready_at: null };
  const op = { id: "o1", plan_id: "p1", state: "running", phase: "Preparing drive", encrypted: false };
  let started = false;
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = String(url);
    if (path.endsWith("/start")) { started = true; throw new TypeError("Failed to fetch"); }
    const data = path.includes("capabilities") ? { filesystems: [{ id: "exfat", label: "exFAT", description: "Works on many devices.", encryption_supported: false }] } : path.includes("operations") ? { operations: started ? [op] : [] } : path.endsWith("/review") ? { ...plan, review_ready_at: Math.floor(Date.now() / 1000) - 1 } : plan;
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider><FormatDriveSheet open drive={{ id: "d1", label: "Photos", device: "sdb" }} onClose={() => {}} /></ToastProvider></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText("Format"), { target: { value: "exfat" } });
  fireEvent.click(screen.getByRole("button", { name: "Review drive" }));
  const start = await screen.findByRole("button", { name: "Format and erase" });
  await screen.findByText(/Review complete/);
  fireEvent.click(start);
  expect(await screen.findByText("Preparing drive")).toBeInTheDocument();
});

it("reviews empty and unreadable partitions and makes a fresh plan when options change", async () => {
  const plans = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    const path = String(url);
    let data;
    if (path.includes("capabilities")) data = { filesystems: [{ id: "exfat", label: "exFAT", description: "Works on many devices.", encryption_supported: false }] };
    else if (path.includes("operations")) data = { operations: [] };
    else if (path.endsWith("/review")) {
      const id = path.split("/").at(-2);
      data = { ...plans.find((plan) => plan.id === id), review_ready_at: Math.floor(Date.now() / 1000) + 30 };
    } else {
      const body = JSON.parse(init.body);
      data = { id: `p${plans.length + 1}`, label: body.label, device: "sdb", size_bytes: 1000, filesystem: body.filesystem, encrypted: false, partitions: plans.length ? [{ device: "sdb1", size_bytes: 1000, readable: false, entries: [] }] : [], consequences: [], review_ready_at: null };
      plans.push(data);
    }
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider><FormatDriveSheet open drive={{ id: "d1", label: "Photos", device: "sdb" }} onClose={() => {}} /></ToastProvider></QueryClientProvider>);
  expect(await screen.findByRole("list", { name: "Format steps" })).toBeInTheDocument();
  fireEvent.change(await screen.findByLabelText("Format"), { target: { value: "exfat" } });
  fireEvent.click(screen.getByRole("button", { name: "Review drive" }));
  expect(await screen.findByText("No partitions found.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Format and erase" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Change options" }));
  fireEvent.change(screen.getByLabelText("Drive name"), { target: { value: "Archive" } });
  fireEvent.click(screen.getByRole("button", { name: "Review drive" }));
  expect(await screen.findByText("Luna could not read this partition.")).toBeInTheDocument();
  expect(plans).toHaveLength(2);
  expect(plans[1].label).toBe("Archive");
  expect(screen.getByRole("button", { name: "Format and erase" })).toBeDisabled();
});

it("explains when no format tools are available", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => new Response(JSON.stringify(String(url).includes("capabilities") ? { filesystems: [] } : { operations: [] }), { status: 200, headers: { "Content-Type": "application/json" } })));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider><FormatDriveSheet open drive={{ id: "d1", label: "Photos", device: "sdb" }} onClose={() => {}} /></ToastProvider></QueryClientProvider>);
  expect(await screen.findByText("No drive formats are available on this Luna.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review drive" })).toBeDisabled();
});

it("retries the same review after its request fails", async () => {
  const plan = { id: "p1", label: "Photos", device: "sdb", size_bytes: 1000, filesystem: "exfat", encrypted: false, partitions: [], consequences: [], review_ready_at: null };
  let reviews = 0;
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = String(url);
    if (path.endsWith("/review") && ++reviews === 1) return new Response(JSON.stringify({ error: "Could not start review." }), { status: 500, headers: { "Content-Type": "application/json" } });
    const data = path.includes("capabilities") ? { filesystems: [{ id: "exfat", label: "exFAT", description: "Works on many devices.", encryption_supported: false }] } : path.includes("operations") ? { operations: [] } : path.endsWith("/review") ? { ...plan, review_ready_at: Math.floor(Date.now() / 1000) + 30 } : plan;
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider><FormatDriveSheet open drive={{ id: "d1", label: "Photos", device: "sdb" }} onClose={() => {}} /></ToastProvider></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText("Format"), { target: { value: "exfat" } });
  fireEvent.click(screen.getByRole("button", { name: "Review drive" }));
  fireEvent.click(await screen.findByRole("button", { name: "Try review again" }));
  expect(await screen.findByText(/Review the drive for/)).toBeInTheDocument();
  expect(reviews).toBe(2);
});
