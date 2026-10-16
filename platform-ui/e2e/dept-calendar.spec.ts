import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { loginAsPlacedSeo, loginAsPlacedWebDev } from "./personas";
import { tenantCookie } from "./appCookies";

// DW-10c-3 (BFF section 59, DW-D33): the department calendar, end to end, under DEMO_MODE. A department's people read its holidays, its
// colleagues' approved leave (with the leave type, never the reason), its milestones and its events.
//
// Same setup as dept-notices.spec.ts: every test signs in fresh and plants the `workspaces` pilot cookie itself, so there is NO stored session.
// Facts it relies on (src/lib/demoDeptCalendar.ts, src/lib/demoCalendarEvents.ts, src/lib/demoNotices.ts):
//   - webdev@gaiada.com is u-dev (Made Putra), a plain member placed in Web Dev (dept-1): reads Web Dev's calendar.
//   - seo-specialist@gaiada.com is u-seo, placed in SEO (dept-3): reads SEO's calendar and is refused Web Dev's (403).
//   - The demo holds, on fixed days of the CURRENT month: the holiday "Nyepi (Day of Silence)" (9th), Andre Wijaya on vacation (13th to 15th),
//     Sari Dewi sick (20th), the milestone "Staging sign-off" of "Client site redesign" (21st), Web Dev's department event "Web Dev sprint review"
//     (11th, 14:00 Singapore) and the company event "Gaia all-hands" (22nd, 10:00); and in the NEXT month the holiday "Galungan" (14th) and the
//     event "Web Dev retro" (9th, 16:00). Leave that is pending or belongs to another unit, a done milestone and another unit's department
//     event are in the store too and must never show.
//   - The grid and the agenda hold the same items, so every locator is scoped to one of them.

async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function press(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.click();
}

/** The pilot switch, written the way lib/prefs.ts reads it. Next URL-encodes cookie values, so the value is encoded here. */
function pilotCookie(at: string) {
  return { name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify({ shell: "workspaces" })), url: new URL("/", at).toString() };
}
async function plant(page: Page, context: BrowserContext) {
  await context.addCookies([tenantCookie(page.url()), pilotCookie(page.url())]);
}
const signInEmployee = async (page: Page, context: BrowserContext) => { await loginAsPlacedWebDev(page); await plant(page, context); };
const signInSeo = async (page: Page, context: BrowserContext) => { await loginAsPlacedSeo(page); await plant(page, context); };

// Next streams a hidden copy of each resolved chunk at the end of <body> before React moves it into place, so every locator is scoped to the page body.
const main = (page: Page) => page.locator("#main-content");

// The page's month is the display zone's (Asia/Singapore by default), so the test names its months in that zone.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const sgToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const shift = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
};
const title = (ym: string) => `${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;

const grid = (page: Page) => main(page).getByRole("table");
const agenda = (page: Page, ym: string) => main(page).getByRole("list", { name: `${title(ym)} agenda, by day`, exact: true });
const agendaDay = (page: Page, ym: string, day: number) => agenda(page, ym).locator(`li#cal-dept-day-${ym}-${String(day).padStart(2, "0")}`);

