// MAIL-04 — provider adapters. The TLS rule is pinned as a pure-function unit test (no network);
// the actual `smtp` adapter send is exercised against a tiny local fake-SMTP server standing in
// for the Mailpit dev sink — there is no server access in THIS ticket (MAIL-00 hasn't shipped a
// live sink), so this is the best available proof that the authless-plaintext hop actually works
// end to end. The real live-Mailpit-on-gda-aicenter smoke stays PENDING-SINK (§15/ticket note) —
// this test proves the CODE path, not deliverability against the real box.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { config } from "../config";
import { devLogAdapter, resolveAdapter, resetSmtpTransporterCacheForTest, smtpTransportOptions } from "./provider";
import type { OutboundMail } from "./types";

describe("mail/provider — TLS rule (design §4.1, v3-binding)", () => {
  it("forces requireTLS when credentials are set (leaked-creds-over-plaintext must be unrepresentable)", () => {
    const opts = smtpTransportOptions({ host: "smtp-relay.example.test", port: 587, user: "u", password: "p" });
    expect(opts.requireTLS).toBe(true);
    expect(opts.auth).toEqual({ user: "u", pass: "p" });
    expect(opts.secure).toBe(false);
  });

  it("allows plaintext (no requireTLS) when both user and password are empty — the authless sink hop", () => {
    const opts = smtpTransportOptions({ host: "mailpit", port: 1025, user: "", password: "" });
    expect(opts.requireTLS).toBe(false);
    expect(opts.auth).toBeUndefined();
  });

  it("still treats a lone username or lone password as 'credentials present' (forces TLS)", () => {
    expect(smtpTransportOptions({ host: "h", port: 1, user: "only-user", password: "" }).requireTLS).toBe(true);
    expect(smtpTransportOptions({ host: "h", port: 1, user: "", password: "only-pass" }).requireTLS).toBe(true);
  });
});

describe("mail/provider — resolveAdapter (master gate + unconfigured-stream fallback)", () => {
  const savedEnabled = config.mail.enabled;
  const savedNotifyHost = config.mail.streams.notify.relay.host;

  afterEach(() => {
    config.mail.enabled = savedEnabled;
    config.mail.streams.notify.relay.host = savedNotifyHost;
    resetSmtpTransporterCacheForTest();
  });

  it("returns dev-log unconditionally when MAIL_ENABLED=0, even if a stream looks configured", () => {
    config.mail.enabled = false;
    config.mail.streams.notify.relay.host = "smtp-relay.example.test";
    expect(resolveAdapter("notify")).toBe(devLogAdapter);
  });

  it("falls back to dev-log when enabled but the selected transport has no host configured", () => {
    config.mail.enabled = true;
    config.mail.streams.notify.relay.host = "";
    expect(resolveAdapter("notify")).toBe(devLogAdapter);
  });

  it("picks the smtp adapter when enabled and the stream has a host configured", () => {
    config.mail.enabled = true;
    config.mail.streams.notify.relay.host = "smtp-relay.example.test";
    expect(resolveAdapter("notify").name).toBe("smtp");
  });
});

describe("mail/provider — dev-log adapter", () => {
  it("never touches the network and reports success", async () => {
    const mail: OutboundMail = {
      stream: "notify",
      to: { email: "someone@example.test" },
      subject: "hi",
      html: "<p>hi</p>",
      text: "hi",
    };
    const result = await devLogAdapter.send(mail);
    expect(result.ok).toBe(true);
  });
});

// ── Fake authless SMTP server standing in for the Mailpit sink ──────────────────────────────────
interface FakeSmtp {
  port: number;
  receivedRcptTo: string[];
  receivedBodies: string[];
  close: () => Promise<void>;
}

function startFakeSmtp(): Promise<FakeSmtp> {
  const receivedRcptTo: string[] = [];
  const receivedBodies: string[] = [];
  return new Promise((resolve) => {
    const server: Server = createServer((socket: Socket) => {
      let buffer = "";
      let inData = false;
      let dataBuf = "";
      socket.write("220 fake.smtp.test ESMTP\r\n");
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        // eslint-disable-next-line no-cond-assign
        while ((idx = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              receivedBodies.push(dataBuf);
              dataBuf = "";
              socket.write("250 2.0.0 OK queued as fake-123\r\n");
            } else {
              dataBuf += `${line}\n`;
            }
            continue;
          }
          const cmd = line.split(" ")[0]?.toUpperCase() ?? "";
          if (cmd === "EHLO" || cmd === "HELO") socket.write("250-fake.smtp.test\r\n250 8BITMIME\r\n");
          else if (cmd === "MAIL") socket.write("250 2.1.0 OK\r\n");
          else if (cmd === "RCPT") {
            receivedRcptTo.push(line);
            socket.write("250 2.1.5 OK\r\n");
          } else if (cmd === "DATA") {
            inData = true;
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (cmd === "QUIT") {
            socket.write("221 2.0.0 Bye\r\n");
            socket.end();
          } else {
            socket.write("250 2.0.0 OK\r\n");
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        receivedRcptTo,
        receivedBodies,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("mail/provider — smtp adapter against a local authless fake-SMTP server (sink stand-in)", () => {
  it("sends plaintext, no-auth mail successfully — the exact TLS-rule branch the dev sink needs", async () => {
    const fake = await startFakeSmtp();
    config.mail.enabled = true;
    config.mail.streams.notify.relay.host = "127.0.0.1";
    config.mail.streams.notify.relay.port = fake.port;
    config.mail.streams.notify.relay.user = "";
    config.mail.streams.notify.relay.password = "";
    resetSmtpTransporterCacheForTest();
    try {
      const adapter = resolveAdapter("notify");
      expect(adapter.name).toBe("smtp");
      const result = await adapter.send({
        stream: "notify",
        to: { email: "recipient@dev.gaiada.invalid" },
        subject: "Test\r\nBcc: attacker@evil.test",
        html: "<p>hello</p>",
        text: "hello",
      });
      expect(result.ok).toBe(true);
      expect(fake.receivedRcptTo[0]).toContain("recipient@dev.gaiada.invalid");
      // The CRLF was stripped BEFORE the subject ever reached nodemailer, so the attacker's text
      // survives only as inert trailing characters glued onto the real Subject value — it must
      // never appear as its OWN header line (which is what a successful injection would produce).
      const body = fake.receivedBodies[0];
      expect(body.split("\n").some((line) => /^Bcc:/i.test(line.trim()))).toBe(false);
      expect(body).toContain("Subject: TestBcc: attacker@evil.test");
    } finally {
      await fake.close();
      resetSmtpTransporterCacheForTest();
    }
  });
});
