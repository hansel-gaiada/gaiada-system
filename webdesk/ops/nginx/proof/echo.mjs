// WSK-63a proof upstream: stands in for the `api` service. Echoes what it received and, for the cert
// header, runs the REAL Layer 1 verifier (webdesk/api/src/control/auth/mtls-verifier.ts, type-stripped by
// node) against the pinned CA, so "the api would accept this" is demonstrated, not assumed.
//   GET /__hits  -> {"hits": N}  (requests that reached this process; refusals must not move it)
import http from "node:http";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { verifyClientCertificate } from "/repo/webdesk/api/src/control/auth/mtls-verifier.ts";

const CA = readFileSync(process.env.CA_FILE, "utf8");
let hits = 0;

http
  .createServer((req, res) => {
    if (req.url === "/__hits") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ hits }));
    }
    hits += 1;
    const h = req.headers["x-webdesk-mtls-cert-pem"];
    let received = null;
    if (typeof h === "string") {
      try {
        const x = new X509Certificate(decodeURIComponent(h));
        received = { subject: x.subject, fingerprint256: x.fingerprint256 };
      } catch (e) {
        received = { unparsable: String(e.message) };
      }
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        path: req.url,
        mtlsCertHeaderPresent: typeof h === "string",
        received,
        layer1: verifyClientCertificate(typeof h === "string" ? h : undefined, CA, ["platform-nest-webdesk"]),
        controlGateHeaderPresent: "x-webdesk-control-gate" in req.headers,
      }),
    );
  })
  .listen(3000, "0.0.0.0", () => console.log("echo listening on :3000"));
