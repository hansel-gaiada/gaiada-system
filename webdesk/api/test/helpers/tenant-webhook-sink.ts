// WSK-37 — a REAL local HTTPS sink (not a mock) that tenant-webhooks-delivery.spec.ts points
// registered webhooks at. It records every request it receives (headers + raw body, for signature
// verification) and can be told to fail its next N requests before succeeding — the mechanism
// tenant-webhooks-delivery.spec.ts uses to prove retry/backoff against a genuinely failing
// endpoint, mirroring mail-retry-backoff.spec.ts's own "stop/start a real container" discipline,
// scaled down to an in-process server since the ticket does not require a separate container for
// the receiving side.
//
// WHY HTTPS, NOT PLAIN HTTP: the SSRF guard and the registration DTO both reject non-https targets
// by design (§03: "enforce HTTPS") — a plain-HTTP sink would force the test suite to weaken the
// very guard it is supposed to be proving. So this sink runs `node:https` with a throwaway
// self-signed certificate (embedded below, CN/SAN=127.0.0.1, generated once with
// `openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "//CN=127.0.0.1" -addext
// "subjectAltName=IP:127.0.0.1"` — safe to regenerate any time, it authenticates nothing beyond
// "this is the sink this test process itself just started"). Delivery specs set
// `NODE_TLS_REJECT_UNAUTHORIZED=0` for the one `fetch()` call to this self-signed sink, exactly
// as any real integration test against a self-signed local endpoint must — production traffic
// goes to real tenant infrastructure with real certificates and is never subject to this.
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";

export type SinkRequest = { headers: Record<string, string | string[] | undefined>; rawBody: string; receivedAt: number };

