import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "@libreloom/ui/context/ThemeContext.jsx";
import { ApiError } from "../../lib/api.js";
import { holdsPrivateOf } from "../../lib/holdsPrivate.js";
import HoldsPrivateNotice from "./HoldsPrivateNotice.jsx";

const refusal = (data, message = "refused") => new ApiError(403, message, "holds_private", data);

function show(err) {
  const hold = holdsPrivateOf(err);
  render(
    <ThemeProvider>
      <HoldsPrivateNotice hold={hold} />
    </ThemeProvider>,
  );
  return hold;
}

describe("holdsPrivateOf", () => {
  it("only recognises the holds_private refusal", () => {
    expect(holdsPrivateOf(new ApiError(403, "no", "other"))).toBeNull();
    expect(holdsPrivateOf(null)).toBeNull();
    expect(holdsPrivateOf(refusal({ owners: ["Max"] }))?.owners).toEqual(["Max"]);
  });
});

describe("HoldsPrivateNotice", () => {
  it("names the owners to an Admin, each in a pill", () => {
    show(refusal({ owners: ["Max", "Sam"] }));
    const pills = screen.getAllByText(/^(Max|Sam)$/);
    expect(pills).toHaveLength(2);
    for (const pill of pills) expect(pill).toHaveAttribute("data-slot", "inline-pill");
    expect(screen.getByText(/They have to move or delete them first\./)).toBeInTheDocument();
    expect(screen.getByText(/belonging to/)).toBeInTheDocument();
  });

  it("names the items to their own owner, each in a pill", () => {
    show(refusal({ items: ["Diary"] }));
    expect(screen.getByText("Diary")).toHaveAttribute("data-slot", "inline-pill");
    expect(screen.getByText(/Move or delete them first\./)).toBeInTheDocument();
  });

  it("names nothing for anyone else", () => {
    show(refusal(undefined, "This folder can't be deleted because it holds items you can't see. An Admin can help."));
    expect(
      screen.getByText("This folder can't be deleted because it holds items you can't see. An Admin can help."),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-slot="inline-pill"]')).toBeNull();
  });
});
