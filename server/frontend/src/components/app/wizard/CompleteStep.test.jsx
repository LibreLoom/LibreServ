import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import CompleteStep from "./CompleteStep";

describe("CompleteStep", () => {
  // Regression guard for the "Open App" link scheme (was hardcoded http://,
  // contradicting the HTTPS goal). The link must use the backend-provided
  // public URL — which carries https when AutoHTTPS is on — not a
  // reconstructed http://subdomain.domain.
  it("uses the backend-provided public URL for the Open App link", () => {
    render(
      <CompleteStep
        app={{ name: "Test App" }}
        instance={{
          url: "https://app.example.com",
          subdomain: "app",
          domain: "example.com",
        }}
        onDone={() => {}}
      />,
    );
    const link = screen.getByRole("link", { name: /open app/i });
    expect(link.getAttribute("href")).toBe("https://app.example.com");
  });

  it("prefers the public URL over subdomain/domain reconstruction", () => {
    // Even when subdomain+domain are present, the link must follow the
    // backend URL (https), not a reconstructed http://subdomain.domain.
    render(
      <CompleteStep
        app={{ name: "Test App" }}
        instance={{
          url: "https://app.example.com",
          subdomain: "app",
          domain: "example.com",
        }}
        onDone={() => {}}
      />,
    );
    const link = screen.getByRole("link", { name: /open app/i });
    expect(link.getAttribute("href")).toBe("https://app.example.com");
    expect(link.getAttribute("href")).not.toMatch(/^http:\/\//);
  });

  it("falls back to a backend URL when no public URL is set", () => {
    render(
      <CompleteStep
        app={{ name: "Test App" }}
        instance={{ url: "http://localhost:8080" }}
        onDone={() => {}}
      />,
    );
    const link = screen.getByRole("link", { name: /open app/i });
    expect(link.getAttribute("href")).toBe("http://localhost:8080");
  });

  it("does not render an Open App link when there is no URL", () => {
    render(
      <CompleteStep app={{ name: "Test App" }} instance={{}} onDone={() => {}} />,
    );
    expect(screen.queryByRole("link", { name: /open app/i })).toBeNull();
  });
});