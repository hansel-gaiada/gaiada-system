// Action registry — parallel to the read-only skill registry. Keeps actions addressable
// by name for both the command router and the LLM intent router (Phase E).
import type { Action } from "./types";

const actions = new Map<string, Action<any>>();

export function registerAction<A>(a: Action<A>): void {
  actions.set(a.name.toLowerCase(), a as Action<any>);
}

export function getAction(name: string): Action<any> | undefined {
  return actions.get(name.toLowerCase());
}

export function listActions(): Action<any>[] {
  return [...actions.values()];
}

export function resetActions(): void {
  actions.clear();
}
