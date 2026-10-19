import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import DriveHomeCard from "./DriveHomeCard.jsx";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const FULL_SUMMARY = {
  id: "d1",
  mounted: true,
  total_bytes: 64_000_000_000,
  free_bytes: 12_000_000_000,
  used_bytes: 52_000_000_000,
  folders: 3,
  files: 12,
  shortcuts: ["Photos", "Documents"],
};

/**
 * Stub the summary request. `"never"` hangs forever (loading), `"error"`
 * answers 500, anything else is the JSON body.
 * @param {any} summary
 */
function stubSummary(summary) {
  const fetchMock = vi.fn(async (url) => {
    if (!/\/api\/v1\/drives\/[^/]+\/summary$/.test(String(url))) {
      return jsonResponse({}, 404);
    }
    if (summary === "never") return new Promise(() => {});
    if (summary === "error") return jsonResponse({ error: "boom" }, 500);
    return jsonResponse(summary);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** @param {Record<string, any>} [props] */
function renderCard(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DriveHomeCard
          drive={{ id: "d1", label: "Family photos", state: "as_is" }}
          {...props}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return client;
}

/**
 * Wait until the summary answer has reached the screen. The Browse files link
 * is there while loading, so "nothing is shown" checks must wait for this
 * first or they pass without ever seeing the answer.
 * @param {QueryClient} client
 */
async function summaryShown(client) {
  await waitFor(() => {
    const state = client.getQueryState(["drive-summary", "d1"]);
    expect(state?.status === "success" || state?.status === "error").toBe(true);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const photosDropGrant = {
  id: "m1",
  kind: "path",
  drive_id: "d1",
  drive_label: "Family photos",
  path: "docs/drop",
  name: "drop",
  caps: "upload",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DriveHomeCard storage", () => {
  it("shows free and used space with a progress bar when the drive reported it", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard();
    expect(await screen.findByText("12 GB free")).toBeInTheDocument();
    expect(screen.getByText("52 GB used · 64 GB total")).toBeInTheDocument();
    expect(screen.getByText("Storage")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "81% used" });
    expect(bar).toHaveAttribute("aria-valuenow", "81");
  });

  it("leaves the used part out when the API does not return used space", async () => {
    stubSummary({ ...FULL_SUMMARY, used_bytes: null });
    renderCard();
    expect(await screen.findByText("12 GB free")).toBeInTheDocument();
    expect(screen.getByText("64 GB total")).toBeInTheDocument();
    expect(screen.queryByText(/used ·/)).not.toBeInTheDocument();
  });

  it("omits storage and any filler line when the drive is not mounted", async () => {
    stubSummary({ ...FULL_SUMMARY, mounted: false, shortcuts: [] });
    await summaryShown(renderCard());
    expect(screen.getByRole("link", { name: "Browse files" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText("Storage")).not.toBeInTheDocument();
    expect(screen.queryByText(/free/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Checking space/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open this drive to see your files/i)).not.toBeInTheDocument();
  });

  it.each([
    ["null", { total_bytes: null, free_bytes: 12_000_000_000, used_bytes: null }],
    ["zero", { total_bytes: 0, free_bytes: 0, used_bytes: 0 }],
  ])("omits storage when the total size is %s", async (_name, sizes) => {
    stubSummary({ ...FULL_SUMMARY, ...sizes });
    await summaryShown(renderCard());
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/free|total|used/)).not.toBeInTheDocument();
  });

  it("omits storage when free space is missing even if the total is known", async () => {
    stubSummary({ ...FULL_SUMMARY, free_bytes: null });
    await summaryShown(renderCard());
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/free/)).not.toBeInTheDocument();
  });

  it("caps the bar at 100% for a full drive", async () => {
    stubSummary({ ...FULL_SUMMARY, free_bytes: 0, used_bytes: 64_000_000_000 });
    renderCard();
    expect(await screen.findByText("0 B free")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "100% used" })).toBeInTheDocument();
  });

  it("shows no storage text while the summary is still loading", async () => {
    const fetchMock = stubSummary("never");
    renderCard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/free|used|total/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Checking space/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open this drive to see your files/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse files" })).toHaveAttribute("href", "/files/d1");
  });

  it("asks for the summary of this drive only", async () => {
    const fetchMock = stubSummary(FULL_SUMMARY);
    renderCard();
    await screen.findByText("12 GB free");
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(["/api/v1/drives/d1/summary"]);
  });
});