const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIC8jCCAdqgAwIBAgIUPCkPsi5DKq58tvitMFgvw8VhNpcwDQYJKoZIhvcNAQEL
BQAwADAeFw0yNjA4MjcwMjM0NTNaFw0zNjA4MjQwMjM0NTNaMAAwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDFuTzPXcmXDK9rBuwDv2B8u0ymyodOnPDO
LH70hGoR9MWDHPsO2bdzcdmy6YwkVVII2wlgcbEzvUccQ2LE9PmWmk11AWN9lGHX
RJlbUiO/LEN0WZLHAtmHVyloMWR7p3vjWgZeRDKcuoLP2xCH/EJ4sQc1wVVeOGKF
fLHwUBJWh9e9GSQKtAA50bvL3CuNLZA5xl6wMAVouspPfFFvGU2+hBsM+v0S/Bk5
/mG680VRjeNMwaraeNgSRhLBuauIt+O+HTvcyIC1iYWyi7aVtbyMYcLRIUdklXCi
lq0HaFRwKmAQ6qE4gbdB8l0M71JlfaEujJOGYb8HWj9X/7Aie9WlAgMBAAGjZDBi
MB0GA1UdDgQWBBQkAujAI2rvOR1+soGz2SQ5MClO/jAfBgNVHSMEGDAWgBQkAujA
I2rvOR1+soGz2SQ5MClO/jAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8A
AAEwDQYJKoZIhvcNAQELBQADggEBAGoApIkZncUkIWg3EogL9Ql1mDTXb1vvMpZk
l1uO0xIV6stLcKtRr4b49mitfltth3h7MuF3Nl2+acwsqp0oUNG8s+EVCoxR5oQX
/+fRQayk8zx14RdpypmACYzFwLQjdsd/kaVA+kQIwpXd/CIlqn4AUrR2qrFnEStn
okY0M9H1ckgIWIMNbSuFvv9RT27MT8D6eoirL8a167Hxy7FHRLHEEm6lbgMLNGna
wF5nDZheklG50e+O0vEDDt+T4OpvZPm0HfCkcpE0Lcj+8oq9BUFaZ3T/D0FeKJsG
9XBeZZoNf3WuVqOPxNHJLt3oHX9B0Ti7bt3TgkRnIX7cF1cGPwY=
-----END CERTIFICATE-----`;

const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDFuTzPXcmXDK9r
BuwDv2B8u0ymyodOnPDOLH70hGoR9MWDHPsO2bdzcdmy6YwkVVII2wlgcbEzvUcc
Q2LE9PmWmk11AWN9lGHXRJlbUiO/LEN0WZLHAtmHVyloMWR7p3vjWgZeRDKcuoLP
2xCH/EJ4sQc1wVVeOGKFfLHwUBJWh9e9GSQKtAA50bvL3CuNLZA5xl6wMAVouspP
fFFvGU2+hBsM+v0S/Bk5/mG680VRjeNMwaraeNgSRhLBuauIt+O+HTvcyIC1iYWy
i7aVtbyMYcLRIUdklXCilq0HaFRwKmAQ6qE4gbdB8l0M71JlfaEujJOGYb8HWj9X
/7Aie9WlAgMBAAECggEAD+QCtDYZAZvaTPX7XxQQ/11MkbAVE/dELtxqdKDgEc2J
V9pVqWchLwpJ9oQoyEfCJiY3w0mdNf0NkMLaq90gt7RIKtyVICPeLCnzevXSRnxF
IeihWv9f4lhvN77r0ONQRItOQo0PwJhdyIeWNR5L7P1p81hJ0d7NY5CMECCt+fML
HKs6R+6DXgMJ2QOsF+ggaXYPBBHIiebRBLg12cyY2HDBnCo/4IFSYUgDGvhuMz88
xx4MRGddDiAgUTQrxQzi/4cj5IDXfo3Bi2K+eRCwSLf661Lx9HNWO/fqu1bu+9gh
4wZwBaXyoFuSEQRpIE99fx1fTiR4VTnJE6PbkCMd8QKBgQD4ZuLwKrmmAXgfhHzM
ZAKEnH83MY4BUka3rJ1VokJaG/fOTOaqhh14IP8VHQCOHV0y9w48lNlx8OvuNJ+1
YpZY7BXUTw33SoJdwoGpBpCaV51m440fbEKKE42iJ/jmwm1EYVqdbcsG5WXI6Iv0
dZePQoMsVyHvu2v0uD5IUYgnFQKBgQDLxYOWF181/ziN+X3+tPZLeKwy00QMKcOl
I2iiVAqnroH6Ju19dYSd3lun7ZZw9Git2t0HbcRdNT4Tr5L+hsF6iMKY/SMnBVQh
qCX9pIGz5n559V66IGZPD+zUlg1A3mOz1QlW8dQ26QMzJzRIfwPQDw/mTIHqhXnY
tWU8HyeYUQKBgQCI7y7rdqIhAW5W8ZJamkdJE3yN0KOX1uNlHaMeMfSh+AkDkSEX
oBdewdHcscA8l7NpBQi0HNpCFa36AsiIFXEMVBk0kOACEvEK/s67fwL4EpSSw55o
VCXaOC071w0/KK9TotdxMbVad9tEhe2hNbH3J5NoPiBXJ9q7bVXoSAnmgQKBgQCI
rUSjia2tFDEk2XGvREXnPVuTA62i0uiNfYCTUPeMnTpFRZMKEacQFLM5odzEissj
wad7ch7BvhKTNbLM0io4PD76SuAnLiXOJXDF/m+Y8UNoHjKZeV3mLfJWbQcauY/6
cSxAixgidIxW5TbmYXt3NIMfn7WMTlb6CkGK4AK44QKBgEHQlN9eJzbpSw6INNrZ
JqhQe1ZixL5BR8k5PtyCRPEBm4MzeNGgJ9bgd8+zbFN+AYysiy+vZLCjPmShJH/E
6I8+TDsG+w6acpQgrJm2YW63jYLOkrgsR1YCYKQFptYqPaK3+a/RnBlfhzEWOLrT
6DIYFOiu0CXC8Lq1PYTdtb+6
-----END PRIVATE KEY-----`;

export class TenantWebhookSink {
  private server: Server;
  private requests: SinkRequest[] = [];
  private failuresRemaining = 0;
  port = 0;

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<TenantWebhookSink> {
    return new Promise((resolve, reject) => {
      const sink = new TenantWebhookSink(null as unknown as Server);
      const server = createServer({ cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY }, (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          sink.requests.push({ headers: req.headers, rawBody, receivedAt: Date.now() });
          if (sink.failuresRemaining > 0) {
            sink.failuresRemaining--;
            res.writeHead(503, { "Content-Type": "text/plain" });
            res.end("simulated failure");
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      sink.server = server;
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        sink.port = (server.address() as AddressInfo).port;
        resolve(sink);
      });
    });
  }

  url(): string {
    return `https://127.0.0.1:${this.port}/webhook`;
  }

  /** The next `n` requests this sink receives will get a 503; every request after that succeeds. */
  failNextRequests(n: number): void {
    this.failuresRemaining = n;
  }

  received(): SinkRequest[] {
    return this.requests;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
