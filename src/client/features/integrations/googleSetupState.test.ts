import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { SearchConsoleConnectionCard } from "@/client/features/gsc/SearchConsoleConnectionCard";
import { GoogleAnalyticsConnectionCard } from "@/client/features/ga4/GoogleAnalyticsConnectionCard";
import { SearchConsoleOnboardingStep } from "@/client/features/onboarding/SearchConsoleOnboardingStep";

vi.mock("@/serverFunctions/gsc", () => ({
  getGscConnection: vi.fn(),
  listGscSites: vi.fn(),
  setGscSite: vi.fn(),
  disconnectGsc: vi.fn(),
}));
vi.mock("@/serverFunctions/ga4", () => ({
  getGa4Connection: vi.fn(),
  listGa4Properties: vi.fn(),
  setGa4Property: vi.fn(),
  disconnectGa4: vi.fn(),
}));
vi.mock("@/serverFunctions/projects", () => ({ getProjects: vi.fn() }));
vi.mock("@/serverFunctions/googleAccounts", () => ({
  getGoogleAccountRemovalImpact: vi.fn(),
  removeGoogleAccount: vi.fn(),
}));
vi.mock("@/client/features/integrations/startGoogleLink", () => ({
  startGoogleLink: vi.fn(),
  useGoogleLinkPending: () => false,
}));
vi.mock("@/client/features/integrations/googleLinkError", () => ({
  getGoogleLinkError: () => null,
  clearGoogleLinkError: vi.fn(),
  reportGoogleLinkErrorOnce: vi.fn(),
}));
vi.mock("@/lib/auth-mode", () => ({ isHostedClientAuthMode: () => true }));
vi.mock("@/client/lib/posthog", () => ({ captureClientEvent: vi.fn() }));

function renderSetup(
  surface: "gsc" | "ga4" | "onboarding",
  hasGrant: boolean,
  connected = false,
  canManage = true,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["projects"], [{ id: "project-a" }]);
  const provider = surface === "ga4" ? "ga4" : "gsc";
  client.setQueryData([`${provider}Connection`, "project-a"], {
    connected,
    currentUserHasGrant: hasGrant,
    canManage,
    googleOAuthConfigured: true,
    siteUrl: "https://example.com/",
    propertyId: "properties/123",
    propertyDisplayName: "Example",
  });
  const component =
    surface === "onboarding"
      ? createElement(SearchConsoleOnboardingStep)
      : createElement(
          surface === "gsc"
            ? SearchConsoleConnectionCard
            : GoogleAnalyticsConnectionCard,
          { projectId: "project-a" },
        );
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, component),
  );
  client.clear();
  return html;
}

describe.each(["gsc", "ga4", "onboarding"] as const)(
  "%s setup from persisted authorization",
  (surface) => {
    it("opens property selection without a browser resume flag after authorization", () => {
      const html = renderSetup(surface, true);
      expect(html).toContain("Choose property");
      expect(html).toContain("Select a property");
      expect(html).not.toContain("Connect with Google");
    });
    it("offers authorization when no account has been linked", () => {
      const html = renderSetup(surface, false);
      expect(html).not.toContain("Select a property");
      expect(html).toContain(
        surface === "onboarding" ? "Connect with Google" : "Connect",
      );
    });
    it("shows the saved connection rather than reopening setup", () => {
      const html = renderSetup(surface, true, true);
      expect(html).not.toContain("Select a property");
      expect(html).toContain(
        surface === "ga4" ? "Example" : "https://example.com/",
      );
    });
  },
);

it.each(["gsc", "ga4"] as const)(
  "does not automatically open property editing for a %s viewer",
  (surface) => {
    const html = renderSetup(surface, true, false, false);
    expect(html).not.toContain("Select a property");
    expect(html).toContain("Manage Google accounts");
  },
);