describe("DriveHomeCard shortcuts and counts", () => {
  it("shows folder shortcuts as links under a Folders label", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard();
    expect(await screen.findByText("Folders")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Photos" })).toHaveAttribute(
      "href",
      "/files/d1?path=Photos",
    );
    expect(screen.getByRole("link", { name: "Documents" })).toHaveAttribute(
      "href",
      "/files/d1?path=Documents",
    );
  });

  it("labels a nested shortcut by its last folder and keeps the full path in the link", async () => {
    stubSummary({ ...FULL_SUMMARY, shortcuts: ["Work/Taxes 2026"] });
    renderCard();
    expect(await screen.findByRole("link", { name: "Taxes 2026" })).toHaveAttribute(
      "href",
      "/files/d1?path=Work%2FTaxes%202026",
    );
  });

  it("shows no Folders label when there are no shortcuts", async () => {
    stubSummary({ ...FULL_SUMMARY, shortcuts: [] });
    renderCard();
    await screen.findByText("12 GB free");
    expect(screen.queryByText("Folders")).not.toBeInTheDocument();
  });

  it("shows no Folders label when the summary leaves shortcuts out", async () => {
    stubSummary({ ...FULL_SUMMARY, shortcuts: undefined });
    renderCard();
    await screen.findByText("12 GB free");
    expect(screen.queryByText("Folders")).not.toBeInTheDocument();
  });

  it("never shows the folder and file counts line", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard();
    await screen.findByText("12 GB free");
    expect(screen.queryByText(/folders/)).toBeNull();
    expect(screen.queryByText(/files at the/i)).toBeNull();
    expect(screen.queryByText(/root/i)).toBeNull();
  });
});

describe("DriveHomeCard open button", () => {
  it("lets an Admin browse the drive files", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard({ isAdmin: true });
    expect(await screen.findByRole("link", { name: "Browse files" })).toHaveAttribute(
      "href",
      "/files/d1",
    );
  });

  it("sends a Member without access to the drive root to their shared folder", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard({ grants: [photosDropGrant], showSeeAllShared: true });
    expect(await screen.findByRole("link", { name: "Browse files" })).toHaveAttribute(
      "href",
      "/files/d1?path=docs%2Fdrop",
    );
    expect(screen.getAllByRole("link").every((a) => a.getAttribute("href") !== "/files/d1")).toBe(true);
  });

  it("opens a shared file with Open when the shallowest grant is a file", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard({
      grants: [
        {
          ...photosDropGrant,
          id: "m2",
          path: "docs/report.pdf",
          name: "report.pdf",
          is_file: true,
          caps: "view",
        },
      ],
    });
    expect(await screen.findByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/files/d1?path=docs%2Freport.pdf",
    );
  });

  it("picks the shallowest of several grants for a Member", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard({
      grants: [
        { ...photosDropGrant, id: "m3", path: "a/b/c", name: "c" },
        { ...photosDropGrant, id: "m4", path: "a", name: "a" },
      ],
    });
    expect(await screen.findByRole("link", { name: "Browse files" })).toHaveAttribute(
      "href",
      "/files/d1?path=a",
    );
  });

  it("lets a Member with View on the whole drive browse the root", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard({
      grants: [{ ...photosDropGrant, id: "m5", path: "", name: "", caps: "view" }],
    });
    expect(await screen.findByRole("link", { name: "Browse files" })).toHaveAttribute(
      "href",
      "/files/d1",
    );
  });

  it("falls back to the drive root for a Member who has no grants", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard();
    expect(await screen.findByRole("link", { name: "Browse files" })).toHaveAttribute(
      "href",
      "/files/d1",
    );
  });

  it("falls back to a generic title when the drive has no label", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard({ drive: { id: "d1", state: "as_is" } });
    expect(await screen.findByRole("heading", { name: "Drive" })).toBeInTheDocument();
  });

  it("shows the drive name and its state pill", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard();
    expect(await screen.findByRole("heading", { name: "Family photos" })).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("treats a read-only drive as ready", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard({ drive: { id: "d1", label: "Family photos", state: "readonly" } });
    expect(await screen.findByText("12 GB free")).toBeInTheDocument();
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse files" })).toBeInTheDocument();
  });
});