test.describe("Department calendar (DW-10c-3)", () => {
  test("a placed Web Dev employee opens Department calendar from the Overview row and reads the month: holiday, away colleagues with their types, milestone and events", async ({ page, context }) => {
    await signInEmployee(page, context);
    const ym = sgToday().slice(0, 7);

    // The tab: Department calendar follows Notices on the Overview row.
    await page.goto("/departments/dept-1");
    const strip = page.getByRole("navigation", { name: "Overview sections" });
    await expect(strip.getByRole("link")).toHaveText(["Overview", "Notices", "Department calendar"]);
    await press(strip.getByRole("link", { name: "Department calendar" }));
    await expect(page).toHaveURL(/\/departments\/dept-1\/schedule$/);
    await expect(strip.getByRole("link", { name: "Department calendar" })).toHaveAttribute("aria-current", "page");

    await expect(main(page).getByRole("heading", { level: 3, name: "Web Dev calendar", exact: true })).toBeVisible();
    await expect(main(page).getByRole("heading", { level: 4, name: title(ym), exact: true })).toBeVisible();

    // The grid is a table: Monday first, six weeks.
    await expect(grid(page).getByRole("columnheader")).toHaveText(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    await expect(grid(page).getByRole("row")).toHaveCount(7);

    // The holiday, the two away colleagues with their types (Andre for three days), the milestone and the events.
    await expect(grid(page).getByText("Nyepi (Day of Silence)", { exact: true })).toBeVisible();
    await expect(grid(page).getByText("Andre Wijaya · vacation", { exact: true })).toHaveCount(3);
    await expect(grid(page).getByText("Sari Dewi · sick", { exact: true })).toHaveCount(1);
    await expect(grid(page).getByRole("link", { name: "Client site redesign · Staging sign-off", exact: true })).toHaveAttribute("href", "/projects/p-web-1");
    await expect(grid(page).getByRole("link", { name: "14:00 · Web Dev sprint review", exact: true })).toHaveAttribute("href", /^\/calendar\/events\/[0-9a-f-]+\?company=co-agency$/);
    await expect(grid(page).getByRole("link", { name: "10:00 · Gaia all-hands", exact: true })).toBeVisible();

    // DW-D33: the leave type and nothing more. The reasons, the pending leave and another unit's people are not here.
    for (const never of ["Family trip", "Dentist", "Wedding", "Retreat", "Dewi Santoso · vacation", "Luh Ayu", "SEO ranking review", "Design approved", "Audit delivered"]) {
      await expect(main(page).getByText(never)).toHaveCount(0);
    }

    // The agenda lists the same items day by day, with the kind in words.
    await expect(agendaDay(page, ym, 9)).toContainText("HolidayNyepi (Day of Silence)");
    await expect(agendaDay(page, ym, 13)).toContainText("AwayAndre Wijaya · vacation");
    await expect(agendaDay(page, ym, 20)).toContainText("AwaySari Dewi · sick");
    await expect(agendaDay(page, ym, 21)).toContainText("MilestoneClient site redesign · Staging sign-off");
    await expect(agendaDay(page, ym, 11)).toContainText("Event14:00 · Web Dev sprint reviewWeb Dev");
    await expect(agendaDay(page, ym, 22)).toContainText("Event10:00 · Gaia all-handsWhole company");

    // The legend explains the chips, and nothing says a leg failed to load.
    await expect(main(page).getByRole("list", { name: "Legend", exact: true }).getByRole("listitem")).toHaveCount(4);
    await expect(main(page).getByRole("list", { name: "What could not be loaded", exact: true })).toHaveCount(0);
  });

  test("an event opens from the calendar, and 'Add an event' opens the schedule form with Web Dev already chosen", async ({ page, context }) => {
    await signInEmployee(page, context);
    await page.goto("/departments/dept-1/schedule");

    // The department event, from the agenda: its page says who can see it.
    const ym = sgToday().slice(0, 7);
    await press(agendaDay(page, ym, 11).getByRole("link", { name: "14:00 · Web Dev sprint review", exact: true }));
    await expect(page).toHaveURL(/\/calendar\/events\/[0-9a-f-]+\?company=co-agency$/);
    await expect(main(page).getByText("Visible to Web Dev", { exact: true })).toBeVisible();

    // "Add an event" opens the schedule form with the department chosen.
    await page.goto("/departments/dept-1/schedule");
    const add = main(page).getByRole("link", { name: "Add an event", exact: true });
    await expect(add).toHaveAttribute("href", "/calendar/new?visibility=department&unit=dept-1");
    await press(add);
    await expect(page).toHaveURL(/\/calendar\/new\?visibility=department&unit=dept-1$/);
    const visibility = main(page).getByLabel("Who can see it");
    await expect(visibility).toHaveValue("department:dept-1");
    await expect(visibility.locator("option:checked")).toHaveText("My department: Web Dev");
  });

  test("the next month navigates: it holds its own holiday and event, and none of this month's", async ({ page, context }) => {
    await signInEmployee(page, context);
    const ym = sgToday().slice(0, 7);
    const next = shift(ym, 1);
    await page.goto("/departments/dept-1/schedule");

    const nav = main(page).getByRole("navigation", { name: "Month", exact: true });
    await press(nav.getByRole("link", { name: `Next month, ${title(next)}`, exact: true }));
    await expect(page).toHaveURL(new RegExp(`/departments/dept-1/schedule\\?month=${next}$`));
    await expect(main(page).getByRole("heading", { level: 4, name: title(next), exact: true })).toBeVisible();
    await expect(grid(page).getByText("Galungan", { exact: true })).toBeVisible();
    await expect(grid(page).getByRole("link", { name: "16:00 · Web Dev retro", exact: true })).toBeVisible();
    await expect(agendaDay(page, next, 14)).toContainText("HolidayGalungan");
    // Nothing of this month's items is in next month's six weeks.
    for (const gone of ["Nyepi (Day of Silence)", "Andre Wijaya · vacation", "Sari Dewi · sick", "Client site redesign · Staging sign-off"]) {
      await expect(grid(page).getByText(gone, { exact: true })).toHaveCount(0);
    }

    // Back to this month: the bare address.
    await press(nav.getByRole("link", { name: "This month", exact: true }));
    await expect(page).toHaveURL(/\/departments\/dept-1\/schedule$/);
    await expect(main(page).getByRole("heading", { level: 4, name: title(ym), exact: true })).toBeVisible();
    await expect(grid(page).getByText("Nyepi (Day of Silence)", { exact: true })).toBeVisible();
  });

  test("a person from another department gets the no-access state on Web Dev's calendar, and reads their own", async ({ page, context }) => {
    await signInSeo(page, context);
    await page.goto("/departments/dept-1/schedule");
    await expect(main(page).getByText("You don't have access to this department's calendar.")).toBeVisible();
    await expect(main(page).getByRole("table")).toHaveCount(0);
    await expect(main(page).getByRole("link", { name: "Add an event", exact: true })).toHaveCount(0);
    // A refusal is never "nothing is scheduled".
    await expect(main(page).getByText(/Nothing is scheduled/)).toHaveCount(0);

    // Their own department's calendar reads, and shows their own colleagues' leave, not Web Dev's.
    await page.goto("/departments/dept-3/schedule");
    await expect(main(page).getByRole("heading", { level: 3, name: "SEO calendar", exact: true })).toBeVisible();
    await expect(grid(page).getByText("Luh Ayu · vacation", { exact: true })).toHaveCount(2);
    await expect(grid(page).getByText("Andre Wijaya · vacation", { exact: true })).toHaveCount(0);
    await expect(grid(page).getByRole("link", { name: /Web Dev sprint review/ })).toHaveCount(0);
  });
});
