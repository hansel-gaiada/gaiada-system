import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-5e (BFF §63.26.3): "Use from Saved" on the post page. The reads and the writes are the demo store's (the twin DEMO_MODE serves): the two action modules are replaced by ones that call `socialDemo`, the
// server's order of checks run from the fixture, so what the picker posts is judged by the same rules the server applies and the page shows what comes back. The store seeds from the day it is first touched, so
// the clock is pinned to mid-month before it is imported (hence vi.hoisted). Only Date is faked. The stores are shared, so a test that changes one uses a post of its own.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

const nav = vi.hoisted(() => ({ refresh: vi.fn(), back: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
const persona = vi.hoisted(() => ({ user: "u-social" }));
vi.mock("@/lib/collabActions", () => ({ postEntityComment: vi.fn(async () => ({ ok: true, id: "c-new" })) }));
const call = async (method: string, tail: string, body?: unknown, query = "") => {
  const { socialDemo } = await import("@/lib/demoSocial");
  return socialDemo(method, `/api/co-agency/modules/social/${tail}`, new URLSearchParams(query), body === undefined ? undefined : JSON.stringify(body), persona.user)!;
};
vi.mock("@/lib/socialPipelineActions", async () => {
  const { asPipelinePost, refusalFromBody, refusalText } = await import("@/lib/socialPipeline");
  const wrap = (r: { status: number; json: unknown }) => {
    const j = r.json as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r.status < 300) {
      return { ok: true as const, post: j.post ? asPipelinePost(j.post) : null, applied: j.applied ?? null, warnings: j.warnings ?? [], alreadyApplied: j.alreadyApplied === true, designId: j.designId ?? null };
    }
    const refusal = refusalFromBody(r.status, String(j.error), j, j.field);
    return { ok: false as const, refusal, message: refusalText(refusal) };
  };
  return {
    savePostFields: vi.fn(async (postId: string, expectedStatus: string, fields: unknown, extra: { savedItemIds?: string[]; actionId?: string } = {}) =>
      wrap(await call("PATCH", `posts/${postId}/pipeline`, { expectedStatus, fields, ...extra }))),
    runPostAction: vi.fn(), saveSuggestion: vi.fn(), dropSuggestion: vi.fn(), addPostDesign: vi.fn(), removePostDesign: vi.fn(),
  };
});
vi.mock("@/lib/socialSavedActions", async () => {
  const { asCollections, asSavedPage } = await import("@/lib/socialSaved");
  return {
    loadSavedPicker: vi.fn(async (engagementId: string) => {
      const root = `engagements/${engagementId}/saved`;
      const { collections } = asCollections((await call("GET", root)).json);
      const pages = [];
      for (const c of collections.filter((x) => x.key !== "posts")) pages.push(asSavedPage((await call("GET", root, undefined, `collection=${c.key}&limit=100`)).json, c.key));
      return { collections, pages };
    }),
  };
});

import { PIPE_POSTS, demoPipelineRead } from "@/lib/demoSocialPipeline";
import { asPipelinePost, canAuthorPost } from "@/lib/socialPipeline";
import { asSavedPage } from "@/lib/socialSaved";
import { savePostFields } from "@/lib/socialPipelineActions";
import { loadSavedPicker } from "@/lib/socialSavedActions";
import { PostFields } from "./PostFields";
import { UseFromSaved } from "./PostUseSaved";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const postOf = (title: string) => PIPE_POSTS.find((p) => p.title === title)!;
const onResult = vi.fn();

function mount(title: string, user: string) {
  persona.user = user;
  const p = postOf(title);
  const post = asPipelinePost(demoPipelineRead(p.id, user).json);
  const r = render(<UseFromSaved post={post} author={canAuthorPost(post)} onResult={onResult} />);
  return { p, post, ...r };
}
const button = () => screen.getByRole("button", { name: "Use from Saved" });
const openPicker = async () => {
  button().focus(); // a click focuses a button in most browsers; jsdom's fireEvent does not
  fireEvent.click(button());
  await screen.findByRole("dialog", { name: "Use from Saved" });
  await screen.findByRole("searchbox", { name: "Search the content bank" }, { timeout: 10000 });
  return within(screen.getByRole("dialog"));
};
const box = (d: ReturnType<typeof within>, name: RegExp | string) => d.getByRole("checkbox", { name });
const used = async (collection: string): Promise<Record<string, number>> =>
  Object.fromEntries((asSavedPage((await call("GET", "engagements/soc-eng-1/saved", undefined, `collection=${collection}`)).json, collection).entries.items as Array<{ title: string; useCount: number }>).map((i) => [i.title, i.useCount]));

beforeEach(() => { vi.clearAllMocks(); persona.user = "u-social"; });

describe("where the action is offered", () => {
  it("is drawn for the client's officer on a draft and on a planned post, and not for anyone else or at a step that takes neither the copy nor the images", () => {
    mount("Gift guide for the host", "u-social");
    expect(button()).toBeInTheDocument();
  });
  it("planned: offered (the images may change)", () => {
    mount("November kickoff", "u-social");
    expect(button()).toBeInTheDocument();
  });
  it("proofread: hidden, whoever looks", () => {
    mount("Wool care in three steps", "u-social");
    expect(screen.queryByRole("button", { name: "Use from Saved" })).toBeNull();
  });
  it("a seat that cannot edit the post does not see it", () => {
    mount("Gift guide for the host", "u-copy");
    expect(screen.queryByRole("button", { name: "Use from Saved" })).toBeNull();
  });
  it("sits above the tabs of the post's fields, and nowhere on a locked post", () => {
    persona.user = "u-social";
    const draft = asPipelinePost(demoPipelineRead(postOf("Gift guide for the host").id, "u-social").json);
    const a = render(<PostFields post={draft} onResult={onResult} />);
    expect(screen.getByRole("button", { name: "Use from Saved" })).toBeInTheDocument();
    a.unmount();
    const proof = asPipelinePost(demoPipelineRead(postOf("Wool care in three steps").id, "u-social").json);
    render(<PostFields post={proof} onResult={onResult} />);
    expect(screen.queryByRole("button", { name: "Use from Saved" })).toBeNull();
  });
});

describe("the picker", () => {
  it("is a labelled dialog over the client's bank, grouped by the company's categories, each item a labelled checkbox with its preview and use count", async () => {
    mount("Gift guide for the host", "u-social");
    const d = await openPicker();
    expect(vi.mocked(loadSavedPicker)).toHaveBeenCalledWith("soc-eng-1");
    for (const g of ["Photos and videos", "Captions", "Hashtag sets", "Templates", "References"]) expect(d.getByRole("group", { name: g }), g).toBeInTheDocument();
    expect(d.queryByRole("group", { name: "Approved posts" })).toBeNull();
    const caption = box(d, /^Harvest week opener/);
    expect(caption).toBeEnabled();
    const row = caption.closest("label")!;
    expect(row).toHaveTextContent("The harvest is in. Fresh, local and on the shelf from Friday.");
    expect(row).toHaveTextContent("Used once");
    expect(row).toHaveTextContent("Goes into the caption.");
    expect(box(d, /^Weekend reminder/).closest("label")).toHaveTextContent("Not used yet");
    expect(box(d, /^Product launch caption/).closest("label")).toHaveTextContent("Used 2 times");
    // a link says where it goes and what it is; a hashtag set says it is the brand book's
    expect(box(d, /^Stock: wooden table/).closest("label")).toHaveTextContent("Photo link");
    expect(box(d, /^Stock: wooden table/).closest("label")).toHaveTextContent("Goes into the reference images.");
    expect(box(d, /^Drive: workshop walkthrough/).closest("label")).toHaveTextContent("Video link");
    const always = within(d.getByRole("group", { name: "Hashtag sets" })).getByRole("checkbox", { name: /^Always/ });
    expect(always.closest("label")).toHaveTextContent("#northwind #madewithcare");
    expect(always.closest("label")).toHaveTextContent("From the brand book");
    expect(d.getByText("0 of 10 chosen.")).toBeInTheDocument();
  });

  it("an Asset Library photo is shown, disabled, and says in words why", async () => {
    mount("Gift guide for the host", "u-social");
    const d = await openPicker();
    const photo = box(d, /^Autumn hero - final/);
    expect(photo).toBeDisabled();
    expect(photo.closest("label")).toHaveTextContent("Asset Library photo");
    expect(photo.closest("label")).toHaveTextContent("becomes a design through the designer");
    expect(photo.closest("label")!.querySelector("img")).not.toBeNull();
  });

  it("a planned post takes only the links: the texts and the hashtag sets are disabled and say the copy is locked", async () => {
    mount("November kickoff", "u-social");
    const d = await openPicker();
    expect(box(d, /^Weekend reminder/)).toBeDisabled();
    expect(box(d, /^Weekend reminder/).closest("label")).toHaveTextContent("The caption cannot change at this step.");
    const always = within(d.getByRole("group", { name: "Hashtag sets" })).getByRole("checkbox", { name: /^Always/ });
    expect(always).toBeDisabled();
    expect(always.closest("label")).toHaveTextContent("The hashtags cannot change at this step.");
    expect(box(d, /^Stock: wooden table/)).toBeEnabled();
  });

  it("searches the title, the text and the link, drops a group that is left empty, and says when nothing matches", async () => {
    mount("Gift guide for the host", "u-social");
    const d = await openPicker();
    const q = d.getByRole("searchbox", { name: "Search the content bank" });
    fireEvent.change(q, { target: { value: "WORKSHOP" } });
    expect(d.getAllByRole("checkbox").map((c) => c.closest("label")!.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Behind the scenes")]));
    expect(d.queryByRole("group", { name: "Captions" })).toBeNull();
    fireEvent.change(q, { target: { value: "example.com/stock" } });
    expect(d.getAllByRole("checkbox")).toHaveLength(1);
    expect(d.getByRole("group", { name: "Photos and videos" })).toBeInTheDocument();
    fireEvent.change(q, { target: { value: "zzz nothing" } });
    expect(d.queryAllByRole("checkbox")).toHaveLength(0);
    expect(d.getByText(/Nothing in the content bank matches/)).toBeInTheDocument();
    fireEvent.change(q, { target: { value: "" } });
    expect(d.getAllByRole("checkbox").length).toBeGreaterThan(5);
  });

  it("takes at most ten: at ten, every other item is disabled and says so; unticking one frees the rest", async () => {
    // the demo bank holds eight usable items; add four captions through the demo's own route so there are more than ten
    for (let i = 1; i <= 4; i++) await call("POST", "engagements/soc-eng-1/saved", { category: "captions", holds: "text", title: `Extra caption ${i}`, body: `Extra words ${i}` });
    mount("Gift guide for the host", "u-social");
    const d = await openPicker();
    const usable = d.getAllByRole("checkbox").filter((c) => !(c as HTMLInputElement).disabled);
    expect(usable.length).toBeGreaterThan(10);
    for (const c of usable.slice(0, 10)) fireEvent.click(c);
    expect(d.getByText("10 of 10 chosen. That is the most one edit takes.")).toBeInTheDocument();
    const rest = usable.slice(10);
    for (const c of rest) {
      expect(c).toBeDisabled();
      expect(c.closest("label")).toHaveTextContent("10 are chosen already.");
    }
    fireEvent.click(usable[0]);
    expect(d.getByText("9 of 10 chosen.")).toBeInTheDocument();
    expect(rest[0]).toBeEnabled();
    fireEvent.click(rest[0]);
    expect(d.getByText("10 of 10 chosen. That is the most one edit takes.")).toBeInTheDocument();
  });

  it("needs a choice before it adds anything", async () => {
    mount("Gift guide for the host", "u-social");
    const d = await openPicker();
    expect(d.getByRole("button", { name: "Add to the post" })).toBeDisabled();
    fireEvent.click(box(d, /^Weekend reminder/));
    expect(d.getByRole("button", { name: "Add to the post" })).toBeEnabled();
  });
});

describe("confirming", () => {
  it("sends the edit with the copy and the item ids and a fresh actionId; the server counts each use; the dialog closes, the page is told, and focus returns to the button", async () => {
    const before = { ...(await used("captions")), ...(await used("templates")) };
    const { p } = mount("Gift guide for the host", "u-social");
    const d = await openPicker();
    fireEvent.click(box(d, /^Weekend reminder/));
    fireEvent.click(box(d, /^Behind the scenes/));
    expect(d.getByText("2 of 10 chosen.")).toBeInTheDocument();
    fireEvent.click(d.getByRole("button", { name: "Add to the post" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const [postId, expected, fields, extra] = vi.mocked(savePostFields).mock.calls[0];
    expect([postId, expected]).toEqual([p.id, "drafting"]);
    expect((fields as { caption: string }).caption).toMatch(/Open Saturday 9 to 5\. Come say hello\.\n\nA day in the workshop/);
    expect(extra!.savedItemIds).toHaveLength(2);
    expect(extra!.actionId).toMatch(UUID);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0]).toMatchObject({ ok: true });
    expect(onResult.mock.calls[0][1]).toBe("Used 2 saved items in the post");
    expect(postOf("Gift guide for the host").caption).toContain("Open Saturday 9 to 5");
    const after = { ...(await used("captions")), ...(await used("templates")) };
    expect(after["Weekend reminder"]).toBe(before["Weekend reminder"] + 1);
    expect(after["Behind the scenes"]).toBe(before["Behind the scenes"] + 1);
    expect(document.activeElement).toBe(button());
  });

  it("a hashtag set alone merges into the hashtags and is sent without savedItemIds (it has no stored item to count)", async () => {
    mount("Staff pick of the week", "u-social");
    const d = await openPicker();
    // that client's bank holds hashtag sets only; any set will do
    const sets = d.getByRole("group", { name: "Hashtag sets" });
    fireEvent.click(within(sets).getByRole("checkbox", { name: /^Dining/ }));
    fireEvent.click(d.getByRole("button", { name: "Add to the post" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [, , fields, extra] = vi.mocked(savePostFields).mock.calls[0];
    expect(Object.keys(fields as object)).toEqual(["hashtags"]);
    expect(extra!.savedItemIds).toBeUndefined();
    expect(extra!.actionId).toMatch(UUID);
  });

  it("a refusal is said in words beside the picker, the dialog stays open, nothing is applied or counted: an item deleted since the picker opened is 400 savedItemIds", async () => {
    mount("Gift guide for the host", "u-social");
    const d = await openPicker();
    fireEvent.click(box(d, /^Thank you to the team/));
    const gone = (asSavedPage((await call("GET", "engagements/soc-eng-1/saved", undefined, "collection=captions")).json, "captions").entries.items as Array<{ id: string; title: string }>).find((i) => i.title === "Thank you to the team")!;
    expect((await call("DELETE", `saved/${gone.id}`)).status).toBe(200);
    const caption = postOf("Gift guide for the host").caption;
    const counts = await used("captions");
    fireEvent.click(d.getByRole("button", { name: "Add to the post" }));
    const alert = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(alert).toHaveTextContent("One of the chosen items cannot be used here");
    expect(alert).toHaveTextContent("Nothing was changed or counted.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(postOf("Gift guide for the host").caption).toBe(caption);
    expect(await used("captions")).toEqual(counts);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("a post that moved past the step is refused by the machine in words, and the page is told to re-read it", async () => {
    const { p } = mount("Gift guide for the host", "u-social");
    const d = await openPicker();
    fireEvent.click(box(d, /^Harvest week opener/));
    const row = PIPE_POSTS.find((x) => x.id === p.id)!;
    const was = row.pipelineStatus;
    row.pipelineStatus = "proofread";
    try {
      const counts = await used("captions");
      fireEvent.click(d.getByRole("button", { name: "Add to the post" }));
      const alert = await within(screen.getByRole("dialog")).findByRole("alert");
      expect(alert).toHaveTextContent("Someone moved this post while you were looking at it.");
      expect(alert).toHaveTextContent("Nothing was changed or counted.");
      expect(await used("captions")).toEqual(counts);
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult.mock.calls[0][0]).toMatchObject({ ok: false, refusal: { error: "status_changed" } });
    } finally {
      row.pipelineStatus = was;
    }
  });

  it("says in words, before any request, what the post cannot take: a caption that would pass 5,000 characters", async () => {
    await call("POST", "engagements/soc-eng-1/saved", { category: "captions", holds: "text", title: "Huge caption", body: "w".repeat(4990) });
    await call("POST", "engagements/soc-eng-1/saved", { category: "captions", holds: "text", title: "Another huge caption", body: "v".repeat(100) });
    mount("Gift guide for the host", "u-social");
    const d = await openPicker();
    fireEvent.click(box(d, /^Huge caption/));
    fireEvent.click(box(d, /^Another huge caption/));
    fireEvent.click(d.getByRole("button", { name: "Add to the post" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/over 5,000 characters/);
    expect(vi.mocked(savePostFields)).not.toHaveBeenCalled();
  });
});

describe("closing", () => {
  it("Cancel closes the dialog and returns focus to the button, with nothing sent", async () => {
    mount("Gift guide for the host", "u-social");
    const d = await openPicker();
    fireEvent.click(d.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(button());
    expect(vi.mocked(savePostFields)).not.toHaveBeenCalled();
  });
  it("Escape closes it too", async () => {
    mount("Gift guide for the host", "u-social");
    await openPicker();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(button());
  });
  it("a bank that cannot be read says it cannot tell, never that it is empty", async () => {
    vi.mocked(loadSavedPicker).mockResolvedValueOnce(null);
    mount("Gift guide for the host", "u-social");
    fireEvent.click(button());
    expect(await screen.findByText(/could not be read, so nothing is shown/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing saved yet/i)).toBeNull();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Add to the post" })).toBeDisabled();
  });
});
