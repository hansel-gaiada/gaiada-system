import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// The site overview's "API keys" section: it appears ONLY for a user whose role passes the BFF's gate (`promote` on
// `webdev_provisioned_site`, mirrored as `webdev.promote`), and it takes its environments from the existing site read.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContentActions", () => ({ requestKeyAction: vi.fn() }));
vi.mock("@/lib/webdeskContent", () => ({ loadSiteContext: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { loadSiteContext } from "@/lib/webdeskContent";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import WebsiteSitePage from "./page";

const ctxMock = vi.mocked(requireWebsiteCtx);
const siteMock = vi.mocked(loadSiteContext);

const PROD = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const STG = "2b3c4d5e-6f70-4b8c-9d0e-1f2a3b4c5d6e";

const meWith = (role: string, scopeId = "co-1") => ({
  userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies: [{ id: "co-1", name: "Gaia" }],
  roles: [{ role, scopeType: "company", scopeId }],
}) as never;

const mount = async (me: unknown) => {
  ctxMock.mockResolvedValue({ userId: "u", me, company: "co-1", deptId: "dept-1", contentBase: "/departments/dept-1/website/content" } as never);
  render(await WebsiteSitePage({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }) }));
};

beforeEach(() => {
  ctxMock.mockReset(); siteMock.mockReset();
  siteMock.mockResolvedValue({
    kind: "ok",
    data: {
      tenant: { slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites: [] },
      site: {
        siteId: "site-1", name: "gaiada.com", kind: "static",
        environments: [{ envId: STG, name: "staging", domain: "24-pyevq.gaiada.com", status: "active" }, { envId: PROD, name: "production", domain: "gaiada.com", status: "active" }],
      },
      collections: [],
    },
  });
});

describe("site overview: API keys", () => {
  it.each(["company_admin", "manager"])("%s can promote: the control is there, with the site's environments from the existing read", async (role) => {
    await mount(meWith(role));
    expect(screen.getByTestId("request-key")).toBeTruthy();
    const env = screen.getByLabelText("Environment") as HTMLSelectElement;
    expect([...env.options].map((o) => o.value)).toEqual(["", STG, PROD]);
    expect(siteMock).toHaveBeenCalledTimes(1); // no second read
  });

  it.each(["member", "viewer", "org_unit_lead", "agency_approver"])("%s cannot promote: nothing at all (no heading, no disabled button)", async (role) => {
    await mount(meWith(role));
    expect(screen.queryByTestId("request-key")).toBeNull();
    expect(screen.queryByText("API keys")).toBeNull();
    expect(screen.queryByRole("button", { name: /API key/ })).toBeNull();
  });

  it("a manager of ANOTHER company is not offered it here", async () => {
    await mount(meWith("manager", "co-other"));
    expect(screen.queryByTestId("request-key")).toBeNull();
  });
});
