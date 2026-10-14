// DW-6k (docs/FRONTEND-BFF-CONTRACT.md §36.3) — the Figma REST client against a fake `fetch`. No network, no database.
// The fixtures are trimmed from the shapes Figma documents (openapi.yaml of github.com/figma/rest-api-spec: GetFileResponse,
// GetFileNodesResponse, GetImagesResponse, GetCommentsResponse), keeping only documented fields.
import { describe, it, expect } from "vitest";
import { FigmaApiError, authHeaders, createFigmaClient, isSafeRenderUrl, type FetchLike, type FigmaCredential } from "./client";

const PAT: FigmaCredential = { token: "figd_pat_SECRET_VALUE_1", tokenType: "pat" };
const OAUTH: FigmaCredential = { token: "figu_oauth_SECRET_VALUE_2", tokenType: "oauth" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Seen { url: string; headers: Record<string, string>; redirect?: string }
function fakeFetch(reply: (url: string) => Response | Promise<Response>): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const f: FetchLike = async (input, init) => {
    seen.push({ url: input, headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect });
    return reply(input);
  };
  return { fetch: f, seen };
}

const FILE = {
  name: "Brand Kit", lastModified: "2026-10-10T08:30:00Z",
  document: { children: [{ id: "0:1", name: "Page 1" }, { id: "0:2", name: "Page 2" }] },
};

describe("authentication headers (the OpenAPI securitySchemes)", () => {
  it("a personal access token is X-Figma-Token and nothing else", () => {
    expect(authHeaders(PAT)).toEqual({ "X-Figma-Token": PAT.token });
  });
  it("an OAuth token is a Bearer credential and nothing else", () => {
    expect(authHeaders(OAUTH)).toEqual({ Authorization: `Bearer ${OAUTH.token}` });
  });
  it("the client sends them on the call", async () => {
    const { fetch, seen } = fakeFetch(() => json(FILE));
    const client = createFigmaClient(fetch);
    await client.getFile(PAT, "KEY1");
    await client.getFile(OAUTH, "KEY1");
    expect(seen[0].headers["X-Figma-Token"]).toBe(PAT.token);
    expect(seen[0].headers.Authorization).toBeUndefined();
    expect(seen[1].headers.Authorization).toBe(`Bearer ${OAUTH.token}`);
    expect(seen[1].headers["X-Figma-Token"]).toBeUndefined();
  });
});

