// WSK-07 — §04 gap this design calls out by name: "on-the-fly image transforms via imgproxy
// (pre-baked responsive variants age badly)". This service builds a SIGNED imgproxy URL from a
// source object URL + transform options, following imgproxy's own documented URL-signing scheme
// (https://docs.imgproxy.net/usage/signing_the_url):
//
//   signature = base64url( HMAC-SHA256( key, salt || path ) )
//   url       = "{IMGPROXY_URL}/{signature}/{processing_options}/{base64url(source_url)}"
//
// `key`/`salt` are configured as hex strings (imgproxy's own convention for IMGPROXY_KEY /
// IMGPROXY_SALT). No imgproxy container exists in this ticket's compose stack yet (flagged in
// media.config.ts and in the ticket report as a required addition) — this class is exercised by a
// pure unit test against the documented signing algorithm, independent of a live instance; the
// live HTTP hop is PROTOTYPED, not DEV-VERIFIED, until imgproxy is actually deployed.
import { Injectable } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { mediaConfig } from "./media.config";

export type ImageTransformOptions = {
  width?: number;
  height?: number;
  fit?: "fill" | "fit" | "crop";
};

@Injectable()
export class ImgproxyService {
  get isConfigured(): boolean {
    return Boolean(mediaConfig.imgproxyUrl && mediaConfig.imgproxyKeyHex && mediaConfig.imgproxySaltHex);
  }

  buildSignedUrl(sourceUrl: string, opts: ImageTransformOptions): string {
    if (!this.isConfigured) {
      throw new Error("imgproxy is not configured (IMGPROXY_URL/IMGPROXY_KEY/IMGPROXY_SALT unset)");
    }
    const processingOptions = buildProcessingOptionsPath(opts);
    const encodedSource = base64UrlEncode(Buffer.from(sourceUrl, "utf8"));
    const path = `/${processingOptions}/${encodedSource}`;

    const key = Buffer.from(mediaConfig.imgproxyKeyHex, "hex");
    const salt = Buffer.from(mediaConfig.imgproxySaltHex, "hex");
    const signature = base64UrlEncode(createHmac("sha256", key).update(Buffer.concat([salt, Buffer.from(path, "utf8")])).digest());

    return `${mediaConfig.imgproxyUrl.replace(/\/$/, "")}/${signature}${path}`;
  }
}

function buildProcessingOptionsPath(opts: ImageTransformOptions): string {
  const parts: string[] = [];
  if (opts.width || opts.height) {
    const resizeType = opts.fit === "crop" ? "fill" : opts.fit === "fit" ? "fit" : "fill";
    parts.push(`rs:${resizeType}:${opts.width ?? 0}:${opts.height ?? 0}`);
  }
  return parts.length > 0 ? parts.join("/") : "plain"; // no transform requested -> pass through
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
