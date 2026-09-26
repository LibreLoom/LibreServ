import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import DocumentLoadingScreen from "./DocumentLoadingScreen.jsx";
import DotMatrixLoader from "@libreloom/ui/components/ui/DotMatrixLoader.jsx";

describe("DocumentLoadingScreen & DotMatrixLoader", () => {
  it("renders a status role with accessible screen-reader label without visible text", () => {
    const { container } = render(
      <DocumentLoadingScreen label="Opening presentation" />,
    );
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(status.getAttribute("aria-label")).toBe("Opening presentation");

    // Accessible sr-only text is present
    const srOnly = container.querySelector(".sr-only");
    expect(srOnly).toHaveTextContent("Opening presentation");

    // Contains the matrix canvas element
    const canvas = container.querySelector('[data-slot="matrix-canvas"]');
    expect(canvas).toBeInTheDocument();
  });

  it("supports decorative mode for DotMatrixLoader", () => {
    const { container } = render(
      <DotMatrixLoader decorative label="Decorative matrix" />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    const loader = container.querySelector('[data-slot="matrix-loader"]');
    expect(loader).toHaveAttribute("aria-hidden", "true");
  });

  it("mounts and unmounts cleanly without throwing", () => {
    const { unmount } = render(<DocumentLoadingScreen />);
    expect(() => unmount()).not.toThrow();
  });
});
