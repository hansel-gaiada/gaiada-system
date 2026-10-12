import "server-only";
// TEMP DEMO MODE (PV4-09) — stateful in-memory store for the STAFF conversation (BFF §29b) and the meeting minutes
// (§29c), so the hub's Conversation section, the thread page, the agent-draft card and the minutes editor can be
// driven in a browser with no backend (the Playwright hub specs run against this). Wired first in
// demoFixtures.getDemoResponse; session-only; resets on restart. Safe to delete once the real backend is on.
//
// It models the rules the UI depends on, not a re-implementation of the controller: author side and author are
// server-derived, a closed thread refuses posts (409), a draft is staff-only (`clientVisible:false`) and Send
// authors the message as the CALLER with `draftedBy` = the agent, minutes freeze when shared (PUT -> 409), and
// sharing needs a client. State is pinned on globalThis because the page, the layout and the server actions can land
// in different module instances under `next dev` (same reason as demoBilling.ts).

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const err = (status: number, error: string): DemoResult => ({ status, json: { error } });

interface Msg {
  id: string; threadId: string; authorId: string; authorName: string; authorSide: "client" | "staff";
  body: string | null; retracted: boolean; edited: boolean; editedAt: string | null; createdAt: string;
  draftedBy: string | null; attachments: { id: string; filename: string; contentType: string; byteSize: number }[];
}
interface Thread {
  id: string; clientId: string; clientName: string; projectId: string | null; projectName: string | null;
  subject: string | null; status: "open" | "closed"; createdSide: "client" | "staff"; createdAt: string;
}
interface Draft {
  id: string; threadId: string; body: string; draftedBy: string; draftedByName: string; status: "pending" | "sent" | "discarded";
  decidedBy: string | null; decidedAt: string | null; sentMessageId: string | null; createdAt: string;
}
interface Minutes { id: string; bodyMd: string; status: "draft" | "shared"; sharedAt: string | null; sharedBy: string | null; sharedByName: string | null; createdAt: string; updatedAt: string }

const G = globalThis as unknown as { __demoConv?: { threads: Thread[]; messages: Msg[]; drafts: Draft[]; minutes: Record<string, Minutes>; seq: number } };

const minsAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const STAFF = { id: "demo-hansel", name: "Clement Hansel" };
const WINDOW_MS = 15 * 60_000;

function store() {
  if (G.__demoConv) return G.__demoConv;
  const threads: Thread[] = [
    { id: "cv-thread-1", clientId: "cl-1", clientName: "Northwind Traders", projectId: "p-web-1", projectName: "Client site redesign", subject: "Homepage hero copy", status: "open", createdSide: "client", createdAt: minsAgo(60 * 30) },
    { id: "cv-thread-2", clientId: "cl-1", clientName: "Northwind Traders", projectId: null, projectName: null, subject: null, status: "open", createdSide: "staff", createdAt: minsAgo(60 * 24 * 6) },
  ];
  const messages: Msg[] = [
    { id: "cv-msg-1", threadId: "cv-thread-1", authorId: "demo-client", authorName: "Dana Whitfield", authorSide: "client", body: "Hi, can we swap the hero image for the one from last week's shoot? The new one is at https://example.com/hero-v2 and we would also like the headline shortened.", retracted: false, edited: false, editedAt: null, createdAt: minsAgo(60 * 30), draftedBy: null, attachments: [] },
    { id: "cv-msg-2", threadId: "cv-thread-1", authorId: STAFF.id, authorName: STAFF.name, authorSide: "staff", body: "Thanks Dana. We will take a look and come back to you.", retracted: false, edited: false, editedAt: null, createdAt: minsAgo(60 * 29), draftedBy: null, attachments: [] },
    { id: "cv-msg-3", threadId: "cv-thread-1", authorId: "demo-client", authorName: "Dana Whitfield", authorSide: "client", body: "Any update on the hero image? We would like to publish on Friday.", retracted: false, edited: false, editedAt: null, createdAt: minsAgo(90), draftedBy: null, attachments: [{ id: "cv-file-1", filename: "hero-v2-brief.pdf", contentType: "application/pdf", byteSize: 48_213 }] },
    { id: "cv-msg-4", threadId: "cv-thread-2", authorId: STAFF.id, authorName: STAFF.name, authorSide: "staff", body: "Welcome to the portal. Use this thread for anything that is not tied to one project.", retracted: false, edited: false, editedAt: null, createdAt: minsAgo(60 * 24 * 6), draftedBy: null, attachments: [] },
  ];
  const drafts: Draft[] = [
    { id: "cv-draft-1", threadId: "cv-thread-1", body: "Hi Dana, the new hero image is in and the headline is shortened. A preview is ready for your review, and we can publish on Friday as planned.", draftedBy: "agent-atlas", draftedByName: "Atlas", status: "pending", decidedBy: null, decidedAt: null, sentMessageId: null, createdAt: minsAgo(20) },
  ];
  G.__demoConv = { threads, messages, drafts, minutes: {}, seq: 100 };
  return G.__demoConv;
}
const nid = (p: string) => `${p}-${++store().seq}`;

