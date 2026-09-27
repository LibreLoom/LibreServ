import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import useMovedLinkForwarding, { forwardedHref, missingLinkTargets } from "./useMovedLinkForwarding.js";
import { driveSource, fileListKey } from "../lib/fileSource.jsx";

const api = vi.hoisted(() => ({ getJson: vi.fn() }));
const toasts = vi.hoisted(() => ({ addToast: vi.fn() }));

vi.mock("../lib/api", async (orig) => ({ ...(await orig()), getJson: api.getJson }));
vi.mock("@libreloom/ui/context/ToastContext.jsx", () => ({ useToast: () => toasts }));

function notFound() {
  return Object.assign(new Error("Luna can't find that file or folder."), { status: 404, code: "not_found" });
}

describe("missingLinkTargets", () => {
  it("is empty while the folder and file are where the link says", () => {
    expect(missingLinkTargets({
      path: "docs", viewerPath: "docs/a.pdf", selectPath: "",
      listingMissing: false, entries: [{ name: "a.pdf" }],
    })).toEqual([]);
  });

  it("flags a file missing from an existing folder", () => {
    expect(missingLinkTargets({
      path: "docs", viewerPath: "docs/a.pdf", selectPath: "",
      listingMissing: false, entries: [{ name: "b.pdf" }],
    })).toEqual(["docs/a.pdf"]);
  });

  it("tries the file first, then its folder, when the folder is gone", () => {
    expect(missingLinkTargets({
      path: "docs", viewerPath: null, selectPath: "docs/a.pdf",
      listingMissing: true, entries: undefined,
    })).toEqual(["docs/a.pdf", "docs"]);
  });
});

describe("forwardedHref", () => {
  const nav = { viewerPath: "old/a.pdf", selectPath: "" };
  it("browses a forwarded folder", () => {
    expect(forwardedHref({ drive_id: "d", path: "new", kind: "dir" }, "old", nav)).toBe("/drives/d?path=new");
  });
  it("reopens a forwarded file in the viewer", () => {
    expect(forwardedHref({ drive_id: "d", path: "new/a.pdf", kind: "file" }, "old/a.pdf", nav))
      .toBe("/drives/d?path=new&file=a.pdf");
  });
  it("highlights a forwarded search hit", () => {
    expect(forwardedHref({ drive_id: "e", path: "new/a.pdf", kind: "file" }, "old/b.pdf", nav))
      .toBe("/drives/e?path=new&select=new%2Fa.pdf");
  });
});

// Stands in for FileBrowser, which owns the listing fetch.
function Listing({ path }) {
  useQuery({
    queryKey: fileListKey(driveSource, "d1", path),
    queryFn: () => driveSource.listDir("d1", path),
  });
  return null;
}

function Probe({ path, viewerPath = null, selectPath = "" }) {
  useMovedLinkForwarding({ driveId: "d1", path, viewerPath, selectPath, enabled: true });
  const loc = useLocation();
  return <output data-testid="url">{loc.pathname + loc.search}</output>;
}

function renderProbe(props, initial) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <Listing path={props.path} />
        <Probe {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("useMovedLinkForwarding", () => {
  beforeEach(() => {
    api.getJson.mockReset();
    toasts.addToast.mockReset();
  });

  it("follows a renamed folder and says so once", async () => {
    api.getJson.mockImplementation(async (url) => {
      if (url.startsWith("/api/v1/drives/d1/files?")) throw notFound();
      if (url.includes("/files/resolve?path=Taxes")) {
        return { drive_id: "d1", path: "Archive/Taxes", kind: "dir" };
      }
      throw new Error(`unexpected ${url}`);
    });
    const { getByTestId } = renderProbe({ path: "Taxes" }, "/drives/d1?path=Taxes");
    await waitFor(() => expect(getByTestId("url").textContent).toBe("/drives/d1?path=Archive%2FTaxes"));
    expect(toasts.addToast).toHaveBeenCalledTimes(1);
    expect(toasts.addToast.mock.calls[0][0]).toMatchObject({ type: "info", message: "This folder has moved." });
  });

  it("does nothing when the link still works", async () => {
    api.getJson.mockResolvedValue([{ name: "a.pdf" }]);
    renderProbe({ path: "docs", viewerPath: "docs/a.pdf" }, "/drives/d1?path=docs&file=a.pdf");
    await waitFor(() => expect(api.getJson).toHaveBeenCalledTimes(1));
    expect(api.getJson.mock.calls.some(([u]) => u.includes("/resolve"))).toBe(false);
    expect(toasts.addToast).not.toHaveBeenCalled();
  });

  it("stays put when Luna has no forwarding address", async () => {
    api.getJson.mockImplementation(async (url) => {
      if (url.includes("/resolve")) throw Object.assign(new Error("gone"), { status: 404 });
      throw notFound();
    });
    const { getByTestId } = renderProbe({ path: "gone" }, "/drives/d1?path=gone");
    await waitFor(() => expect(api.getJson.mock.calls.some(([u]) => u.includes("/resolve"))).toBe(true));
    expect(getByTestId("url").textContent).toBe("/drives/d1?path=gone");
    expect(toasts.addToast).not.toHaveBeenCalled();
  });
});
