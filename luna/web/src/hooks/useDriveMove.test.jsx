import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import useDriveMove from "./useDriveMove.js";

const ops = vi.hoisted(() => ({ startJobs: vi.fn(() => "op1") }));
vi.mock("../context/FileOpsContext.jsx", () => ({ useFileOps: () => ops }));

function renderMove(options = {}, drives = undefined) {
  const client = new QueryClient();
  if (drives) client.setQueryData(["drives"], drives);
  return renderHook(() => useDriveMove({ driveId: "d1", driveLabel: "Photos", ...options }), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}

describe("useDriveMove", () => {
  it("hands every path to the file task store as one move", () => {
    ops.startJobs.mockClear();
    const { result } = renderMove();
    result.current.mutate({ paths: ["a/one.txt", "two.txt"], destFolder: "Trips/2024" });
    expect(ops.startJobs).toHaveBeenCalledWith({
      kind: "move",
      fromDrive: "d1",
      items: [
        { path: "a/one.txt", name: "one.txt" },
        { path: "two.txt", name: "two.txt" },
      ],
      toDrive: "d1",
      toPath: "Trips/2024",
      toLabel: "2024",
    });
  });

  it("names the other drive when a drop lands at its top level", () => {
    ops.startJobs.mockClear();
    const { result } = renderMove({}, [{ id: "d2", label: "Spare Drive" }]);
    result.current.mutate({ paths: ["x.txt"], destDriveId: "d2", fromDriveId: "d3" });
    expect(ops.startJobs).toHaveBeenCalledWith(
      expect.objectContaining({ fromDrive: "d3", toDrive: "d2", toPath: "", toLabel: "Spare Drive" }),
    );
  });

  it("uses the drive's own label at its top level", () => {
    ops.startJobs.mockClear();
    const { result } = renderMove();
    result.current.mutate({ paths: ["x.txt"], destFolder: "" });
    expect(ops.startJobs).toHaveBeenCalledWith(expect.objectContaining({ toLabel: "Photos" }));
  });
});
