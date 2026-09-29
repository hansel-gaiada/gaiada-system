"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "./session-server";
import { getMe, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";
import {
  createClient, updateClient, deleteClient, createDeliverable, createTimeEntry, createClientNote, deleteClientNote,
  CLIENT_CONTACT_KEYS,
} from "./entities";

export interface CWState { error?: string }

async function ctx(): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant, me };
}

function pending(e: unknown): CWState {
  if (e instanceof PlatformError) {
    if (e.status === 404 || e.status === 405) return { error: "Not available yet — the backend endpoint is pending." };
    return { error: e.message };
  }
  throw e;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reads the contact inputs the client forms render (`CLIENT_CONTACT_KEYS`), checks the two email
 *  fields, and returns every key — blank ones as `null`, which the backend's key-level merge reads as
 *  "delete this key". Keys the form does not render are never sent, so they are never touched. */
function readContact(formData: FormData): { contact: Record<string, string | null> } | { error: string } {
  const contact: Record<string, string | null> = {};
  for (const k of CLIENT_CONTACT_KEYS) {
    const v = String(formData.get(k) ?? "").trim();
    if (v && (k === "email" || k === "billingEmail") && !EMAIL_RE.test(v)) {
      return { error: k === "email" ? "That email address doesn't look right." : "That billing email doesn't look right." };
    }
    contact[k] = v || null;
  }
  return { contact };
}

// CC-D10: gated on `client.write` (member+), not `pm.manage` (manager+) — resource_client.yaml lets
// ordinary staff create and edit clients, and the UI used to hide both from them.
export async function createClientAction(_prev: CWState | null, formData: FormData): Promise<CWState> {
  const c = await ctx();
  if ("error" in c) return { error: c.error };
  if (!can(c.me, "client.write", c.tenant)) return { error: "You don't have permission to add clients." };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Client name is required." };
  const read = readContact(formData);
  if ("error" in read) return { error: read.error };
  const contact = Object.fromEntries(Object.entries(read.contact).filter(([, v]) => v !== null)) as Record<string, string>;
  const ownerUserId = String(formData.get("ownerUserId") ?? "") || null;
  let id: string;
  try {
    id = (await createClient(c.userId, c.tenant, { name, status: String(formData.get("status") ?? "active"), contact, ownerUserId })).id;
  } catch (e) { return pending(e); }
  revalidatePath("/clients");
  redirect(`/clients/${id}`);
}

/** Staff edit of the CRM client row: name, status, owner and contact details. This is the rename flow
 *  CC-D5 refers to — the Client Centre profile keeps the name read-only and points here. The backend
 *  merges `contact` key by key (CC-D10), so this sends only the keys the form owns. */
export async function updateClientAction(clientId: string, _prev: CWState | null, formData: FormData): Promise<CWState> {
  const c = await ctx();
  if ("error" in c) return { error: c.error };
  if (!can(c.me, "client.write", c.tenant)) return { error: "You don't have permission to edit clients." };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Client name is required." };
  const status = String(formData.get("status") ?? "").trim();
  const read = readContact(formData);
  if ("error" in read) return { error: read.error };
  const ownerUserId = String(formData.get("ownerUserId") ?? "") || null;
  try {
    await updateClient(c.userId, c.tenant, clientId, { name, ...(status ? { status } : {}), contact: read.contact, ownerUserId });
  } catch (e) { return pending(e); }
  revalidatePath("/clients");
  revalidatePath(`/clients/${clientId}`, "layout");
  redirect(`/clients/${clientId}`);
}

/** Archive / restore — the everyday alternative to Delete. Only the status moves; the client, its
 *  work, invoices and profile all stay, and Restore puts it back exactly as it was. */
export async function setClientArchivedForm(clientId: string, archived: boolean): Promise<void> {
  const c = await ctx();
  if ("error" in c || !can(c.me, "client.write", c.tenant)) return;
  await updateClient(c.userId, c.tenant, clientId, { status: archived ? "archived" : "active" });
  revalidatePath("/clients");
  revalidatePath(`/clients/${clientId}`, "layout");
}

export async function deleteClientAction(clientId: string): Promise<CWState> {
  const c = await ctx();
  if ("error" in c) return { error: c.error };
  if (!can(c.me, "client.delete", c.tenant)) return { error: "You don't have permission." };
  try { await deleteClient(c.userId, c.tenant, clientId); } catch (e) { return pending(e); }
  revalidatePath("/clients");
  redirect("/clients");
}

// Form-friendly void wrapper (form actions must return void).
export async function deleteClientForm(clientId: string): Promise<void> {
  await deleteClientAction(clientId);
}

// ── CC-D10 · notes ──────────────────────────────────────────────────────────────────────────────
export async function addClientNoteAction(clientId: string, _prev: CWState | null, formData: FormData): Promise<CWState> {
  const c = await ctx();
  if ("error" in c) return { error: c.error };
  if (!can(c.me, "client.write", c.tenant)) return { error: "You don't have permission to add notes." };
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return { error: "Write something first." };
  if (body.length > 5000) return { error: "Notes are limited to 5,000 characters." };
  try { await createClientNote(c.userId, c.tenant, clientId, body); } catch (e) { return pending(e); }
  revalidatePath(`/clients/${clientId}/notes`);
  return {};
}

/** Your own note needs `client.write`; somebody else's needs `client.delete`. The backend enforces the
 *  same line, so this is only the early answer. */
export async function deleteClientNoteForm(clientId: string, noteId: string): Promise<void> {
  const c = await ctx();
  if ("error" in c) return;
  await deleteClientNote(c.userId, c.tenant, clientId, noteId);
  revalidatePath(`/clients/${clientId}/notes`);
}

export async function createDeliverableAction(_prev: CWState | null, formData: FormData): Promise<CWState> {
  const c = await ctx();
  if ("error" in c) return { error: c.error };
  if (!can(c.me, "pm.manage", c.tenant)) return { error: "You don't have permission to add deliverables." };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Deliverable name is required." };
  try {
    await createDeliverable(c.userId, c.tenant, {
      name,
      projectId: String(formData.get("projectId") ?? "") || undefined,
      clientId: String(formData.get("clientId") ?? "") || undefined,
      dueDate: String(formData.get("dueDate") ?? "") || undefined,
    });
  } catch (e) { return pending(e); }
  revalidatePath("/deliverables");
  redirect("/deliverables");
}

export async function logTimeEntryAction(_prev: CWState | null, formData: FormData): Promise<CWState> {
  const c = await ctx();
  if ("error" in c) return { error: c.error };
  const minutes = Math.round(Number(formData.get("hours") ?? 0) * 60);
  if (!minutes || minutes <= 0) return { error: "Enter time in hours (e.g. 1.5)." };
  const projectId = String(formData.get("projectId") ?? "").trim();
  if (!projectId) return { error: "Pick a project — time is logged against a project." };
  try {
    await createTimeEntry(c.userId, c.tenant, {
      minutes,
      projectId,
      billable: formData.get("billable") === "on",
      entryDate: String(formData.get("entryDate") ?? "") || new Date().toISOString().slice(0, 10),
      notes: String(formData.get("notes") ?? ""),
    });
  } catch (e) { return pending(e); }
  revalidatePath("/timesheets");
  redirect("/timesheets");
}
