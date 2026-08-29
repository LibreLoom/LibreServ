import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DevicesCategory, {
  DESKTOP_APP_DOWNLOAD_URL,
  MOBILE_APP_DOWNLOAD_URL,
} from "./DevicesCategory.jsx";

function renderDevices() {
  return render(
    <MemoryRouter>
      <DevicesCategory />
    </MemoryRouter>,
  );
}

describe("DevicesCategory", () => {
  it("shows Mobile App and Desktop App cards with download and security links", () => {
    renderDevices();

    expect(screen.getByRole("heading", { name: "Mobile App" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Desktop App" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Devices" })).toBeNull();
    expect(screen.queryByText(/from the same place you downloaded/i)).toBeNull();
    expect(screen.queryByText(/^Computers: use the Luna Desktop app\.$/i)).toBeNull();

    expect(screen.getByText(/copies photos to this Luna/i)).toBeTruthy();
    expect(screen.getByText(/Phone Backup/)).toBeTruthy();
    expect(screen.getByText(/copy folders onto this Luna/i)).toBeTruthy();

    const mobileDownload = screen.getByRole("link", { name: /Download the Luna app for phones/i });
    expect(mobileDownload).toHaveAttribute("href", MOBILE_APP_DOWNLOAD_URL);
    expect(mobileDownload).toHaveAttribute("target", "_blank");

    const desktopDownload = screen.getByRole("link", { name: /Download Luna Desktop/i });
    expect(desktopDownload).toHaveAttribute("href", DESKTOP_APP_DOWNLOAD_URL);

    const tokenLink = screen.getByRole("link", { name: /Create an access token on Security/i });
    expect(tokenLink).toHaveAttribute("href", "/settings#security");
    expect(screen.getByText(/without storing your password/i)).toBeTruthy();
  });
});
