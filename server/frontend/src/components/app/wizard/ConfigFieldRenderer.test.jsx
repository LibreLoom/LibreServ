import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ConfigFieldRenderer from "./ConfigFieldRenderer";

const baseField = { name: "test", label: "Test Field", type: "string", required: false };

describe("ConfigFieldRenderer", () => {
  it("renders a text input with the field label for string type", () => {
    render(
      <ConfigFieldRenderer field={{ ...baseField }} value="" onChange={() => {}} disabled={false} />,
    );
    expect(screen.getByText("Test Field")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("marks required fields with an asterisk", () => {
    render(
      <ConfigFieldRenderer field={{ ...baseField, required: true }} value="" onChange={() => {}} disabled={false} />,
    );
    expect(screen.getByText("*")).toBeTruthy();
  });

  it("calls onChange when the string input value changes", () => {
    const onChange = vi.fn();
    render(<ConfigFieldRenderer field={{ ...baseField }} value="" onChange={onChange} disabled={false} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });
    expect(onChange).toHaveBeenCalledWith("hello");
  });

  it("disables the input when disabled is true", () => {
    render(<ConfigFieldRenderer field={{ ...baseField }} value="" onChange={() => {}} disabled={true} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("toggles password visibility", () => {
    render(
      <ConfigFieldRenderer field={{ ...baseField, type: "password" }} value="secret" onChange={() => {}} disabled={false} />,
    );
    const input = screen.getByDisplayValue("secret");
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: /show password/i }));
    expect(input.getAttribute("type")).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: /hide password/i }));
    expect(input.getAttribute("type")).toBe("password");
  });

  it("validates port range (1-65535) and shows a plain error", () => {
    render(
      <ConfigFieldRenderer field={{ ...baseField, type: "port" }} value="" onChange={() => {}} disabled={false} />,
    );
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "99999" } });
    expect(screen.getByText("Port must be between 1 and 65535")).toBeTruthy();
  });
});