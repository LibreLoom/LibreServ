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

    expect(
      screen.getByText("Back up your photos from your phone onto your Luna."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Backup folders onto your Luna and access your Luna's files directly from your computer.",
      ),
    ).toBeTruthy();

    expect(screen.queryByText(/copies new photos from the phone/i)).toBeNull();
    expect(screen.queryByText(/no iPhone app yet/i)).toBeNull();
    expect(screen.queryByText(/pick a drive and a folder/i)).toBeNull();
    expect(screen.queryByText(/year and month/i)).toBeNull();
    expect(screen.queryByText(/you choose when backup runs/i)).toBeNull();
    expect(screen.queryByText(/copy folders onto this Luna/i)).toBeNull();
    expect(screen.queryByText(/without storing your password/i)).toBeNull();
    expect(screen.queryByText(/Phone Backup/)).toBeNull();
    expect(screen.queryByText(/Sign in with your Luna username/i)).toBeNull();

    const mobileDownload = screen.getByRole("link", { name: /Download the Luna app for Android/i });
    expect(mobileDownload).toHaveAttribute("href", MOBILE_APP_DOWNLOAD_URL);
    expect(mobileDownload).toHaveAttribute("target", "_blank");

    const desktopDownload = screen.getByRole("link", { name: /Download Luna for Linux/i });
    expect(desktopDownload).toHaveAttribute("href", DESKTOP_APP_DOWNLOAD_URL);

    const tokenLinks = screen.getAllByRole("link", { name: /Create an access token in Security/i });
    expect(tokenLinks).toHaveLength(2);
    expect(tokenLinks[0]).toHaveAttribute("href", "/settings#security");
  });
});
