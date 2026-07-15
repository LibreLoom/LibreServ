/* color-scan: ignore-file - demo page with mock data */
import { useState } from "react";
import HeaderCard from "../components/cards/HeaderCard.jsx";
import AccessControlSection from "../components/app/AccessControlSection.jsx";

/**
 * AccessControlDemo — preview of the AccessControlSection component.
 *
 * Mocks the API layer so the component renders with realistic data without
 * a running backend. Switch between Internal (SSO) and External (restricted)
 * to see both variants.
 *
 * Visit /access-control-demo to review.
 */

// ─── Mock data ──────────────────────────────────────────────────────

const MOCK_USERS = [
  { id: "u1", username: "alice", email: "alice@example.com" },
  { id: "u2", username: "bob", email: "bob@example.com" },
  { id: "u3", username: "carol", email: "carol@example.com" },
  { id: "u4", username: "dave", email: "dave@example.com" },
];

const MOCK_ACCESS = [
  { user_id: "u1", username: "alice", email: "alice@example.com", granted_at: "2026-07-10T12:00:00Z" },
  { user_id: "u2", username: "bob", email: "bob@example.com", granted_at: "2026-07-12T09:30:00Z" },
];

// ─── Mock API interceptor ──────────────────────────────────────────

const ORIGINAL_FETCH = window.fetch;

function installMockApi() {
  window.fetch = async (url, opts) => {
    const path = typeof url === "string" ? url : url.toString();
    const method = (opts?.method || "GET").toUpperCase();

    // Users list
    if (path.endsWith("/api/v1/users") && method === "GET") {
      return new Response(JSON.stringify({ data: MOCK_USERS }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // OIDC status — returns {configured: true}, no credentials
    if (path.match(/\/api\/v1\/apps\/[^/]+\/oidc$/) && method === "GET") {
      return new Response(JSON.stringify({ configured: true, issuer: "https://libreserv.example.com" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Access list
    if (path.match(/\/api\/v1\/apps\/[^/]+\/oidc\/access$/) && method === "GET") {
      return new Response(JSON.stringify(MOCK_ACCESS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Restricted access
    if (path.match(/\/api\/v1\/apps\/[^/]+\/oidc\/restricted$/) && method === "GET") {
      return new Response(JSON.stringify({ restricted_access: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Grant access
    if (path.match(/\/api\/v1\/apps\/[^/]+\/oidc\/access$/) && method === "POST") {
      return new Response(JSON.stringify({ message: "Access granted." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Revoke access
    if (path.match(/\/api\/v1\/apps\/[^/]+\/oidc\/access\//) && method === "DELETE") {
      return new Response(JSON.stringify({ message: "Access revoked." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Toggle restricted
    if (path.match(/\/api\/v1\/apps\/[^/]+\/oidc\/restricted$/) && method === "PUT") {
      return new Response(JSON.stringify({ restricted_access: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Fallback to real fetch
    return ORIGINAL_FETCH(url, opts);
  };
}

function uninstallMockApi() {
  window.fetch = ORIGINAL_FETCH;
}

// ─── Demo page ─────────────────────────────────────────────────────

export default function AccessControlDemo() {
  const [variant, setVariant] = useState(/** @type {"internal" | "external"} */ ("internal"));

  // Install mock API on mount, uninstall on unmount
  useState(() => {
    installMockApi();
    return () => uninstallMockApi();
  });

  return (
    <main className="bg-primary text-secondary px-8 pt-5 pb-32 min-h-screen">
      <HeaderCard title="Access Control — Component Preview" />

      <div className="mt-6 max-w-3xl">
        <p className="text-sm text-secondary/80 mb-6">
          This page previews the access management UI that appears in each
          app's settings. Switch between the two access models to see how the
          panel changes.
        </p>

        {/* Variant switcher */}
        <div className="flex gap-2 mb-8">
          <button
            onClick={() => setVariant("internal")}
            className={`px-6 py-3 rounded-pill font-mono transition-colors ${
              variant === "internal"
                ? "bg-secondary text-primary"
                : "border-2 border-primary/20 text-secondary/80 hover:bg-primary/5"
            }`}
          >
            Internal (SSO)
          </button>
          <button
            onClick={() => setVariant("external")}
            className={`px-6 py-3 rounded-pill font-mono transition-colors ${
              variant === "external"
                ? "bg-secondary text-primary"
                : "border-2 border-primary/20 text-secondary/80 hover:bg-primary/5"
            }`}
          >
            External (Restricted)
          </button>
        </div>

        <AccessControlSection
          instanceId="demo-instance"
          accessModel={variant}
          appName={variant === "internal" ? "Nextcloud" : "ConvertX"}
        />
      </div>
    </main>
  );
}
