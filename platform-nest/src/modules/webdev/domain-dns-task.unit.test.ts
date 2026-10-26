// M6-P6p — the pure part of the DNS task: its text. The task names the domain, lists EVERY record (type, name, target) and points at
// the site's console page. No database, no resolver. `.test` / `.example` fixtures only (the repo is public).
import { describe, it, expect } from "vitest";
import { dnsTaskDescription, dnsTaskTitle } from "./domain-dns-task.service";

const SITE = "00000000-0000-4000-8000-0000000000aa";

describe("dnsTaskDescription / dnsTaskTitle (M6-P6p)", () => {
  it("names the domain and lists every record with its type, name and target", () => {
    const text = dnsTaskDescription({
      domain: "shop.example.com", siteId: SITE, departmentId: "d-web",
      records: [
        { type: "A", name: "shop.example.com", target: "203.0.113.10" },
        { type: "AAAA", name: "shop.example.com", target: "2001:db8::10" },
      ],
    });
    expect(dnsTaskTitle("shop.example.com")).toContain("shop.example.com");
    expect(text).toContain("Domain: shop.example.com");
    expect(text).toContain("A  shop.example.com  ->  203.0.113.10");
    expect(text).toContain("AAAA  shop.example.com  ->  2001:db8::10");
  });

  it("links the console page when the department is known, and names the registry row when it is not", () => {
    const rec = [{ type: "CNAME" as const, name: "shop.example.com", target: "edge.hosting.example.net" }];
    expect(dnsTaskDescription({ domain: "shop.example.com", siteId: SITE, departmentId: "d-web", records: rec }))
      .toContain(`/departments/d-web/sites/portfolio/${SITE}`);
    const noDept = dnsTaskDescription({ domain: "shop.example.com", siteId: SITE, departmentId: null, records: rec });
    expect(noDept).toContain(`Site registry row: ${SITE}`);
    expect(noDept).not.toContain("/departments/");
  });

  it("says the ERP holds no DNS credential and checks the records itself", () => {
    const text = dnsTaskDescription({ domain: "a.example.com", siteId: SITE, departmentId: null, records: [] });
    expect(text).toMatch(/no DNS credential/);
    expect(text).toMatch(/checks the domain itself, read-only/);
  });
});
