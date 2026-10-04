import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import MapAreaFields from "./MapAreaFields.jsx";
import { nudgeBbox, parseAreaFields } from "../../lib/mapAreaFields.js";

const BOX = /** @type {[number, number, number, number]} */ ([4, 51, 5, 52]);

describe("parseAreaFields", () => {
  const ok = { north: "52", south: "51", west: "4", east: "5" };
  it("accepts a sensible box as west, south, east, north", () => {
    expect(parseAreaFields(ok)).toEqual({ bbox: [4, 51, 5, 52] });
  });
  it.each([
    [{ ...ok, north: "" }, /north edge/],
    [{ ...ok, north: "95" }, /between -90 and 90/],
    [{ ...ok, east: "200" }, /between -180 and 180/],
    [{ ...ok, south: "53" }, /south edge must be below/],
    [{ ...ok, west: "6" }, /west edge must be left/],
  ])("explains what is wrong with %j", (draft, message) => {
    expect(parseAreaFields(draft)).toEqual({ error: expect.stringMatching(message) });
  });
});

describe("nudgeBbox", () => {
  it("moves by a tenth of the box", () => {
    const [w, s, e, n] = /** @type {number[]} */ (nudgeBbox(BOX, "ArrowRight", false));
    expect([w, s, e, n].map((x) => Number(x.toFixed(3)))).toEqual([4.1, 51, 5.1, 52]);
  });
  it("resizes with shift: right and up grow, left and down shrink", () => {
    expect(nudgeBbox(BOX, "ArrowRight", true)).toEqual([4, 51, 5.1, 52]);
    expect(nudgeBbox(BOX, "ArrowLeft", true)).toEqual([4, 51, 4.9, 52]);
    expect(nudgeBbox(BOX, "ArrowUp", true)).toEqual([4, 51, 5, 52.1]);
    expect(nudgeBbox(BOX, "ArrowDown", true)).toEqual([4, 51, 5, 51.9]);
  });
  it("stays on the map and ignores other keys", () => {
    expect(nudgeBbox([179, 0, 180, 1], "ArrowRight", false)?.[2]).toBe(180);
    expect(nudgeBbox(BOX, "a", false)).toBeNull();
  });
});

describe("MapAreaFields", () => {
  it("applies typed edges", () => {
    const onChange = vi.fn();
    render(<MapAreaFields onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/North edge/), { target: { value: "52" } });
    fireEvent.change(screen.getByLabelText(/South edge/), { target: { value: "51" } });
    fireEvent.change(screen.getByLabelText(/West edge/), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText(/East edge/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Set area" }));
    expect(onChange).toHaveBeenCalledWith([4, 51, 5, 52]);
  });

  it("says what is wrong instead of applying a bad box", () => {
    const onChange = vi.fn();
    render(<MapAreaFields value={BOX} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/South edge/), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Set area" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/south edge must be below/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves and resizes the selected area with the arrow keys", () => {
    const onChange = vi.fn();
    render(<MapAreaFields value={BOX} onChange={onChange} />);
    const area = screen.getByRole("group", { name: /Selected area/ });
    fireEvent.keyDown(area, { key: "ArrowUp" });
    expect(onChange.mock.calls[0][0].map((n) => Number(n.toFixed(3)))).toEqual([4, 51.1, 5, 52.1]);
    fireEvent.keyDown(area, { key: "ArrowRight", shiftKey: true });
    expect(onChange.mock.calls[1][0]).toEqual([4, 51, 5.1, 52]);
  });
});
