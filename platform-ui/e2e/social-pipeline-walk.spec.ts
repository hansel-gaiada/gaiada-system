import { test, expect, type Locator, type Page } from "@playwright/test";
import { tenantCookie } from "./appCookies";

// SCP-1p (plan docs/plans/2026-10-15-social-content-pipeline.md §1 loops a to c, §11.1; BFF §63.3, §63.6, §63.16): the Social Media content pipeline walked
// end to end in a real browser, one persona at a time, each signed in through the real login page. NO route mocks: the DEMO_MODE store
// (src/lib/demoSocialPipeline.ts, pinned to globalThis in the Next server) keeps the post between requests and between logins, which is what makes a
// walk across five people possible at all. The walk runs on the DEMO_MODE production build with the Social skin, in the `social-walk` project.
//
//   Officer      social@gaiada.com          creates the post, starts the draft, fills it, sends it to proofread
//   Copywriter   copywriter@gaiada.com      LOOP A: suggests an edit, returns the copy with a note; later approves the copy
//   Officer      (again)                    accepts the suggestion, fixes the copy, sends it back to proofread
//   HoD          social-head@gaiada.com     LOOP B: asks for changes; the officer's fix goes STRAIGHT back (no second proofread); then approves for design
//   Creative     creative@gaiada.com        starts the design, adds a design LINK, submits
//   GM           gm@gaiada.com              the final check: "Send to the client" is disabled, with the reason in words, while the design is only a link
//   HoD          (again)                    LOOP C1: a design change goes back to the Creative, who swaps the link for an Asset Library design and resubmits
//   GM           (again)                    LOOP C2: a copy change goes back to the Officer, who resends; back at the final check; then the GM SENDS the post to the client
//   Superadmin   hansel@gaiada.com          MAKER/CHECKER: the author of a post cannot pass it at proofread, refused in plain words
//
// ── FINDINGS THIS WALK RECORDED ──────────────────────────────────────────────────────────────────────────────────────────────
// F1  FIXED (SCP-1u). The demo served no `GET creative/assets`, so the designer's Asset Library picker was always empty and a design could only be a link, which
//     the final check refuses (`design_not_stored`): the walk's own post could never reach the client. The demo now answers that read from `DEMO_ASSETS`
//     (`demoAssetLibraryRead`), and an asset design counts as stored exactly as the server decides it (the design has an asset group and version, not a link),
//     so the walk's Creative swaps the link for an Asset Library design in loop c1 and the GM sends the walk's own post to the client (test 14, no longer a fixme).
// F3  FIXED (SCP-1u). The demo listed "Send to the client" and "Submit for the final check" as live where the server's read lists them disabled (`design_not_stored`,
//     `design_missing`); they were refused only when clicked. `actions[]` now runs the machine's body-free guards in the fixture's order, so a link-only post shows the
//     button disabled with the reason beside it (test 9), which is what the real ERP shows.
// F2  A person who is both the author and an approver (the superadmin) can only be shown the maker/checker refusal as a DISABLED button with the reason
//     beside it: the page never offers the click, so the server's 403 `author_cannot_approve` body is not reachable through this UI (platform-nest's walk
//     test covers the 403 itself).
//
// ── WHY ITS OWN PROJECT ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Every test signs in itself, so no stored session. Serial and order-dependent inside the file; independent of every other project: the post is created by
// the walk (a title of its own) and touches no seeded post. Run the file against a FRESH server: the demo
// store lives in the server's memory. Gated on sumopod with the other workspace projects, retries off.

const TENANT = "co-agency";
const CLIENT_PAGE = "/departments/dept-4/profile/soc-eng-1"; // Northwind Traders: officer u-social, designs by Creatives

const OFFICER = "social@gaiada.com";
const COPYWRITER = "copywriter@gaiada.com";
const HOD = "social-head@gaiada.com";
const CREATIVE = "creative@gaiada.com";
const GM = "gm@gaiada.com";
const SUPERADMIN = "hansel@gaiada.com";

const OFFICER_NAME = "Komang Lestari";
const COPYWRITER_NAME = "Citra Maheswari";
const DESIGNER_NAME = "Putu Rani";

