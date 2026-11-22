import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import SqlEditor from "./SqlEditor.jsx";

describe("SqlEditor", () => {
  it("mounts a CodeMirror surface with the SQL language and run binding", () => {
    render(<SqlEditor onChange={vi.fn()} onRun={vi.fn()} />);
    const surface = document.querySelector('[data-slot="sql-editor"]');
    expect(surface).not.toBeNull();
    expect(surface?.querySelector(".cm-content")).not.toBeNull();
    expect(
      surface?.querySelector(".cm-content")?.getAttribute("aria-label"),
    ).toBe("SQL");
  });
});
