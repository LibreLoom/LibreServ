import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import DriveStatusPill from "./DriveStatusPill.jsx";

describe("DriveStatusPill", () => {
  it("renders null if drive is missing", () => {
    const { container } = render(<DriveStatusPill drive={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders Ready for as_is drive", () => {
    render(<DriveStatusPill drive={{ state: "as_is" }} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("renders Read only for readonly drive", () => {
    render(<DriveStatusPill drive={{ state: "readonly" }} />);
    expect(screen.getByText("Read only")).toBeInTheDocument();
  });

  it("renders Unplugged for missing drive", () => {
    render(<DriveStatusPill drive={{ state: "missing" }} />);
    expect(screen.getByText("Unplugged")).toBeInTheDocument();
  });

  it("renders Ejected for ejected drive", () => {
    render(<DriveStatusPill drive={{ state: "ejected" }} />);
    expect(screen.getByText("Ejected")).toBeInTheDocument();
  });

  it("renders Problem for failed drive", () => {
    render(<DriveStatusPill drive={{ state: "failed" }} />);
    expect(screen.getByText("Problem")).toBeInTheDocument();
  });

  it("renders Member home marker when member_home is true", () => {
    render(<DriveStatusPill drive={{ state: "as_is", member_home: true }} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Private folders")).toBeInTheDocument();
  });

  it("renders Member home auto marker when member_home_auto is true", () => {
    render(<DriveStatusPill drive={{ state: "as_is", member_home: true, member_home_auto: true }} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Private folders")).toBeInTheDocument();
    expect(screen.getByText(/· auto/)).toBeInTheDocument();
  });
});