const RUN = Date.now().toString(36);
const TITLE = `Walk post ${RUN}`;
const TITLE_MC = `Walk maker-checker ${RUN}`;
const CAPTION_FIRST = "Walk caption: the first draft of the note.";
const CAPTION_SUGGESTED = "Walk caption: the copywriter's clearer version of the note.";
const MAKER_CHECKER = "You wrote or look after this post, so you cannot pass it at this step. Another person has to.";
const LINK_ONE = "https://example.com/walk/design-one";
const ASSET_NAME = "Autumn hero - final.png"; // the demo's invented Asset Library asset (`DEMO_ASSETS[0]`)
const ASSET_GROUP = "demo-asset-g1";

let POST_URL = "";
let MC_URL = "";

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: "reduce" } });
test.describe.configure({ mode: "serial" });

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A button is a plain control until React owns it; clicking earlier does nothing (same helper as skin-social.spec.ts).
async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function press(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.click();
}
async function tick(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.check();
}

/** Sign in through the real login page, then plant the tenant cookie (every workspace spec does). */
async function signIn(page: Page, context: import("@playwright/test").BrowserContext, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await context.addCookies([tenantCookie(page.url(), TENANT)]);
}

// The page can hold a second, HIDDEN copy of the post (the diagnostic in `open` reports it); every plain CSS locator here sees visible elements only,
// because Playwright's strict mode counts hidden ones too (role queries skip them already).
const seen = (page: Page, css: string) => page.locator(css).filter({ visible: true }).first();
const chip = (page: Page) => seen(page, ".scp-post__chips .scp-chip");
const meta = (page: Page) => seen(page, ".scp-post__meta");
const banner = (page: Page) => seen(page, ".scp-post__banner--changes");
const bar = (page: Page) => page.getByRole("region", { name: "Actions" });
const activity = (page: Page) => page.getByRole("list", { name: "Activity" });

/** The action as a LIVE button of the bar: a disabled one (listed under "Not available to you") is not live. */
const live = (page: Page, name: string) => bar(page).locator("button:not([disabled])").filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
/** The "Not available to you" row of an action: the disabled button and the reason in words beside it. */
const offRow = (page: Page, name: string) => bar(page).locator(".scp-actions__off li").filter({ hasText: name });

