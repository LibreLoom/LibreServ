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

  it("shows the strength chips as the password is typed", () => {
    onCard(<Harness />);
    expect(screen.queryByText("12+ chars")).toBeNull();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "abc" } });
    expect(screen.getByText("12+ chars")).toBeInTheDocument();
    expect(screen.getByText("letters")).toBeInTheDocument();
    expect(screen.getByText("numbers")).toBeInTheDocument();
    expect(screen.getByText("symbols")).toBeInTheDocument();
  });

  it("shows the caller's message under the second field", () => {
    onCard(<Harness error="The two passwords don't match." />);
    expect(screen.getByText("The two passwords don't match.")).toBeInTheDocument();
  });
});