function lastAt(t: Thread): string {
  const ms = store().messages.filter((m) => m.threadId === t.id);
  return ms.length ? ms[ms.length - 1].createdAt : t.createdAt;
}
function awaiting(t: Thread): boolean {
  if (t.status !== "open") return false;
  const live = store().messages.filter((m) => m.threadId === t.id && !m.retracted);
  return live.length > 0 && live[live.length - 1].authorSide === "client";
}
function threadRow(t: Thread) {
  const s = store();
  return {
    ...t, general: t.projectId === null, lastMessageAt: lastAt(t), updatedAt: lastAt(t), createdBy: STAFF.id,
    unreadCount: awaiting(t) ? s.messages.filter((m) => m.threadId === t.id && m.authorSide === "client" && !m.retracted).length : 0,
    awaitingReply: awaiting(t), pendingDrafts: s.drafts.filter((d) => d.threadId === t.id && d.status === "pending").length,
    clientVisible: true,
  };
}
function msgRow(m: Msg, userId: string) {
  const mine = m.authorSide === "staff" && m.authorId === userId;
  const age = Date.now() - Date.parse(m.createdAt);
  return {
    ...m, mine, clientVisible: true,
    editableUntil: mine && !m.retracted && age < WINDOW_MS ? new Date(Date.parse(m.createdAt) + WINDOW_MS).toISOString() : null,
    body: m.retracted ? null : m.body, attachments: m.retracted ? [] : m.attachments,
  };
}
const draftRow = (d: Draft) => ({ ...d, clientVisible: false });

/** Hub Overview: how many threads of this client wait on us, and the `needsUs` items for them. */
export function demoConversationNeedsUs(clientId: string): { count: number; items: { kind: "conversation"; id: string; label: string; context: string; href: string; since: string | null; clientVisible: boolean }[] } {
  const s = store();
  const items = s.threads.filter((t) => t.clientId === clientId && awaiting(t)).map((t) => {
    const lastClient = [...s.messages].reverse().find((m) => m.threadId === t.id && m.authorSide === "client" && !m.retracted);
    return {
      kind: "conversation" as const, id: t.id, label: "A client message is waiting for our reply",
      context: t.subject ?? t.projectName ?? "General conversation",
      href: `/clients/${clientId}/work/conversation/${t.id}`, since: lastClient?.createdAt ?? null, clientVisible: true,
    };
  });
  return { count: items.length, items };
}

// Recordings the minutes routes know: id -> client. Anything else has no client.
const RECORDING_CLIENT: Record<string, string | null> = { "rec-demo-1": "cl-1", "rec-demo-2": "cl-2", "rec-demo-3": "cl-1" };
function minutesView(recId: string) {
  const clientId = RECORDING_CLIENT[recId] ?? null;
  const mm = store().minutes[recId] ?? null;
  return {
    meetingId: recId, clientId, projectId: null, title: "Meeting",
    shareable: !!mm && mm.status === "draft" && clientId !== null && mm.bodyMd.trim() !== "",
    minutes: mm && {
      id: mm.id, bodyMd: mm.bodyMd, status: mm.status, draftedBy: null, updatedBy: STAFF.id, createdAt: mm.createdAt, updatedAt: mm.updatedAt,
      sharedAt: mm.sharedAt, sharedBy: mm.sharedBy, sharedByName: mm.sharedByName,
      // The backend's rule: the meeting has a client AND the minutes are shared.
      clientVisible: clientId !== null && mm.status === "shared",
    },
  };
}