describe("the four reads (§36.3)", () => {
  it("getFile: name, lastModified and the first page, from GET /v1/files/:key?depth=1", async () => {
    const { fetch, seen } = fakeFetch(() => json(FILE));
    const f = await createFigmaClient(fetch).getFile(PAT, "KEY1");
    expect(f).toEqual({ name: "Brand Kit", lastModified: "2026-10-10T08:30:00Z", firstPageId: "0:1" });
    expect(seen[0].url).toBe("https://api.figma.com/v1/files/KEY1?depth=1");
  });

  it("getFile: a file with no pages has no first page, and a body without the documented fields is unavailable", async () => {
    const empty = fakeFetch(() => json({ name: "x", lastModified: "2026-10-10T08:30:00Z", document: { children: [] } }));
    expect((await createFigmaClient(empty.fetch).getFile(PAT, "K")).firstPageId).toBeNull();
    const bad = fakeFetch(() => json({ hello: "world" }));
    await expect(createFigmaClient(bad.fetch).getFile(PAT, "K")).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("getNodeName: nodes[id].document.name; a null entry or a missing id is null", async () => {
    const body = { name: "Brand Kit", nodes: { "1:2": { document: { id: "1:2", name: "Hero banner" } }, "9:9": null } };
    const { fetch, seen } = fakeFetch(() => json(body));
    const c = createFigmaClient(fetch);
    expect(await c.getNodeName(PAT, "KEY1", "1:2")).toBe("Hero banner");
    expect(await c.getNodeName(PAT, "KEY1", "9:9")).toBeNull();
    expect(await c.getNodeName(PAT, "KEY1", "5:5")).toBeNull();
    expect(seen[0].url).toBe("https://api.figma.com/v1/files/KEY1/nodes?ids=1%3A2");
  });

  it("getComments: the comments array, from GET /v1/files/:key/comments", async () => {
    const comments = [
      { id: "1", created_at: "2026-10-01T09:00:00Z", resolved_at: null, client_meta: { node_id: "1:2", node_offset: { x: 1, y: 2 } } },
      { id: "2", created_at: "2026-10-01T09:05:00Z", resolved_at: "2026-10-02T10:00:00Z", client_meta: { x: 5, y: 6 } },
    ];
    const { fetch, seen } = fakeFetch(() => json({ comments }));
    expect(await createFigmaClient(fetch).getComments(PAT, "KEY1")).toEqual(comments);
    expect(seen[0].url).toBe("https://api.figma.com/v1/files/KEY1/comments");
    await expect(createFigmaClient(fakeFetch(() => json({ nope: 1 })).fetch).getComments(PAT, "K")).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("renderNode: the images map value for the node, with the format and the scale in the query", async () => {
    const { fetch, seen } = fakeFetch(() => json({ err: null, images: { "1:2": "https://figma-render.example.com/a.png" } }));
    const url = await createFigmaClient(fetch).renderNode(PAT, "KEY1", "1:2", { format: "png", scale: 2 });
    expect(url).toBe("https://figma-render.example.com/a.png");
    expect(seen[0].url).toBe("https://api.figma.com/v1/images/KEY1?ids=1%3A2&format=png&scale=2");
  });

  it("renderNode: a null in the images map (Figma could not render it) is render_failed, not an empty file", async () => {
    const nul = fakeFetch(() => json({ err: null, images: { "1:2": null } }));
    await expect(createFigmaClient(nul.fetch).renderNode(PAT, "K", "1:2", { format: "png", scale: 1 })).rejects.toMatchObject({ kind: "render_failed" });
    const err = fakeFetch(() => json({ err: "boom", images: {} }));
    await expect(createFigmaClient(err.fetch).renderNode(PAT, "K", "1:2", { format: "png", scale: 1 })).rejects.toMatchObject({ kind: "render_failed" });
    const absent = fakeFetch(() => json({ err: null, images: {} }));
    await expect(createFigmaClient(absent.fetch).renderNode(PAT, "K", "1:2", { format: "png", scale: 1 })).rejects.toMatchObject({ kind: "render_failed" });
  });
});

describe("failures are one error each, never retried", () => {
  it.each([[401, "refused"], [403, "refused"], [404, "not_found"], [400, "bad_request"], [500, "unavailable"], [503, "unavailable"]] as const)(
    "HTTP %s is %s",
    async (status, kind) => {
      const { fetch, seen } = fakeFetch(() => json({ status, err: "x" }, status));
      await expect(createFigmaClient(fetch).getFile(PAT, "K")).rejects.toMatchObject({ kind, status });
      expect(seen).toHaveLength(1); // one call: no retry loop
    },
  );

  it("429 is rate_limited, carries Figma's Retry-After, and is not retried", async () => {
    const { fetch, seen } = fakeFetch(() => json({ status: 429, err: "Rate limit exceeded" }, 429, { "retry-after": "120" }));
    await expect(createFigmaClient(fetch).getComments(PAT, "K")).rejects.toMatchObject({ kind: "rate_limited", status: 429, retryAfterSeconds: 120 });
    expect(seen).toHaveLength(1);
  });

  it("a network failure and a body that is not JSON are unavailable", async () => {
    const down: FetchLike = async () => { throw new TypeError("connect ECONNREFUSED"); };
    await expect(createFigmaClient(down).getFile(PAT, "K")).rejects.toMatchObject({ kind: "unavailable" });
    const html = fakeFetch(() => new Response("<html>", { status: 200 }));
    await expect(createFigmaClient(html.fetch).getFile(PAT, "K")).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("no error carries the token", async () => {
    for (const status of [401, 403, 404, 429, 500]) {
      const { fetch } = fakeFetch(() => json({ err: "x" }, status));
      for (const cred of [PAT, OAUTH]) {
        let e: unknown;
        try {
          await createFigmaClient(fetch).getFile(cred, "K");
        } catch (err) {
          e = err;
        }
        expect(e).toBeInstanceOf(FigmaApiError);
        const text = `${(e as Error).message} ${JSON.stringify(e)} ${(e as Error).stack ?? ""}`;
        expect(text).not.toContain(cred.token);
      }
    }
  });
});

describe("downloading a render", () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const URL_OK = "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc";

  it("returns the bytes and the content type, with no credential and redirects refused", async () => {
    const { fetch, seen } = fakeFetch(() => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }));
    const got = await createFigmaClient(fetch).download(URL_OK, 1024);
    expect(Array.from(got.bytes)).toEqual(Array.from(PNG));
    expect(got.contentType).toBe("image/png");
    expect(seen[0].headers).toEqual({}); // the URL is pre-signed: the company token is never sent to a CDN
    expect(seen[0].redirect).toBe("error");
  });

  it("refuses more than the cap: by Content-Length, and by counting the stream", async () => {
    const declared = fakeFetch(() => new Response(PNG, { status: 200, headers: { "content-length": "999999" } }));
    await expect(createFigmaClient(declared.fetch).download(URL_OK, 100)).rejects.toMatchObject({ kind: "too_large" });
    const streamed = fakeFetch(() => new Response(new Uint8Array(500), { status: 200 }));
    await expect(createFigmaClient(streamed.fetch).download(URL_OK, 100)).rejects.toMatchObject({ kind: "too_large" });
  });

  it("an empty body and a non-2xx are render_failed", async () => {
    const empty = fakeFetch(() => new Response(new Uint8Array(0), { status: 200 }));
    await expect(createFigmaClient(empty.fetch).download(URL_OK, 100)).rejects.toMatchObject({ kind: "render_failed" });
    const gone = fakeFetch(() => new Response("expired", { status: 403 }));
    await expect(createFigmaClient(gone.fetch).download(URL_OK, 100)).rejects.toMatchObject({ kind: "render_failed" });
  });

  it("a URL the server must not fetch is refused before any request is made", async () => {
    const { fetch, seen } = fakeFetch(() => new Response(PNG));
    const c = createFigmaClient(fetch);
    for (const bad of ["http://figma.example.com/a.png", "https://127.0.0.1/a.png", "https://localhost/a", "file:///etc/passwd", "not a url"]) {
      await expect(c.download(bad, 100)).rejects.toMatchObject({ kind: "render_failed" });
    }
    expect(seen).toHaveLength(0);
  });
});

describe("isSafeRenderUrl", () => {
  it.each([
    ["https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc", true],
    ["https://cdn.example.com/a.png?sig=1", true],
    ["http://cdn.example.com/a.png", false],
    ["https://user:pw@cdn.example.com/a.png", false],
    ["https://10.0.0.5/a.png", false],
    ["https://[::1]/a.png", false],
    ["https://localhost/a.png", false],
    ["https://service.internal/a.png", false],
    ["https://printer.local/a.png", false],
    ["https://intranet/a.png", false],
    ["gopher://cdn.example.com/a", false],
  ] as const)("%s is %s", (url, ok) => {
    expect(isSafeRenderUrl(url)).toBe(ok);
  });
});
