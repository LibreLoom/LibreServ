import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import useFileNavigation from "./useFileNavigation.js";

function harness(entry, opts) {
  const wrapper = ({ children }) => (
    <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
  );
  return renderHook(
    () => ({ nav: useFileNavigation(opts), go: useNavigate(), loc: useLocation() }),
    { wrapper },
  );
}

describe("useFileNavigation", () => {
  it("reads path and file params into path + viewerPath", () => {
    const { result } = harness("/drives/d1?path=docs&file=report.pdf");
    expect(result.current.nav.path).toBe("docs");
    expect(result.current.nav.viewerPath).toBe("docs/report.pdf");
    expect(result.current.nav.inTrash).toBe(false);
  });

  it("reads trash view and select params", () => {
    const { result } = harness("/drives/d1?view=trash&select=a/b.txt");
    expect(result.current.nav.inTrash).toBe(true);
    // The legacy view=trash link folds into the .luna-trash folder path.
    expect(result.current.nav.path).toBe(".luna-trash");
    expect(result.current.nav.selectPath).toBe("a/b.txt");
  });

  it("treats the .luna-trash path as trash", () => {
    const { result } = harness("/drives/d1?path=.luna-trash/171-docs");
    expect(result.current.nav.inTrash).toBe(true);
    expect(result.current.nav.path).toBe(".luna-trash/171-docs");
  });

  it("opens previewable trash files but not session-backed kinds", () => {
    const text = harness("/drives/d1?path=.luna-trash&file=171-note.txt");
    expect(text.result.current.nav.viewerPath).toBe(".luna-trash/171-note.txt");
    const office = harness("/drives/d1?path=.luna-trash&file=171-doc.docx");
    expect(office.result.current.nav.viewerPath).toBeNull();
  });

  it("falls back to the location hash for the viewer", () => {
    const { result } = harness("/drives/d1?path=docs#photo.jpg");
    expect(result.current.nav.viewerPath).toBe("docs/photo.jpg");
  });

  it("does not open files that the viewer cannot render", () => {
    const { result } = harness("/drives/d1?file=weird.xyz123");
    expect(result.current.nav.viewerPath).toBeNull();
  });

  it("onPathChange drops file, view, and select params", () => {
    const { result } = harness("/drives/d1?path=docs&file=a.txt&view=trash&select=b.txt");
    act(() => result.current.nav.onPathChange("docs/sub"));
    expect(result.current.nav.path).toBe("docs/sub");
    expect(result.current.nav.viewerPath).toBeNull();
    expect(result.current.nav.inTrash).toBe(false);
    expect(result.current.nav.selectPath).toBeFalsy();
  });

  it("singleFile forces the wire path to empty and uses the default file", () => {
    const { result } = harness("/s/abc?path=../../etc&file=x", {
      defaultFile: "report.pdf",
      singleFile: true,
    });
    expect(result.current.nav.path).toBe("");
    expect(result.current.nav.viewerPath).toBe("report.pdf");
  });

  it("does not crash on a malformed location hash", () => {
    const { result } = harness("/drives/d1#%E0%A4%A");
    expect(result.current.nav.viewerPath).toBeNull();
    expect(result.current.nav.path).toBe("");
  });

  it("closing a hash-opened viewer clears the hash through the router", () => {
    const { result } = harness("/drives/d1?path=docs#photo.jpg");
    expect(result.current.nav.viewerPath).toBe("docs/photo.jpg");
    act(() => result.current.nav.onViewerPathChange(null));
    expect(result.current.nav.viewerPath).toBeNull();
    expect(result.current.loc.hash).toBe("");
  });

  it("singleFile close clears file params and a ?file= visit reopens", () => {
    const { result } = harness("/s/abc", {
      defaultFile: "report.pdf",
      singleFile: true,
    });
    expect(result.current.nav.viewerPath).toBe("report.pdf");

    act(() => result.current.nav.onViewerPathChange(null));
    expect(result.current.nav.viewerPath).toBeNull();

    // Re-selecting the file through the explorer reopens it.
    act(() => result.current.nav.onViewerPathChange("report.pdf"));
    expect(result.current.nav.viewerPath).toBe("report.pdf");

    act(() => result.current.nav.onViewerPathChange(null));
    expect(result.current.nav.viewerPath).toBeNull();

    // A deep link with ?file= reopens after a close.
    act(() => result.current.go("/s/abc?file=report.pdf"));
    expect(result.current.nav.viewerPath).toBe("report.pdf");
  });
});
