import { Suspense } from "react";
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
    const { result } = harness("/files/d1?path=docs&file=report.pdf");
    expect(result.current.nav.path).toBe("docs");
    expect(result.current.nav.viewerPath).toBe("docs/report.pdf");
    expect(result.current.nav.inTrash).toBe(false);
  });

  it("reads trash path and select params", () => {
    const { result } = harness("/files/d1?path=.luna-trash&select=a/b.txt");
    expect(result.current.nav.inTrash).toBe(true);
    expect(result.current.nav.path).toBe(".luna-trash");
    expect(result.current.nav.selectPath).toBe("a/b.txt");
  });

  it("treats the .luna-trash path as trash", () => {
    const { result } = harness("/files/d1?path=.luna-trash/171-docs");
    expect(result.current.nav.inTrash).toBe(true);
    expect(result.current.nav.path).toBe(".luna-trash/171-docs");
  });

  it("opens previewable trash files but not session-backed kinds", () => {
    const text = harness("/files/d1?path=.luna-trash&file=171-note.txt");
    expect(text.result.current.nav.viewerPath).toBe(".luna-trash/171-note.txt");
    const office = harness("/files/d1?path=.luna-trash&file=171-doc.docx");
    expect(office.result.current.nav.viewerPath).toBeNull();
  });

  it("falls back to the location hash for the viewer", () => {
    const { result } = harness("/files/d1?path=docs#photo.jpg");
    expect(result.current.nav.viewerPath).toBe("docs/photo.jpg");
  });

  it("opens any named file so the viewer can explain what it cannot render", () => {
    // A name Luna has no viewer for still opens: the viewer says so and offers a
    // download. Opening nothing made the click look like a dead end.
    const { result } = harness("/files/d1?file=weird.xyz123");
    expect(result.current.nav.viewerPath).toBe("weird.xyz123");
  });

  it("onPathChange drops file and select params", () => {
    const { result } = harness("/files/d1?path=docs&file=a.txt&select=b.txt");
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
    const { result } = harness("/files/d1#%E0%A4%A");
    expect(result.current.nav.viewerPath).toBeNull();
    expect(result.current.nav.path).toBe("");
  });

  it("keeps a file-root path in place when its own row opens", () => {
    const { result } = harness("/files/d1?path=docs%2Freport.pdf");
    expect(result.current.nav.path).toBe("docs/report.pdf");
    act(() => result.current.nav.onViewerPathChange("docs/report.pdf"));
    // The file IS the browsed path — `path` never climbs to the parent,
    // which isn't browsable for a member with only this file grant.
    expect(result.current.nav.path).toBe("docs/report.pdf");
    expect(result.current.nav.viewerPath).toBe("docs/report.pdf");
    expect(result.current.loc.search).toContain("file=docs%2Freport.pdf");
  });

  it("keeps the browsed path when the opened file lives outside it", () => {
    const { result } = harness("/files/d1?path=docs");
    act(() => result.current.nav.onViewerPathChange("other/y.txt"));
    expect(result.current.nav.path).toBe("docs");
    expect(result.current.nav.viewerPath).toBe("other/y.txt");
    expect(result.current.loc.search).toContain("file=other%2Fy.txt");
  });

  it("closing a hash-opened viewer clears the hash through the router", () => {
    const { result } = harness("/files/d1?path=docs#photo.jpg");
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

  it.each(["before", "after"])("reopens a file link %s the closing URL update commits", async (reopen) => {
    let blockClose = false;
    let releaseClose = () => {};
    const pendingClose = new Promise((resolve) => {
      releaseClose = () => resolve(undefined);
    });
    function DelayClosingNavigation() {
      const location = useLocation();
      if (blockClose && !location.search) throw pendingClose;
      return null;
    }
    const wrapper = ({ children }) => (
      <MemoryRouter initialEntries={["/s/abc?file=report.pdf"]}>
        <Suspense fallback={<span>Loading</span>}>
          <DelayClosingNavigation />
          {children}
        </Suspense>
      </MemoryRouter>
    );
    const { result } = renderHook(() => ({
      nav: useFileNavigation({ defaultFile: "report.pdf", singleFile: true }),
      go: useNavigate(),
      loc: useLocation(),
    }), { wrapper });

    blockClose = true;
    act(() => result.current.nav.onViewerPathChange(null));
    // The dialog must close even while React keeps the old URL on screen.
    expect(result.current.loc.search).toBe("?file=report.pdf");
    expect(result.current.nav.viewerPath).toBeNull();

    if (reopen === "before") {
      act(() => result.current.go("/s/abc?file=report.pdf"));
      expect(result.current.nav.viewerPath).toBe("report.pdf");
    }

    blockClose = false;
    await act(async () => releaseClose());
    if (reopen === "after") {
      expect(result.current.loc.search).toBe("");
      expect(result.current.nav.viewerPath).toBeNull();
      act(() => result.current.go("/s/abc?file=report.pdf"));
    }
    expect(result.current.loc.search).toBe("?file=report.pdf");
    expect(result.current.nav.viewerPath).toBe("report.pdf");
  });
});
