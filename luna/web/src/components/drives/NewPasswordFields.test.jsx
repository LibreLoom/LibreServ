import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import NewPasswordFields from "./NewPasswordFields.jsx";

function Harness({ error = "" }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  return <NewPasswordFields idPrefix="t" password={password} again={again} onPassword={setPassword} onAgain={setAgain} error={error} />;
}

// Fields sit on a card (a modal), as in the encryption sheet.
const onCard = (ui) => render(<div className="surface-secondary text-primary p-4">{ui}</div>);

describe("NewPasswordFields", () => {
  it("asks for the password twice", () => {
    onCard(<Harness />);
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByLabelText("Password, once more")).toBeInTheDocument();
  });

  it("labels the chips as optional guidance, not a service rule", () => {
    onCard(<Harness />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "abc" } });
    expect(screen.getByText("Strength (optional)")).toBeInTheDocument();
    expect(screen.getByText("Any password works")).toBeInTheDocument();
    expect(screen.queryByText("Not strong enough yet")).toBeNull();
  });

  it("shows the strength chips as the password is typed, without making them rules", () => {
    onCard(<Harness />);
    expect(screen.queryByText("12+ chars")).toBeNull();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "abc" } });
    expect(screen.getByText("12+ chars")).toBeInTheDocument();
    expect(screen.getByText("letters")).toBeInTheDocument();
    expect(screen.getByText("numbers")).toBeInTheDocument();
    expect(screen.getByText("symbols")).toBeInTheDocument();
    // A short password still gets chips; the advisory copy says they are not required.
    expect(screen.getByText("Any password works")).toBeInTheDocument();
  });

  it("counts characters in the advisory chips, so a multi-byte password is judged by its characters", () => {
    onCard(<Harness />);
    // 12 characters, 21 UTF-8 bytes: the length chip is satisfied even though
    // the byte count is higher. This is a suggestion, not a lunad requirement.
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: `${"é".repeat(10)}a1` } });
    expect(screen.getByText("Strength (optional)")).toBeInTheDocument();
  });

  it("shows the caller's message under the second field", () => {
    onCard(<Harness error="The two passwords don't match." />);
    expect(screen.getByText("The two passwords don't match.")).toBeInTheDocument();
  });
});
