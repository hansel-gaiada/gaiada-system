import Link from "next/link";
import type { TeamGroup } from "@/lib/departments";

// The department's people, as a roster rather than a grid of boxes. Each division was a bordered
// card holding one name — 480px of frame around one word — and an EMPTY division got a card the
// same size as a staffed one, so "no one placed yet" occupied as much of the page as the team.
//
// Drawn on the same left axis as the activity feed: the group label sits in a fixed column and its
// people hang off it. Two cards on Home, one structural idiom, no new vocabulary.
//
// Every row carries load (`openCount`, `blockedCount` — see `computeTeamRoster`), because a name
// alone said less than the org chart this card duplicates, and the numbers were already fetched on
// the page for the KPI strip. Dept-agnostic, props only.
export interface TeamRosterProps {
  groups: TeamGroup[];
  /** Link target per person. Omit and names render as plain text. */
  personHref?: (personId: string) => string;
}

export function TeamRoster({ groups, personHref }: TeamRosterProps) {
  return (
    <div className="dept-team">
      {groups.map((g) => (
        <section key={g.id} className="dept-team__group">
          <h4 className="dept-team__axis">
            <span className="type-eyebrow">{g.label}</span>
          </h4>
          {g.people.length === 0 ? (
            /* One quiet line, not a card. An unstaffed division is a fact worth stating once. */
            <p className="dept-team__empty">No one placed yet</p>
          ) : (
            <ul className="dept-team__list">
              {g.people.map((p) => {
                const body = (
                  <>
                    <span className="dept-team__name">{p.name}</span>
                    <span className="dept-team__load">
                      {p.openCount === 0 ? (
                        /* "Nothing open" is a real state and it is not the same as an absent
                           number — a blank here would read as "we failed to count". */
                        <span className="dept-team__clear">nothing open</span>
                      ) : (
                        <>
                          <span className="dept-team__open">{p.openCount} open</span>
                          {/* Blocked is a SUBSET of open, so it is set as a qualifier of that
                              number rather than a second count beside it. role=img + label so a
                              screen reader gets "1 blocked", not the bare digit next to a square. */}
                          {p.blockedCount > 0 && (
                            <span className="dept-team__blocked" role="img" aria-label={`${p.blockedCount} blocked`}>
                              <span className="dept-team__blocked-mark" aria-hidden="true" />
                              {p.blockedCount}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                  </>
                );
                return (
                  <li key={p.id} className="dept-team__item">
                    {personHref ? (
                      <Link href={personHref(p.id)} className="dept-team__row dept-team__row--link">{body}</Link>
                    ) : (
                      <span className="dept-team__row">{body}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
