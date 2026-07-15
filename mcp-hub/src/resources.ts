// MCP Resources (WS2 §6): readable context entities exposed for attach-as-context. Like the
// tools, resources are THIN fronts over the platform API — they forward the caller's OBO
// envelope and the platform applies Cerbos + RLS. The hub adds no DB access and no authz logic.
//
// URI scheme: gaiada://<tenantId>/<kind>[/<id>]
//   gaiada://<t>/projects            gaiada://<t>/project/<projectId>
//   gaiada://<t>/clients             gaiada://<t>/client/<clientId>
//   gaiada://<t>/task/<taskId>       gaiada://<t>/activity
//
// Only IDENTIFIED callers (assurance >= low) may read resources; anonymous principals see none.
import { config } from "./config";
import type { Principal } from "./principal";

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

/** Advertised parameterized resources (concrete instances resolve on read). */
export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  { uriTemplate: "gaiada://{tenantId}/projects", name: "Projects", description: "All projects in a company you belong to.", mimeType: "application/json" },
  { uriTemplate: "gaiada://{tenantId}/project/{projectId}", name: "Project", description: "One project's detail.", mimeType: "application/json" },
  { uriTemplate: "gaiada://{tenantId}/clients", name: "Clients", description: "All clients in a company.", mimeType: "application/json" },
  { uriTemplate: "gaiada://{tenantId}/client/{clientId}", name: "Client", description: "One client's detail.", mimeType: "application/json" },
  { uriTemplate: "gaiada://{tenantId}/task/{taskId}", name: "Task", description: "One task's detail.", mimeType: "application/json" },
  { uriTemplate: "gaiada://{tenantId}/activity", name: "Activity feed", description: "Recent activity for a company.", mimeType: "application/json" },
];

/** May this principal see/read resources at all? (Per-instance authz is the platform's job.) */
export function canReadResources(principal: Principal): boolean {
  return principal.assurance !== "anonymous";
}

/** Map a gaiada:// URI to the platform API path. Throws on an unknown/malformed URI. */
export function resolveResourcePath(uri: string): string {
  const prefix = "gaiada://";
  if (!uri.startsWith(prefix)) throw new Error(`unsupported resource URI: ${uri}`);
  const segments = uri.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  const [tenantId, kind, id] = segments;
  if (!tenantId || !kind) throw new Error(`malformed resource URI: ${uri}`);
  switch (`${kind}${id ? "/:id" : ""}`) {
    case "projects":
      return `/api/${tenantId}/projects`;
    case "project/:id":
      return `/api/${tenantId}/projects/${id}`;
    case "clients":
      return `/api/${tenantId}/clients`;
    case "client/:id":
      return `/api/${tenantId}/clients/${id}`;
    case "task/:id":
      return `/api/${tenantId}/tasks/${id}`;
    case "activity":
      return `/api/${tenantId}/activity`;
    default:
      throw new Error(`unknown resource kind: ${kind}`);
  }
}

/** Read a resource by fronting the platform with the caller's OBO envelope. Returns JSON text. */
export async function readResource(uri: string, principal: Principal): Promise<string> {
  const path = resolveResourcePath(uri);
  const res = await fetch(`${config.platformUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${config.platformToken}`,
      "x-obo-provider": principal.provider,
      "x-obo-external-id": principal.externalId,
    },
  });
  if (res.status === 401 || res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "platform denied the request");
  }
  if (!res.ok) throw new Error(`platform ${path} ${res.status}`);
  return JSON.stringify(await res.json());
}
