// M5-W1d — every Nest route of the app, read from the controllers' own decorator metadata (test helper).
//
// The source of truth is `AppModule`'s `controllers` list (the one place every controller is registered) and, per handler,
// the metadata Nest itself routes by: `PATH_METADATA` / `METHOD_METADATA` on the class and the handler, and
// `GUARDS_METADATA` for the guards. Nothing is parsed from source text, so a route cannot be missed by a regex, and a
// controller that is not in `AppModule` is not a route at all.
//
// Used by `auth/contributor-route.test.ts` (the pinned marked set, no database) and `auth/contributor-fence.db.test.ts`
// (an HTTP sweep over every guarded route as a contributor).
import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { AppModule } from "../app.module";
import { AuthGuard } from "../auth/guards";
import { isContributorRoute } from "../auth/contributor-route";

export interface AppRoute {
  /** `GET`, `POST`, … */
  method: string;
  /** The full path, Nest-style, e.g. `/api/:tenantId/me`. */
  path: string;
  controller: string;
  handlerName: string;
  /** AuthGuard is among the guards that run for this route (class or handler level). */
  authGuarded: boolean;
  /** The guards that run BEFORE AuthGuard (class guards first, then handler guards, as Nest runs them). */
  guardsBeforeAuth: string[];
  /** The handler carries `@ContributorRoute()`. */
  contributorRoute: boolean;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined ? [""] : [String(v)]);

function join(...parts: string[]): string {
  const p = parts.map((s) => s.replace(/^\/+|\/+$/g, "")).filter((s) => s.length > 0).join("/");
  return `/${p}`;
}

const guardName = (g: unknown): string =>
  typeof g === "function" ? (g as { name?: string }).name || "anonymous" : typeof g;

export function appControllers(): Array<new (...args: never[]) => unknown> {
  const list = Reflect.getMetadata("controllers", AppModule) as Array<new (...args: never[]) => unknown> | undefined;
  if (!list || list.length === 0) throw new Error("route-inventory: AppModule declares no controllers (metadata key changed?)");
  return list;
}

/** Every route of every controller registered in AppModule. Sorted, stable. */
export function appRoutes(): AppRoute[] {
  const out: AppRoute[] = [];
  for (const cls of appControllers()) {
    const prefixes = asList(Reflect.getMetadata(PATH_METADATA, cls));
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, cls) as unknown[] | undefined) ?? [];
    // Walk the prototype chain (a controller could inherit handlers), nearest definition wins.
    const seen = new Set<string>();
    for (let proto = cls.prototype as object | null; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor" || seen.has(name)) continue;
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        const handler = desc?.value;
        if (typeof handler !== "function") continue;
        const methodMeta = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        const pathMeta = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        if (methodMeta === undefined || pathMeta === undefined) continue;
        seen.add(name);
        const handlerGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];
        const all = [...classGuards, ...handlerGuards];
        const authIdx = all.indexOf(AuthGuard);
        for (const prefix of prefixes) {
          for (const p of asList(pathMeta)) {
            out.push({
              method: RequestMethod[methodMeta],
              path: join(prefix, p),
              controller: cls.name,
              handlerName: name,
              authGuarded: authIdx >= 0,
              guardsBeforeAuth: authIdx >= 0 ? all.slice(0, authIdx).map(guardName) : [],
              contributorRoute: isContributorRoute(handler),
            });
          }
        }
      }
    }
  }
  return out.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
}

/** `METHOD /path`, the key both tests pin. */
export const routeKey = (r: Pick<AppRoute, "method" | "path">): string => `${r.method} ${r.path}`;

/** Fill every `:param` with `value(name)` so the URL reaches the router (and its uuid shape check) as a real request. */
export function concretePath(path: string, value: (param: string) => string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => encodeURIComponent(value(name)));
}
