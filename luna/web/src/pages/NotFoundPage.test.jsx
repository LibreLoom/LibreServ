import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NotFoundPage from "./NotFoundPage";

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NotFoundPage />
    </MemoryRouter>,
  );
}

describe("NotFoundPage", () => {
  it("shows the error code and the attempted path", () => {
    const { container } = renderAt("/definitely/not/a/page?x=1");
    expect(screen.getByText("Error 404")).toBeTruthy();
    // The path also rides the SVG trajectory decoratively — assert the real,
    // selectable copy inside the <code> block.
    const code = container.querySelector("code");
    expect(code?.textContent).toBe("/definitely/not/a/page?x=1");
  });

  it("suggests a close match for a mistyped route", () => {
    renderAt("/galery");
    expect(screen.getByText("Did you mean…")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Photos" }),
    ).toHaveAttribute("href", "/gallery");
  });

  it("offers a way home and a way back", () => {
    renderAt("/xyz");
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
  });
});