export function conversationDemo(method: string, p: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const m = method.toUpperCase();
  const s = store();
  let hit: RegExpMatchArray | null;
  const json = () => JSON.parse(body || "{}") as Record<string, unknown>;

  // ── minutes ────────────────────────────────────────────────────────────────────────────────────
  if ((hit = p.match(/^\/api\/[^/]+\/meetings\/([^/]+)\/minutes$/))) {
    const rec = hit[1];
    if (rec === "recordings") return null;
    if (m === "GET") return ok(minutesView(rec));
    if (m === "PUT") {
      const cur = s.minutes[rec];
      if (cur?.status === "shared") return err(409, "these minutes are already shared with the client and can no longer be edited");
      const text = String(json().bodyMd ?? "");
      const t = new Date().toISOString();
      s.minutes[rec] = { id: cur?.id ?? nid("cv-min"), bodyMd: text, status: "draft", sharedAt: null, sharedBy: null, sharedByName: null, createdAt: cur?.createdAt ?? t, updatedAt: t };
      return ok(minutesView(rec));
    }
  }
  if ((hit = p.match(/^\/api\/[^/]+\/meetings\/([^/]+)\/minutes\/share$/)) && m === "POST") {
    const rec = hit[1];
    const cur = s.minutes[rec];
    if (!(rec in RECORDING_CLIENT) || RECORDING_CLIENT[rec] === null) return err(409, "this meeting has no client, so its minutes cannot be shared");
    if (!cur || !cur.bodyMd.trim()) return err(409, "there are no minutes to share");
    if (cur.status === "shared") return err(409, "these minutes are already shared");
    cur.status = "shared"; cur.sharedAt = new Date().toISOString(); cur.sharedBy = userId; cur.sharedByName = STAFF.name;
    return ok({ id: cur.id, meetingId: rec, status: "shared", sharedAt: cur.sharedAt, sharedBy: userId, notified: 1 });
  }

  // ── threads ────────────────────────────────────────────────────────────────────────────────────
  if (!/^\/api\/[^/]+\/conversation(\/|$)/.test(p)) return null;

  if (p.match(/^\/api\/[^/]+\/conversation$/)) {
    if (m === "GET") {
      const cid = params.get("clientId"), pid = params.get("projectId"), st = params.get("status"), aw = params.get("awaitingReply");
      const rows = s.threads
        .filter((t) => (!cid || t.clientId === cid) && (!pid || t.projectId === pid) && (!st || t.status === st) && (aw === null || awaiting(t) === (aw === "true")))
        .map(threadRow);
      return ok({ threads: rows });
    }
    if (m === "POST") {
      const b = json();
      const clientId = String(b.clientId ?? "");
      if (clientId !== "cl-1") return err(400, "clientId must be a client of this company");
      const text = String(b.body ?? "");
      if (!text.trim() || text.length > 10_000) return err(400, "body must be 1..10000 characters");
      const projectId = b.projectId ? String(b.projectId) : null;
      let t = projectId ? null : s.threads.find((x) => x.clientId === clientId && x.projectId === null) ?? null;
      const created = !t;
      if (!t) {
        t = { id: nid("cv-thread"), clientId, clientName: "Northwind Traders", projectId, projectName: projectId ? "Client site redesign" : null, subject: b.subject ? String(b.subject) : null, status: "open", createdSide: "staff", createdAt: new Date().toISOString() };
        s.threads.push(t);
      }
      const msg: Msg = { id: nid("cv-msg"), threadId: t.id, authorId: userId, authorName: STAFF.name, authorSide: "staff", body: text, retracted: false, edited: false, editedAt: null, createdAt: new Date().toISOString(), draftedBy: null, attachments: [] };
      s.messages.push(msg);
      return ok({ threadId: t.id, messageId: msg.id, created, attachmentIds: [] }, 201);
    }
  }

  if ((hit = p.match(/^\/api\/[^/]+\/conversation\/messages\/([^/]+)$/))) {
    const msg = s.messages.find((x) => x.id === hit![1]);
    if (!msg) return err(404, "message not found");
    if (msg.authorSide !== "staff" || msg.authorId !== userId) return err(403, "you can only change your own messages");
    if (msg.retracted || Date.now() - Date.parse(msg.createdAt) >= WINDOW_MS) return err(409, "the 15 minute edit window has passed");
    if (m === "PATCH") { msg.body = String(json().body ?? ""); msg.edited = true; msg.editedAt = new Date().toISOString(); return ok({ id: msg.id, edited: true, editedAt: msg.editedAt }); }
    if (m === "DELETE") { msg.retracted = true; return ok({ id: msg.id, retracted: true, retractedAt: new Date().toISOString() }); }
  }

  if ((hit = p.match(/^\/api\/[^/]+\/conversation\/drafts\/([^/]+)(?:\/(send|discard))?$/))) {
    const d = s.drafts.find((x) => x.id === hit![1]);
    if (!d) return err(404, "draft not found");
    if (m === "PATCH" && !hit[2]) {
      if (d.status !== "pending") return err(409, "this draft was already decided");
      d.body = String(json().body ?? ""); return ok({ id: d.id, status: "pending", clientVisible: false });
    }
    if (m === "POST" && hit[2] === "discard") {
      if (d.status !== "pending") return err(409, "this draft was already decided");
      d.status = "discarded"; d.decidedBy = userId; d.decidedAt = new Date().toISOString(); return ok({ id: d.id, status: "discarded", clientVisible: false });
    }
    if (m === "POST" && hit[2] === "send") {
      if (d.status !== "pending") return err(409, "this draft was already decided");
      const t = s.threads.find((x) => x.id === d.threadId)!;
      if (t.status === "closed") return err(409, "this conversation is closed");
      const msg: Msg = { id: nid("cv-msg"), threadId: t.id, authorId: userId, authorName: STAFF.name, authorSide: "staff", body: d.body, retracted: false, edited: false, editedAt: null, createdAt: new Date().toISOString(), draftedBy: d.draftedBy, attachments: [] };
      s.messages.push(msg);
      d.status = "sent"; d.sentMessageId = msg.id; d.decidedBy = userId; d.decidedAt = msg.createdAt;
      return ok({ id: msg.id, threadId: t.id, draftId: d.id, draftedBy: d.draftedBy, createdAt: msg.createdAt, clientVisible: true }, 201);
    }
  }

  if ((hit = p.match(/^\/api\/[^/]+\/conversation\/([^/]+)\/drafts$/)) && m === "GET") {
    const all = params.get("status") === "all";
    return ok({ drafts: s.drafts.filter((d) => d.threadId === hit![1] && (all || d.status === "pending")).map(draftRow) });
  }

  if ((hit = p.match(/^\/api\/[^/]+\/conversation\/([^/]+)\/messages$/)) && m === "POST") {
    const t = s.threads.find((x) => x.id === hit![1]);
    if (!t) return err(404, "thread not found");
    if (t.status === "closed") return err(409, "this conversation is closed");
    const text = String(json().body ?? "");
    if (!text.trim() || text.length > 10_000) return err(400, "body must be 1..10000 characters");
    const msg: Msg = { id: nid("cv-msg"), threadId: t.id, authorId: userId, authorName: STAFF.name, authorSide: "staff", body: text, retracted: false, edited: false, editedAt: null, createdAt: new Date().toISOString(), draftedBy: null, attachments: [] };
    s.messages.push(msg);
    return ok({ id: msg.id, threadId: t.id, createdAt: msg.createdAt, attachmentIds: [], clientVisible: true }, 201);
  }

  if ((hit = p.match(/^\/api\/[^/]+\/conversation\/([^/]+)$/))) {
    const t = s.threads.find((x) => x.id === hit![1]);
    if (!t) return err(404, "thread not found");
    if (m === "GET") return ok({ thread: threadRow(t), messages: s.messages.filter((x) => x.threadId === t.id).map((x) => msgRow(x, userId)) });
    if (m === "PATCH") {
      const st = json().status;
      if (st === "open" || st === "closed") t.status = st;
      return ok({ id: t.id, status: t.status, subject: t.subject, updatedAt: new Date().toISOString() });
    }
  }
  return null;
}