describe("DriveHomeCard See all shared items", () => {
  it("shows the link for a Member when asked to", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard({ grants: [photosDropGrant], showSeeAllShared: true });
    expect(await screen.findByRole("link", { name: "See all shared items" })).toHaveAttribute(
      "href",
      "/shared",
    );
  });

  it("leaves the link out when the page does not ask for it", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard({ grants: [photosDropGrant], showSeeAllShared: false });
    await screen.findByText("12 GB free");
    expect(screen.queryByRole("link", { name: "See all shared items" })).not.toBeInTheDocument();
  });

  it("leaves the link out by default", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard();
    await screen.findByText("12 GB free");
    expect(screen.queryByRole("link", { name: "See all shared items" })).not.toBeInTheDocument();
  });

  it("never shows the link to an Admin", async () => {
    stubSummary(FULL_SUMMARY);
    renderCard({ isAdmin: true, showSeeAllShared: true });
    await screen.findByText("12 GB free");
    expect(screen.queryByRole("link", { name: "See all shared items" })).not.toBeInTheDocument();
  });

  it("shows the link on a card whose summary failed to load", async () => {
    stubSummary("error");
    renderCard({ grants: [photosDropGrant], showSeeAllShared: true });
    expect(await screen.findByRole("link", { name: "See all shared items" })).toHaveAttribute(
      "href",
      "/shared",
    );
  });

  it("does not show the link on a drive that is not ready", () => {
    stubSummary(FULL_SUMMARY);
    renderCard({
      drive: { id: "d1", label: "Family photos", state: "missing" },
      grants: [photosDropGrant],
      showSeeAllShared: true,
    });
    expect(screen.queryByRole("link", { name: "See all shared items" })).not.toBeInTheDocument();
  });
});

describe("DriveHomeCard drives that are not ready", () => {
  /** @param {string} state */
  function notReady(state) {
    return { id: "d1", label: "Family photos", state };
  }

  it("explains an unplugged drive and does not ask for its summary", () => {
    const fetchMock = stubSummary(FULL_SUMMARY);
    renderCard({ drive: notReady("missing"), isAdmin: true });
    expect(
      screen.getByText("Unplugged. Plug it back in when you want its files and space here."),
    ).toBeInTheDocument();
    expect(screen.getByText("Unplugged")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText("Folders")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains an ejected drive", () => {
    const fetchMock = stubSummary(FULL_SUMMARY);
    renderCard({ drive: notReady("ejected"), isAdmin: true });
    expect(
      screen.getByText("Safely removed. Plug it in again when you need it."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends an Admin to Files when a drive has a problem", () => {
    const fetchMock = stubSummary(FULL_SUMMARY);
    renderCard({ drive: notReady("failed"), isAdmin: true });
    expect(
      screen.getByText("Luna ran into a problem with this drive. Open Files for details."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Files" })).toHaveAttribute("href", "/files");
    expect(screen.queryByRole("link", { name: "Browse files" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tells a Member to ask an Admin when a drive has a problem, with no link", () => {
    stubSummary(FULL_SUMMARY);
    renderCard({
      drive: notReady("failed"),
      grants: [photosDropGrant],
      showSeeAllShared: true,
    });
    expect(
      screen.getByText("Luna ran into a problem with this drive. Ask an Admin to check it."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows no open button or shortcuts for an unplugged drive a Member has access to", () => {
    stubSummary(FULL_SUMMARY);
    renderCard({ drive: notReady("missing"), grants: [photosDropGrant] });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText("Folders")).not.toBeInTheDocument();
  });
});

describe("DriveHomeCard when the summary fails", () => {
  it("tells an Admin to open the drive and shows no storage or buttons", async () => {
    stubSummary("error");
    renderCard({ isAdmin: true });
    expect(await screen.findByText("Open this drive to see your files.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("gives a Member with a grant their open button", async () => {
    stubSummary("error");
    renderCard({ grants: [photosDropGrant] });
    expect(await screen.findByText("Open this drive to see your files.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse files" })).toHaveAttribute(
      "href",
      "/files/d1?path=docs%2Fdrop",
    );
  });

  it("gives a Member without a grant only the sentence", async () => {
    stubSummary("error");
    renderCard();
    expect(await screen.findByText("Open this drive to see your files.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
