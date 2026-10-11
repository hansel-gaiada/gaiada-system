import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { tenantCookie } from "./appCookies";

// WSK-49f — website-access grant screens, in a real browser, in DEMO_MODE, against the §16i stub
// (src/lib/demoWebsiteAccess.ts models the controller's refusals: authorize first, changed:false, self-grant
// refused, project-scoped rows unlisted).
//
// The file name ends `portal.spec.ts` on purpose: playwright.config.ts's `portal` project matches
// /portal\.spec\.ts/, which has NO stored session. That matters here: every test signs in as a specific
// identity (staff, a client admin, a client viewer, a client signer), and a stored staff session would
// silently test the wrong shell.
//
// SERIAL, and each test puts back what it changed. The demo store is one object in the dev server's
// process; the rest of the portal suite reads the same People page, so a test that left Marco with website
// access, or Vera an admin, would make a neighbour's run depend on order.
test.describe.configure({ mode: "serial" });

async function signIn(page: Page, email: string, landing: "**/" | "**/portal"): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(landing);
}

async function openStaffContacts(page: Page): Promise<void> {
  await signIn(page, "hansel@gaiada.com", "**/");
  // `CLIENTS` is a flat global array in the demo fixtures but the agency's data lives under co-agency:
  // pin the tenant, as client-hub.spec.ts does, or the page opens against the wrong company.
  await page.context().addCookies([tenantCookie(page.url())]);
  await page.goto("/clients/cl-1/contacts");
  await expect(page.getByRole("heading", { name: "Website editors" })).toBeVisible();
}

const status = (page: Page) => page.locator(".wa-status[role=\"status\"]");

