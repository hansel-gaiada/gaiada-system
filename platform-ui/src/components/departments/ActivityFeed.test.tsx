import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ActivityFeed, type ActivityItem } from "./ActivityFeed";

// A fixed instant, so every label below is asserted against a date the test controls rather than
// against whatever day the suite happens to run on. 14:00Z on 14 Aug is 22:00 in Asia/Makassar —
// still the 14th locally, which the "local day, not UTC day" case below leans on.
const NOW = "2026-08-14T14:00:00.000Z";

const item = (over: Partial<ActivityItem> & Pick<ActivityItem, "id" | "occurredAt">): ActivityItem => ({
  verb: "updated",
  objectLabel: "Pm task: Wire homepage hero",
  source: "pm",
  ...over,
});

describe("ActivityFeed", () => {
  it("renders the teach empty-state when there are no items", () => {
    render(<ActivityFeed items={[]} emptyCtaLabel="Connect a repository" emptyCtaHref="/departments/web-dev/connections" />);
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect a repository" })).toHaveAttribute("href", "/departments/web-dev/connections");
  });

  it("renders actor, verb, object, and names the source on every row", () => {
    render(
      <ActivityFeed
        nowIso={NOW}
        items={[
          item({ id: "1", actor: "Priya Shah", verb: "shipped", objectLabel: "Task: Fix login redirect", occurredAt: "2026-08-14T09:10:00Z", href: "/departments/web-dev/board" }),
          item({ id: "2", verb: "opened a PR for", objectLabel: "Repo: web-storefront", occurredAt: "2026-08-14T08:40:00Z", source: "github" }),
        ]}
      />
    );
    expect(screen.getByText("Priya Shah")).toBeInTheDocument();
    expect(screen.getByText(/Fix login redirect/)).toBeInTheDocument();
    expect(screen.getByText("PM")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
  });

  it("marks an actor-less row as machine-made", () => {
    const { container } = render(
      <ActivityFeed
        nowIso={NOW}
        items={[
          item({ id: "1", actor: "Made Putra", occurredAt: "2026-08-14T09:10:00Z" }),
          item({ id: "2", verb: "ran", objectLabel: "Tracker run", occurredAt: "2026-08-14T06:00:00Z", source: "system" }),
        ]}
      />
    );
    const rows = container.querySelectorAll(".dept-activity__item");
    expect(rows[0]).not.toHaveClass("dept-activity__item--machine");
    expect(rows[1]).toHaveClass("dept-activity__item--machine");
  });

  it("labels the source on every row, human or machine, and never twice", () => {
    const { container } = render(
      <ActivityFeed
        nowIso={NOW}
        items={[
          item({ id: "1", actor: "Made Putra", automated: false, occurredAt: "2026-08-14T09:10:00Z" }),
          item({ id: "2", automated: true, verb: "ran", objectLabel: "Tracker run", occurredAt: "2026-08-14T06:00:00Z", source: "system" }),
        ]}
      />
    );
    const rows = container.querySelectorAll(".dept-activity__item");
    // One per row, both rows: the human row's source is the only thing that says a PM event is not
    // a Drive one, and a node tooltip is not something a reader can scan.
    expect(container.querySelectorAll(".dept-activity__source")).toHaveLength(2);
    expect(rows[0].querySelector(".dept-activity__source")).toHaveTextContent("PM");
    expect(rows[1].querySelector(".dept-activity__source")).toHaveTextContent("System");
    // The node no longer repeats it — a screen reader would otherwise hear the source twice a row.
    expect(container.querySelectorAll(".dept-activity__node[aria-label]")).toHaveLength(0);
  });

  it("labels older days with their age, and shows clock times only for today and yesterday", () => {
    const { container } = render(
      <ActivityFeed
        nowIso={NOW}
        items={[
          item({ id: "1", actor: "A", occurredAt: "2026-08-14T09:10:00Z" }),
          item({ id: "2", actor: "B", occurredAt: "2026-08-13T09:10:00Z" }),
          item({ id: "3", actor: "C", occurredAt: "2026-07-22T09:10:00Z" }),
        ]}
      />
    );
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    // A dated day is set as two elements on the axis — the numeral in the display face, the month
    // in the eyebrow beneath it. Today and yesterday keep the word instead of a number.
    expect(container.querySelector(".dept-activity__date-num")).toHaveTextContent("22");
    expect(container.querySelector(".dept-activity__date-month")).toHaveTextContent("Jul");
    expect(screen.getByText("23d ago")).toBeInTheDocument();
    // Two recent rows carry a time; the three-week-old one does not — a clock on it situates
    // nothing, and the day marker is the whole answer.
    expect(container.querySelectorAll(".dept-activity__time")).toHaveLength(2);
  });

  it("groups and prints times in the working zone, not the server's UTC", () => {
    // 17:10 in Asia/Makassar. Rendered against a UTC runtime this used to read 09:10 and, for the
    // second row, land in the WRONG day group.
    render(
      <ActivityFeed
        nowIso={NOW}
        items={[
          item({ id: "1", actor: "A", occurredAt: "2026-08-14T09:10:00Z" }),
          // 23:30Z on the 13th is 07:30 on the 14th locally — it belongs to Today, not Yesterday.
          item({ id: "2", actor: "B", occurredAt: "2026-08-13T23:30:00Z" }),
        ]}
      />
    );
    expect(screen.getByText("17:10")).toBeInTheDocument();
    expect(screen.getByText("07:30")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.queryByText("Yesterday")).not.toBeInTheDocument();
  });

  it("drops the relative labels rather than guessing when the caller passes no instant", () => {
    const { container } = render(<ActivityFeed items={[item({ id: "1", actor: "A", occurredAt: "2026-08-14T09:10:00Z" })]} />);
    expect(container.querySelector(".dept-activity__date-num")).toHaveTextContent("14");
    expect(container.querySelector(".dept-activity__date-month")).toHaveTextContent("Aug");
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
    // No instant means no age either — "28d ago" would be the same guess in different words.
    expect(container.querySelector(".dept-activity__age")).toBeNull();
  });

  it("says the list is a preview when the caller had more rows", () => {
    const items = [item({ id: "1", actor: "A", occurredAt: "2026-08-14T09:10:00Z" })];
    const { rerender } = render(<ActivityFeed items={items} nowIso={NOW} />);
    expect(screen.queryByText(/shown/)).not.toBeInTheDocument();
    rerender(<ActivityFeed items={items} nowIso={NOW} truncated />);
    expect(screen.getByText("Last 1 shown.")).toBeInTheDocument();
  });
});
