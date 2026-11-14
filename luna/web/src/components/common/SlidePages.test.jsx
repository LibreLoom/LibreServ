import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SlidePages from "./SlidePages.jsx";

describe("SlidePages", () => {
  it("renders the current page inside a sliding cell", () => {
    render(
      <SlidePages pageKey="questions" position={0}>
        <p>Questions page</p>
      </SlidePages>,
    );
    const page = screen.getByText("Questions page").closest("[data-slide-page]");
    expect(page).toHaveAttribute("data-slide-page", "questions");
    // The first page is already in place: nothing to hold back.
    expect(page).not.toHaveAttribute("data-entering");
  });

  it("brings in the new page when the key changes", () => {
    const { rerender } = render(
      <SlidePages pageKey="questions" position={0}>
        <p>Questions page</p>
      </SlidePages>,
    );
    rerender(
      <SlidePages pageKey="responses" position={1}>
        <p>Responses page</p>
      </SlidePages>,
    );
    const page = screen.getByText("Responses page").closest("[data-slide-page]");
    expect(page).toHaveAttribute("data-slide-page", "responses");
  });
});
