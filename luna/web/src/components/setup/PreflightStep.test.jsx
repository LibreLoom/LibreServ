import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PreflightStep from "./PreflightStep.jsx";

function stubPreflight(body, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
    ),
  );
}

const DIAGRAM_WARNING = "Diagrams (.drawio files) can't be opened or edited.";
const DIAGRAM_MORE = "The diagram pack is missing. Your files are still on your drives and can be downloaded.";

describe("PreflightStep", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
    render(<PreflightStep onPass={() => {}} />);
    expect(await screen.findByText(DIAGRAM_WARNING)).toBeInTheDocument();
    expect(screen.getByText("Diagrams")).toBeInTheDocument();
    const details = screen.getByRole("button", { name: "Details" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(DIAGRAM_MORE)).toBeInTheDocument();
    expect(screen.getByText("Features")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue/ })).toBeInTheDocument();
    expect(screen.getByText(/One thing above won't work yet/)).toBeInTheDocument();
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
    render(<PreflightStep onPass={() => {}} />);
    expect(await screen.findByText(msg)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Re-run checks/ })).toBeInTheDocument();
  });
});