async function open(page: Page, url: string, title?: string) {
  await page.goto(url);
  await expect(bar(page)).toBeVisible();
  const copies = await page.locator(".scp-post__meta").evaluateAll((els) =>
    els.map((el) => { const chain: string[] = []; for (let n: Element | null = el.parentElement; n && chain.length < 6; n = n.parentElement) chain.push(`${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}${n.className && typeof n.className === "string" ? "." + n.className.split(" ")[0] : ""}${getComputedStyle(n).display === "none" ? "[display:none]" : ""}`); return chain.join(" < "); }),
  );
  if (copies.length > 1) console.log(`DIAG ${url}: ${copies.length} copies of the post on screen: ${JSON.stringify(copies)}`);
  if (title) await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

async function expectAt(page: Page, status: string, holder: string) {
  await expect(chip(page)).toHaveText(status);
  await expect(meta(page)).toContainText(`With: ${holder}`);
}

async function act(page: Page, name: string) {
  await press(live(page, name));
}

async function editField(page: Page, label: string, fill: (row: Locator) => Promise<void>) {
  const row = page.getByRole("group", { name: label, exact: true });
  await press(row.getByRole("button", { name: `Edit ${label}`, exact: true }));
  await fill(row);
  const save = row.getByRole("button", { name: "Save", exact: true });
  await press(save);
  await expect(save).toBeHidden();
}

/** Creates a post through the client page's "+ New post" and returns its URL. The date is given: the send needs one (a hard check). */
async function createPost(page: Page, title: string): Promise<string> {
  await page.goto(CLIENT_PAGE);
  await press(page.getByRole("button", { name: "+ New post", exact: true }));
  const form = page.getByRole("form", { name: "New post" });
  await form.getByLabel("Title").fill(title);
  const at = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await form.getByLabel("Date and time").fill(`${at}T10:00`);
  await press(form.getByRole("button", { name: "Add post", exact: true }));
  await expect(page.getByText("Post added to the plan.")).toBeVisible();
  const href = await page.getByRole("link", { name: "Open it" }).getAttribute("href");
  expect(href).toMatch(/^\/departments\/dept-4\/posts\/.+/);
  return href as string;
}

/** The officer's draft: the caption, the text on the image, a call to action, all ten must-haves, an angle. The date and networks came with the post. */
async function fillDraft(page: Page) {
  await editField(page, "Caption", (r) => r.getByRole("textbox", { name: "Caption", exact: true }).fill(CAPTION_FIRST));
  await editField(page, "Text on the image", (r) => r.getByRole("textbox", { name: "Text on the image", exact: true }).fill("Walk text"));
  await editField(page, "Call to action", (r) => r.getByRole("textbox", { name: "Call to action", exact: true }).fill("Learn more"));
  await editField(page, "Must-haves", async (r) => {
    const boxes = r.getByRole("checkbox");
    await expect(boxes).toHaveCount(10);
    for (let i = 0; i < 10; i++) await tick(boxes.nth(i));
  });
  await press(page.getByRole("tab", { name: "Creative brief" }));
  await editField(page, "Angle", (r) => r.getByRole("textbox", { name: "Angle", exact: true }).fill("An honest look at how the walk is made."));
  await press(page.getByRole("tab", { name: "Post", exact: true }));
}

/** Sends to proofread. If a soft hand-off check fails the dialog appears: send anyway with a reason, and note it (the draft should pass them all). */
async function sendToProofread(page: Page) {
  await act(page, "Send to proofread");
  const dlg = page.getByRole("dialog", { name: "Send to proofread" });
  await expect.poll(async () => (await chip(page).innerText()) === "Proofread" || (await dlg.isVisible())).toBe(true);
  if (await dlg.isVisible()) {
    test.info().annotations.push({ type: "note", description: "A soft hand-off check failed on the walk's own draft; sent anyway: " + (await dlg.locator(".scp-dialog__check--bad").allInnerTexts()).join(" | ") });
    await tick(dlg.getByLabel("Send anyway"));
    await dlg.getByRole("textbox").fill("Walk test: sent with a soft check failing.");
    await press(dlg.getByRole("button", { name: "Send to proofread", exact: true }));
  }
  await expectAt(page, "Proofread", `Copywriter: ${COPYWRITER_NAME}`);
}

/** A note dialog (return, hod_changes, final_changes): fills the field named and presses the dialog's own button. */
async function noteDialog(page: Page, title: string, field: string | RegExp, note: string, kind?: "The copy" | "The design") {
  const dlg = page.getByRole("dialog", { name: title });
  await expect(dlg).toBeVisible();
  if (kind) await tick(dlg.getByRole("radio", { name: kind, exact: true }));
  await dlg.getByLabel(field).fill(note);
  await press(dlg.getByRole("button", { name: title, exact: true }));
  await expect(dlg).toBeHidden();
}

// ── the walk ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("SCP-1p: the content pipeline walked by its five roles", () => {
  test("1 Officer: creates the post, starts the draft, fills it and sends it to proofread", async ({ page, context }) => {
    await signIn(page, context, OFFICER);
    POST_URL = await createPost(page, TITLE);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "Planned", `Officer: ${OFFICER_NAME}`);
    // Only the officer's step is live: the proofread and approval actions are not even listed at Planned.
    await expect(live(page, "Start draft")).toBeVisible();
    await expect(live(page, "Approve copy")).toHaveCount(0);
    await expect(live(page, "Approve for design")).toHaveCount(0);
    await act(page, "Start draft");
    await expectAt(page, "Draft", `Officer: ${OFFICER_NAME}`);
    await fillDraft(page);
    await sendToProofread(page);
    // It is the copywriter's turn: the officer sees the copy actions, disabled, with the reason in words.
    await expect(live(page, "Approve copy")).toHaveCount(0);
    await expect(live(page, "Return with edits")).toHaveCount(0);
    // The officer wrote the post, so the server's first answer is the maker/checker one, before the role one ("Only a copywriter can do this.").
    await expect(offRow(page, "Approve copy")).toContainText(MAKER_CHECKER);
    await expect(activity(page)).toContainText("Draft to Proofread");
  });

  test("2 Copywriter, LOOP A: suggests an edit and returns the copy with a note", async ({ page, context }) => {
    await signIn(page, context, COPYWRITER);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "Proofread", `Copywriter: ${COPYWRITER_NAME}`);
    await expect(live(page, "Approve copy")).toBeVisible();
    await expect(live(page, "Return with edits")).toBeVisible();
    // The suggestion, on the caption row.
    const caption = page.getByRole("group", { name: "Caption", exact: true });
    await press(caption.getByRole("button", { name: "Suggest an edit to Caption", exact: true }));
    await caption.getByRole("textbox", { name: "Caption", exact: true }).fill(CAPTION_SUGGESTED);
    await press(caption.getByRole("button", { name: "Save suggestion", exact: true }));
    await expect(caption.locator(".scp-suggest")).toContainText(`Suggested by ${COPYWRITER_NAME}`);
    // Return the copy with a note.
    await act(page, "Return with edits");
    await noteDialog(page, "Return with edits", "What should change?", "The caption reads long. See my suggestion, and soften the call to action.");
    await expectAt(page, "Changes asked by the copywriter: copy", `Officer: ${OFFICER_NAME}`);
    await expect(banner(page)).toContainText("The caption reads long");
    // It left the copywriter's turn.
    await expect(live(page, "Approve copy")).toHaveCount(0);
  });

  test("3 Officer, LOOP A: accepts the suggestion, fixes the copy and sends it back to proofread", async ({ page, context }) => {
    await signIn(page, context, OFFICER);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "Changes asked by the copywriter: copy", `Officer: ${OFFICER_NAME}`);
    await expect(banner(page)).toContainText("The caption reads long");
    const caption = page.getByRole("group", { name: "Caption", exact: true });
    await expect(caption.locator(".scp-suggest")).toContainText(CAPTION_SUGGESTED);
    await press(caption.getByRole("button", { name: "Accept the suggestion for Caption", exact: true }));
    await expect(caption.locator(".scp-suggest")).toHaveCount(0); // applied, no longer waiting
    await expect(caption.locator(".scp-row__value")).toContainText(CAPTION_SUGGESTED);
    await expect(page.getByRole("list", { name: "Copy edit log" })).toContainText(`suggested by ${COPYWRITER_NAME}`);
    await editField(page, "Call to action", (r) => r.getByRole("textbox", { name: "Call to action", exact: true }).fill("Visit us this week"));
    // After a copywriter's change the way back is "Send to proofread", not "Send back for approval" (that is the HoD's and the final check's).
    await expect(live(page, "Send back for approval")).toHaveCount(0);
    await sendToProofread(page);
  });

  test("4 Copywriter: approves the copy, and the post goes to the HoD", async ({ page, context }) => {
    await signIn(page, context, COPYWRITER);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "Proofread", `Copywriter: ${COPYWRITER_NAME}`);
    await act(page, "Approve copy");
    await expectAt(page, "HoD approval", "Approvers");
    // Not the copywriter's turn any more.
    await expect(live(page, "Approve for design")).toHaveCount(0);
    await expect(offRow(page, "Approve for design")).toContainText("Only the Social Media head, the GM, the owner or the superadmin can do this.");
  });

  test("5 HoD, LOOP B: asks for changes", async ({ page, context }) => {
    await signIn(page, context, HOD);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "HoD approval", "Approvers");
    await expect(live(page, "Approve for design")).toBeVisible();
    await expect(live(page, "Ask for changes")).toBeVisible();
    await expect(live(page, "Approve copy")).toHaveCount(0); // the copywriter's step, already done
    await act(page, "Ask for changes");
    await noteDialog(page, "Ask for changes", "What should the officer change?", "Add the opening hours to the call to action.");
    await expectAt(page, "Changes asked by the HoD: copy", `Officer: ${OFFICER_NAME}`);
  });

  test("6 Officer, LOOP B: the fix goes straight back to the HoD with no second proofread", async ({ page, context }) => {
    await signIn(page, context, OFFICER);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "Changes asked by the HoD: copy", `Officer: ${OFFICER_NAME}`);
    await expect(banner(page)).toContainText("Add the opening hours");
    const toProofread = activity(page).locator("li").filter({ hasText: "to Proofread" });
    const before = await toProofread.count();
    expect(before).toBeGreaterThan(0); // the first pass and the loop-a return left theirs
    await editField(page, "Call to action", (r) => r.getByRole("textbox", { name: "Call to action", exact: true }).fill("Visit us daily, 9 to 5"));
    // The way back is "Send back for approval" (resend); "Send to proofread" is not offered for a HoD change.
    await expect(live(page, "Send to proofread")).toHaveCount(0);
    await act(page, "Send back for approval");
    await expectAt(page, "HoD approval", "Approvers");
    await expect(chip(page)).not.toHaveText("Proofread");
    // No second proofread: the activity has no new move into Proofread, and its last line is the straight move back to the HoD.
    await expect(toProofread).toHaveCount(before);
    await expect(activity(page).locator("li").last()).toContainText("Changes asked to HoD approval");
    // And it is the HoD's turn, not the officer's.
    await expect(live(page, "Approve for design")).toHaveCount(0);
    await expect(offRow(page, "Approve for design")).toContainText(MAKER_CHECKER); // the author may not pass their own post at the HoD step either
  });

  test("7 HoD: approves for design, and the post goes to the Creative", async ({ page, context }) => {
    await signIn(page, context, HOD);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "HoD approval", "Approvers");
    await act(page, "Approve for design");
    await expectAt(page, "Creative", `Designer: ${DESIGNER_NAME}`);
    await expect(live(page, "Approve for design")).toHaveCount(0);
  });

  test("8 Creative: starts the design, adds a design link and submits it for the final check", async ({ page, context }) => {
    await signIn(page, context, CREATIVE);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "Creative", `Designer: ${DESIGNER_NAME}`);
    await expect(live(page, "Start design")).toBeVisible();
    await expect(live(page, "Send to the client")).toHaveCount(0); // the final check is not the designer's
    await act(page, "Start design");
    await expect(page.getByText("In progress", { exact: false }).first()).toBeVisible();
    const designs = page.getByRole("region", { name: "Designs" });
    // F1 (fixed): the Asset Library picker lists the demo's invented assets. This step still adds a LINK, so the final check has a link-only design to refuse.
    await press(designs.getByRole("radio", { name: "From the Asset Library" }));
    await expect(designs.getByRole("combobox").locator("option", { hasText: ASSET_NAME })).toHaveCount(1);
    await tick(designs.getByRole("radio", { name: "A link" }));
    await designs.getByRole("textbox", { name: "Link" }).fill(LINK_ONE);
    await press(designs.getByRole("button", { name: "Add design", exact: true }));
    await expect(designs.getByRole("link", { name: LINK_ONE })).toBeVisible();
    await expect(designs).toContainText("A link only: it cannot go to the client");
    await act(page, "Submit for the final check");
    await expectAt(page, "Final check", "Approvers");
    await expect(live(page, "Submit for the final check")).toHaveCount(0);
  });

  test("9 GM: at the final check a link-only design cannot be sent, and the button says why (F1, F3)", async ({ page, context }) => {
    await signIn(page, context, GM);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "Final check", "Approvers");
    // The server's read disables the send with `design_not_stored`; the demo's now does the same (it was live and refused only on click).
    await expect(live(page, "Send to the client")).toHaveCount(0);
    await expect(offRow(page, "Send to the client")).toContainText("A design that is only a link has nothing to show the client.");
    await expect(live(page, "Ask for changes")).toBeVisible();
    await expect(chip(page)).toHaveText("Final check");
  });

  test("10 HoD, LOOP C1: a design change goes back to the Creative, who resubmits, and it returns to the final check", async ({ page, context }) => {
    await signIn(page, context, HOD);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "Final check", "Approvers");
    await act(page, "Ask for changes");
    await noteDialog(page, "Ask for changes", "What was asked?", "The design must be a stored asset, and the logo larger.", "The design");
    await expectAt(page, "Changes asked by the final check: design", `Designer: ${DESIGNER_NAME}`);
    await expect(page.getByText("Revision asked")).toBeVisible();
  });

  test("11 Creative, LOOP C1: resubmits the design", async ({ page, context }) => {
    await signIn(page, context, CREATIVE);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "Changes asked by the final check: design", `Designer: ${DESIGNER_NAME}`);
    await expect(banner(page)).toContainText("The design must be a stored asset");
    const designs = page.getByRole("region", { name: "Designs" });
    await press(designs.getByRole("button", { name: "Remove design 1", exact: true }));
    await expect(designs.getByRole("link", { name: LINK_ONE })).toBeHidden();
    // The change asks for a stored asset: the Asset Library picker now has one to offer.
    await tick(designs.getByRole("radio", { name: "From the Asset Library" }));
    await designs.getByRole("combobox").selectOption({ value: ASSET_GROUP });
    await press(designs.getByRole("button", { name: "Add design", exact: true }));
    await expect(designs).toContainText(`${ASSET_NAME} · version 2`);
    await act(page, "Submit for the final check");
    await expectAt(page, "Final check", "Approvers");
  });

  test("12 GM, LOOP C2: a copy change goes back to the Officer", async ({ page, context }) => {
    await signIn(page, context, GM);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "Final check", "Approvers");
    await act(page, "Ask for changes");
    await noteDialog(page, "Ask for changes", "What was asked?", "The caption names no place; add it.", "The copy");
    await expectAt(page, "Changes asked by the final check: copy", `Officer: ${OFFICER_NAME}`);
  });

  test("13 Officer, LOOP C2: fixes the copy and it returns to the final check, not to proofread", async ({ page, context }) => {
    await signIn(page, context, OFFICER);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "Changes asked by the final check: copy", `Officer: ${OFFICER_NAME}`);
    const toProofread = activity(page).locator("li").filter({ hasText: "to Proofread" });
    const before = await toProofread.count();
    await editField(page, "Caption", (r) => r.getByRole("textbox", { name: "Caption", exact: true }).fill(`${CAPTION_SUGGESTED} Find us at the harbour.`));
    await expect(live(page, "Send to proofread")).toHaveCount(0);
    await act(page, "Send back for approval");
    await expectAt(page, "Final check", "Approvers");
    await expect(toProofread).toHaveCount(before);
    await expect(activity(page).locator("li").last()).toContainText("Changes asked to Final check");
  });

  test("14 GM: sends the walk's own post to the client (its design is an Asset Library asset, so it is stored)", async ({ page, context }) => {
    await signIn(page, context, GM);
    await open(page, POST_URL, TITLE);
    await expectAt(page, "Final check", "Approvers");
    await expect(live(page, "Send to the client")).toBeVisible();
    await act(page, "Send to the client");
    await expectAt(page, "With the client", "Client");
    await expect(seen(page, ".scp-post__chips")).toContainText("With client");
    await expect(live(page, "Send to the client")).toHaveCount(0);
    // the send stored the design as a file the client can see
    await expect(page.getByRole("region", { name: "Designs" })).toContainText("Stored for the client");
  });

  test("15 Maker/checker: the author of a post cannot pass it at proofread, refused in plain words", async ({ page, context }) => {
    // The superadmin may author (the house wildcard), and as the author may not approve the copy: the one person for whom both are true.
    await signIn(page, context, SUPERADMIN);
    MC_URL = await createPost(page, TITLE_MC);
    await open(page, MC_URL, TITLE_MC);
    await act(page, "Start draft");
    await expectAt(page, "Draft", `Officer: ${OFFICER_NAME}`);
    await fillDraft(page);
    await sendToProofread(page);
    // The superadmin's wildcard would allow it, the maker/checker DENY beats the wildcard.
    await expect(live(page, "Approve copy")).toHaveCount(0);
    await expect(live(page, "Return with edits")).toHaveCount(0);
    await expect(offRow(page, "Approve copy")).toContainText(MAKER_CHECKER);
    await expect(offRow(page, "Return with edits")).toContainText("You wrote or look after this post, so you cannot pass it at this step.");
    await expect(chip(page)).toHaveText("Proofread");
  });

  test("16 Maker/checker: the copywriter, a different person, can pass the same post", async ({ page, context }) => {
    await signIn(page, context, COPYWRITER);
    await open(page, MC_URL, TITLE_MC);
    await expectAt(page, "Proofread", `Copywriter: ${COPYWRITER_NAME}`);
    await expect(live(page, "Approve copy")).toBeVisible();
    await act(page, "Approve copy");
    await expectAt(page, "HoD approval", "Approvers");
  });
});