test.describe("staff: client Contacts page", () => {
  test("staff make a contact Admin, give another contact website access, and put both back @portal", async ({ page }) => {
    test.setTimeout(150_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (e) => pageErrors.push(e));
    await openStaffContacts(page);

    // Capability labels, and a Website editor switch named for each person.
    const list = page.getByRole("list", { name: /website access for northwind traders/i });
    await expect(list.getByText("Admin", { exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Website editor: Marco Halim" })).not.toBeChecked();
    // The project-limited contact is not listed in THIS card (she is in Client access above, labelled with
    // her project), and the card says why.
    await expect(list.getByText("Erica Boonstra")).toHaveCount(0);
    await expect(page.getByText(/limited to one\s+project can.t edit the website/i)).toBeVisible();

    // ── make Vera an Admin ──
    const makeAdmin = page.getByRole("button", { name: "Make admin: Vera Santoso" });
    await makeAdmin.click();
    const dialog = page.getByRole("dialog", { name: "Make Vera Santoso an admin?" });
    await expect(dialog.getByText(/Can sign, and can give colleagues website access/)).toBeVisible();
    await dialog.getByRole("button", { name: "Make admin" }).click();
    await expect(status(page)).toHaveText("Vera Santoso is now an admin.");
    await expect(page.getByRole("button", { name: "Remove admin: Vera Santoso" })).toBeVisible();
    // Focus went back to the control that opened the dialog (the same element, now "Remove admin").
    await expect(page.getByRole("button", { name: "Remove admin: Vera Santoso" })).toBeFocused();

    // ── give Marco website access ──
    const marco = page.getByRole("switch", { name: "Website editor: Marco Halim" });
    await marco.click();
    await expect(status(page)).toHaveText("Website access given to Marco Halim.");
    await expect(marco).toBeChecked();
    // Persisted server-side, not just in component state.
    await page.reload();
    await expect(page.getByRole("switch", { name: "Website editor: Marco Halim" })).toBeChecked();
    await expect(page.getByRole("button", { name: "Remove admin: Vera Santoso" })).toBeVisible();

    // ── put both back ──
    await page.getByRole("switch", { name: "Website editor: Marco Halim" }).click();
    await expect(status(page)).toHaveText("Website access removed from Marco Halim.");
    await page.getByRole("button", { name: "Remove admin: Vera Santoso" }).click();
    const removeDialog = page.getByRole("dialog", { name: "Remove admin from Vera Santoso?" });
    // Viewer is the default; the choice is explicit.
    await expect(removeDialog.getByRole("radio", { name: /viewer/i })).toBeChecked();
    await removeDialog.getByRole("button", { name: "Remove admin" }).click();
    await expect(status(page)).toHaveText("Vera Santoso is no longer an admin and is now a Viewer.");
    await expect(page.getByRole("button", { name: "Make admin: Vera Santoso" })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test("the Remove admin dialog traps focus and Escape closes it, returning focus @portal", async ({ page }) => {
    test.setTimeout(120_000);
    await openStaffContacts(page);
    const opener = page.getByRole("button", { name: "Remove admin: Aria Hartono" });
    await opener.focus();
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Remove admin from Aria Hartono?" });
    await expect(dialog).toBeVisible();
    // Tab around more times than there are controls: focus never leaves the dialog.
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    // Nothing was changed.
    await expect(page.getByRole("button", { name: "Remove admin: Aria Hartono" })).toBeVisible();
  });

  test("a member sees who has website access but no controls @portal", async ({ page }) => {
    await signIn(page, "gede@gaiada.com", "**/");
    await page.context().addCookies([tenantCookie(page.url())]);
    await page.goto("/clients/cl-1/contacts");
    await expect(page.getByRole("heading", { name: "Website editors" })).toBeVisible();
    await expect(page.getByRole("list", { name: /website access for northwind traders/i }).getByText("Aria Hartono")).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /admin:/i })).toHaveCount(0);
  });
});

test.describe("portal: People page", () => {
  test("a client admin gives a colleague website access and removes it @portal", async ({ page }) => {
    test.setTimeout(150_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (e) => pageErrors.push(e));
    await signIn(page, "admin@northwind.example", "**/portal");
    await page.goto("/portal/profile");
    await expect(page.getByRole("heading", { name: "Website access" })).toBeVisible();
    await expect(
      page.getByText("Website access: lets this person edit and publish your website in this portal."),
    ).toBeVisible();

    // An admin can do exactly one thing here: no capability, no role, nothing to make an admin.
    await expect(page.getByRole("button", { name: /make admin|remove admin/i })).toHaveCount(0);

    const dana = page.getByRole("switch", { name: "Website access for Dana Whitfield" });
    await expect(dana).not.toBeChecked();
    await dana.click();
    await expect(status(page)).toHaveText("Website access given to Dana Whitfield.");
    await expect(dana).toBeChecked();
    await page.reload();
    await expect(page.getByRole("switch", { name: "Website access for Dana Whitfield" })).toBeChecked();

    // Removing it.
    await page.getByRole("switch", { name: "Website access for Dana Whitfield" }).click();
    await expect(status(page)).toHaveText("Website access removed from Dana Whitfield.");
    await expect(page.getByRole("switch", { name: "Website access for Dana Whitfield" })).not.toBeChecked();

    // Granting yourself is whatever the BFF says: here it refuses, and the page shows that answer.
    await page.getByRole("switch", { name: "Website access for Aria Hartono" }).click();
    await expect(status(page)).toContainText(/can.t give website access to yourself/i);
    await expect(page.getByRole("switch", { name: "Website access for Aria Hartono" })).not.toBeChecked();

    expect(pageErrors).toEqual([]);
  });

  test("a client viewer and a client signer see no Website access section at all @portal", async ({ page }) => {
    test.setTimeout(150_000);
    for (const email of ["viewer@northwind.example", "dana@northwind.example"]) {
      await page.context().clearCookies();
      await signIn(page, email, "**/portal");
      await page.goto("/portal/profile");
      await expect(page.getByRole("heading", { level: 1 })).toContainText(/People/);
      await expect(page.getByRole("heading", { name: /^Your people/ })).toBeVisible();
      await expect(page.getByText(/website access/i)).toHaveCount(0);
      await expect(page.getByRole("switch")).toHaveCount(0);
    }
  });
});

// axe-core, both pages, both colour schemes. As in a11y-axe.spec.ts: a green run means "no regression in
// the rules axe checks" (about a third of what a manual audit finds), never "accessible". No rule is
// disabled and nothing is excluded.
async function runAxe(page: Page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`axe — ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    test(`the staff Contacts page, website access card, has no axe violations (${scheme}) @portal`, async ({ page }) => {
      test.setTimeout(150_000);
      await openStaffContacts(page);
      const { violations } = await runAxe(page);
      const found = violations.map((v) => `[${v.impact}] ${v.id} (${v.nodes.length}): ${v.help}\n   ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n   ")}`);
      expect(found, found.join("\n")).toEqual([]);
    });

    test(`the staff Remove admin dialog has no axe violations (${scheme}) @portal`, async ({ page }) => {
      test.setTimeout(150_000);
      await openStaffContacts(page);
      await page.getByRole("button", { name: "Remove admin: Aria Hartono" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      const { violations } = await runAxe(page);
      const found = violations.map((v) => `[${v.impact}] ${v.id} (${v.nodes.length}): ${v.help}\n   ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n   ")}`);
      expect(found, found.join("\n")).toEqual([]);
    });

    test(`the portal People page, as a client admin, has no axe violations (${scheme}) @portal`, async ({ page }) => {
      test.setTimeout(150_000);
      await signIn(page, "admin@northwind.example", "**/portal");
      await page.goto("/portal/profile");
      await expect(page.getByRole("heading", { name: "Website access" })).toBeVisible();
      const { violations } = await runAxe(page);
      const found = violations.map((v) => `[${v.impact}] ${v.id} (${v.nodes.length}): ${v.help}\n   ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n   ")}`);
      expect(found, found.join("\n")).toEqual([]);
    });
  });
}
