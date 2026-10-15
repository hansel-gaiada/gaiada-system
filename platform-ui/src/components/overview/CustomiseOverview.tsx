import type { OverviewBand } from "@/lib/workspaces";
import type { OverviewBandView } from "@/lib/overview";
import { widgetIsOn, type WorkspaceOverviewPrefs } from "@/lib/overviewPrefs";

// DW-10d (DW-D34): the Customise disclosure at the end of the Overview's header row. Closed by default. Inside, each band's blocks the
// person could see, with the state they are in and one button to change it:
//   - a default block: "Shown" with "Hide", or "Hidden" with "Show";
//   - an optional block: "Switched on" with "Switch off", or "Switched off" with "Switch on".
// A fixed block (Needs you, a head's condition banner) is not a choice, so it is not listed: the intro says it always stays. Listing it
// would also name a block the person may never see (a visitor's or a staff member's "Department condition" draws nothing), and the
// closed panel's text is still in the page.
// It is a `<details>` and plain form posts to a server action, so it works without JavaScript and by keyboard. The action
// (`setOverviewWidgetAction`) re-checks everything on the server and the page redraws. The list is only what the person's gates
// allow, so nothing they may not see is offered, and the order is the Overview's own: a choice here never moves a block.
//
// Cosmetic, like every control on this page: the server decides what the person may read.

export type SetOverviewWidget = (workspaceKey: string, widgetKey: string, on: boolean) => Promise<void>;

export function CustomiseOverview({ bands, prefs, workspaceKey, bandLabel, action }: {
  /** `selectCustomisable`: every block the person's gates and the workspace allow, hidden or not. */
  bands: readonly OverviewBandView[];
  /** The person's entry for this workspace. */
  prefs: WorkspaceOverviewPrefs;
  /** The key the choice is stored under (`overviewPrefsKey`). */
  workspaceKey: string;
  bandLabel: (band: OverviewBand) => string;
  /** `setOverviewWidgetAction`, bound per button here. */
  action: SetOverviewWidget;
}) {
  // Only the blocks the person may choose; a band left with none is not drawn. Nothing to choose: no control at all.
  const choosable = bands
    .map(({ band, widgets }) => ({ band, widgets: widgets.filter((w) => w.placement !== "fixed") }))
    .filter((b) => b.widgets.length > 0);
  if (choosable.length === 0) return null;
  return (
    <details className="ov-custom">
      <summary className="lux-btn lux-btn--ghost lux-btn--sm ov-custom__summary">Customise</summary>
      <div className="ov-custom__panel" role="group" aria-label="Customise this Overview">
        <p className="ov-custom__intro">
          Hide the blocks you do not want and switch on the optional ones. Needs you always stays. The order stays the same. Your choice
          is kept in this browser.
        </p>
        {choosable.map(({ band, widgets }) => (
          <div key={band} className="ov-custom__band" data-band={band}>
            <p className="ov-custom__band-label">{bandLabel(band)}</p>
            <ul className="ov-custom__list">
              {widgets.map((w) => {
                const placement = w.placement ?? "default";
                const on = widgetIsOn(w, prefs);
                const optional = placement === "optional";
                const verb = optional ? (on ? "Switch off" : "Switch on") : on ? "Hide" : "Show";
                return (
                  <li key={w.key} className="ov-custom__item" data-widget={w.key} data-placement={placement} data-on={on}>
                    <span className="ov-custom__name">{w.label}</span>
                    <span className="ov-custom__state">{optional ? (on ? "Switched on" : "Switched off") : on ? "Shown" : "Hidden"}</span>
                    <form action={action.bind(null, workspaceKey, w.key, !on)}>
                      <button type="submit" className="ov-custom__btn" aria-label={`${verb} ${w.label}`}>{verb}</button>
                    </form>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}
