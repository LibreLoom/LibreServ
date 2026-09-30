import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import PreflightStep from "./PreflightStep.jsx";

function stubPreflight(body, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
    ),
  );
}

// The card the step renders on in SetupPage, so the contrast check has a surface.
function renderStep(props = {}) {
  return render(
    <div className="surface-secondary">
      <PreflightStep onPass={() => {}} {...props} />
    </div>,
  );
}

const DIAGRAM_WARNING = "Diagrams (.drawio files) can't be opened or edited.";
const DIAGRAM_MORE = "The diagram pack is missing. Your files are still on your drives and can be downloaded.";

describe("PreflightStep", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leads with the verdict and folds passed checks away", async () => {
    stubPreflight({
      healthy: true,
      checks: {
        database: { status: "passed", category: "system", message: "ok" },
        disk_space: { status: "passed", category: "storage", message: "ok", details: { free_human: "12 GB" } },
      },
    });
    renderStep();
    expect(await screen.findByText("Everything checks out")).toBeInTheDocument();
    expect(screen.getByText("All 2 checks passed.")).toBeInTheDocument();
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
    const passed = screen.getByRole("button", { name: "2 checks passed" });
    expect(passed).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(passed);
    expect(passed).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("12 GB free")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Re-run checks/ })).not.toBeInTheDocument();
  });

  it("lets setup continue past warnings and says what won't work", async () => {
    stubPreflight({
      healthy: true,
      checks: {
        database: { status: "passed", category: "system", message: "ok" },
        diagram_pack: {
          status: "warning",
          category: "features",
          message: DIAGRAM_WARNING,
          more: DIAGRAM_MORE,
        },
      },
    });
    renderStep();
    expect(await screen.findByText("Ready to continue")).toBeInTheDocument();
    expect(screen.getByText(/1 thing won't work yet/)).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText(DIAGRAM_WARNING)).toBeInTheDocument();
    expect(screen.getByText("Diagrams")).toBeInTheDocument();
    const details = screen.getByRole("button", { name: "Details" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(DIAGRAM_MORE)).toBeInTheDocument();
    const areas = within(screen.getByRole("list", { name: "Areas checked" }));
    expect(areas.getByText("Features")).toBeInTheDocument();
    expect(areas.getByText("System")).toBeInTheDocument();
    expect(areas.queryByText("Network")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue/ })).toBeInTheDocument();
  });

  it("blocks setup on a failed check and shows its fix", async () => {
    const msg = "Luna can't save accounts, settings, or sign-ins.";
    stubPreflight(
      {
        healthy: false,
        checks: {
          data_path_writable: { status: "failed", category: "storage", message: msg },
        },
      },
      503,
    );
    renderStep();
    expect(await screen.findByText("Setup can't continue yet")).toBeInTheDocument();
    expect(screen.getByText(msg)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Re-run checks/ })).toBeInTheDocument();
  });

  it("says so when Luna can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    renderStep();
    expect(await screen.findByText("Could not run the system check")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Re-run checks/ })).toBeInTheDocument();
  });
});
