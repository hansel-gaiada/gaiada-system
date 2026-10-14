// DW-6i (docs/FRONTEND-BFF-CONTRACT.md §42.5, §42.7) — the Drive `files.get` client, driven against a fake `fetch`. Fixtures are
// Google's documented shapes (see the header of client.ts): the File resource (`id`, `name`, `mimeType`, `webViewLink`) and the
// error body `{ error: { code, message, errors: [{ reason, message }] } }`. No database, no network.
import { describe, it, expect } from "vitest";
import { DRIVE_FILE_FIELDS, DriveApiError, getDriveFile, isDriveFileId } from "./client";

const TOKEN = "ya29.DRIVE-ACCESS-TOKEN-SECRET-0001";
const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123-45";
const FILE = {
  id: FILE_ID, name: "Brand brief.pdf", mimeType: "application/pdf",
  webViewLink: `https://drive.google.com/file/d/${FILE_ID}/view?usp=drivesdk`,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const driveErr = (code: number, reason: string) => json({ error: { code, message: "boom", errors: [{ reason, message: "boom" }] } }, code);

interface Seen { url: string; init: RequestInit | undefined }
function fake(answer: (u: string) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f = async (url: string, init?: RequestInit) => { seen.push({ url, init }); return answer(url); };
  return { f, seen };
}
async function failure(p: Promise<unknown>): Promise<DriveApiError> {
  try { await p; } catch (e) { if (e instanceof DriveApiError) return e; throw e; }
  throw new Error("expected DriveApiError");
}

describe("getDriveFile (DW-6i)", () => {
  it("sends the documented request: GET /drive/v3/files/{id}?fields=id,name,mimeType,webViewLink with the Bearer token", async () => {
    const { f, seen } = fake(() => json(FILE));
    const out = await getDriveFile(TOKEN, FILE_ID, f);
    expect(out).toEqual(FILE);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`https://www.googleapis.com/drive/v3/files/${FILE_ID}?fields=${DRIVE_FILE_FIELDS}`);
    expect(DRIVE_FILE_FIELDS).toBe("id,name,mimeType,webViewLink");
    expect(seen[0].init?.method).toBe("GET");
    expect((seen[0].init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });
  it("answers only the four documented fields, dropping anything else Drive sends", async () => {
    const { f } = fake(() => json({ ...FILE, owners: [{ emailAddress: "x@y.test" }], kind: "drive#file" }));
    expect(Object.keys(await getDriveFile(TOKEN, FILE_ID, f)).sort()).toEqual(["id", "mimeType", "name", "webViewLink"]);
  });

  it("401 is `auth`; 404 is `not_found`", async () => {
    expect((await failure(getDriveFile(TOKEN, FILE_ID, fake(() => driveErr(401, "authError")).f))).kind).toBe("auth");
    expect((await failure(getDriveFile(TOKEN, FILE_ID, fake(() => driveErr(404, "notFound")).f))).kind).toBe("not_found");
  });
  it("403: a usage limit is Google's trouble (`unavailable`); any other 403 is a privilege refusal (`not_found`)", async () => {
    for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"]) {
      expect((await failure(getDriveFile(TOKEN, FILE_ID, fake(() => driveErr(403, reason)).f))).kind, reason).toBe("unavailable");
    }
    expect((await failure(getDriveFile(TOKEN, FILE_ID, fake(() => driveErr(403, "insufficientFilePermissions")).f))).kind).toBe("not_found");
    expect((await failure(getDriveFile(TOKEN, FILE_ID, fake(() => new Response("<html>", { status: 403 })).f))).kind).toBe("not_found");
  });
  it("429, 5xx and a network failure are `unavailable`, once, with no retry", async () => {
    for (const status of [429, 500, 503]) {
      const { f, seen } = fake(() => driveErr(status, "backendError"));
      expect((await failure(getDriveFile(TOKEN, FILE_ID, f))).kind).toBe("unavailable");
      expect(seen).toHaveLength(1);
    }
    const boom = fake(() => { throw new Error(`connect ECONNREFUSED while sending ${TOKEN}`); });
    const e = await failure(getDriveFile(TOKEN, FILE_ID, boom.f));
    expect(e.kind).toBe("unavailable");
    expect(boom.seen).toHaveLength(1);
  });
  it("an answer missing a documented field, or not JSON, is `unavailable`, never a half-written row", async () => {
    for (const body of [{ ...FILE, name: undefined }, { ...FILE, webViewLink: undefined }, { ...FILE, mimeType: 7 }, {}]) {
      expect((await failure(getDriveFile(TOKEN, FILE_ID, fake(() => json(body)).f))).kind).toBe("unavailable");
    }
    expect((await failure(getDriveFile(TOKEN, FILE_ID, fake(() => new Response("nope", { status: 200 })).f))).kind).toBe("unavailable");
  });
  it("refuses a link that is not https on a Google host (it is opened in a new tab)", async () => {
    for (const webViewLink of ["javascript:alert(1)", "http://drive.google.com/file/d/x/view", "https://evil.test/file/d/x/view", "https://drive.google.com.evil.test/x", "not a url"]) {
      expect((await failure(getDriveFile(TOKEN, FILE_ID, fake(() => json({ ...FILE, webViewLink })).f))).kind, webViewLink).toBe("unavailable");
    }
  });

  it("never sends a request for an id that is not a Drive file id, so the id cannot change the path or the host", async () => {
    const { f, seen } = fake(() => json(FILE));
    for (const bad of ["", "abc", "../../oauth2/v1/userinfo", "a/b/c/d/e/f", "x?fields=all&", "id with space", "x".repeat(300), "id\n"]) {
      expect((await failure(getDriveFile(TOKEN, bad, f))).kind, bad).toBe("not_found");
    }
    expect(seen).toEqual([]);
    expect(isDriveFileId(FILE_ID)).toBe(true);
    expect(isDriveFileId(undefined)).toBe(false);
  });

  it("no thrown error carries the token, a header or a body", async () => {
    const cases = [driveErr(401, "authError"), driveErr(404, "notFound"), driveErr(500, "backendError"), json({ ...FILE, name: 1 })];
    for (const r of cases) {
      const e = await failure(getDriveFile(TOKEN, FILE_ID, fake(() => r.clone()).f));
      const dump = `${e.message} ${JSON.stringify(e)} ${e.stack ?? ""}`;
      expect(dump).not.toContain(TOKEN);
      expect(dump).not.toContain("authorization");
    }
  });
});
