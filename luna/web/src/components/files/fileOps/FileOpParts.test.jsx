import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import FileOpParts from "./FileOpParts.jsx";

describe("FileOpParts", () => {
  it("draws text as text and names as pills", () => {
    render(<p><FileOpParts parts={["Uploading ", { pill: "photo.jpg" }]} /></p>);
    expect(screen.getByText("Uploading")).toBeTruthy();
    const pill = screen.getByText("photo.jpg");
    expect(pill.getAttribute("data-slot")).toBe("inline-pill");
  });
});
