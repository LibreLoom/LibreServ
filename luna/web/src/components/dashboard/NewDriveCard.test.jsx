import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import NewDriveCard from "./NewDriveCard.jsx";

function renderCard(drives) {
  return render(
    <MemoryRouter>
      <NewDriveCard drives={drives} />
    </MemoryRouter>,
  );
}

describe("NewDriveCard", () => {
  it("names one new drive and links to the unrecognized drives on the Files page", () => {
    renderCard([{ name: "sdb", model: "SanDisk", size_bytes: 32_000_000_000 }]);
    expect(screen.getByRole("heading", { name: "New drive detected" })).toBeInTheDocument();
    expect(screen.getByText("SanDisk")).toHaveAttribute("data-slot", "inline-pill");
    expect(screen.getByRole("link", { name: "Add drive" })).toHaveAttribute(
      "href",
      "/files#unrecognized-drives",
    );
  });

  it("counts several new drives", () => {
    renderCard([
      { name: "sdb", model: "SanDisk" },
      { name: "sdc", model: "Kingston" },
    ]);
    expect(screen.getByText(/2 drives aren't added yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add drives" })).toBeInTheDocument();
  });

  it("renders nothing when no drive is waiting", () => {
    const { container } = renderCard([]);
    expect(container).toBeEmptyDOMElement();
  });
});
