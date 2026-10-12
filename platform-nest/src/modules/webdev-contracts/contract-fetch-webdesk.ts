// M6-P4j (WSK-D81) -- the contract mirror's provider over the REAL four-layer control channel.
//
// WHY. The WSK-19 stub (`contract-fetch-http.ts`, `config.webdevControl`) speaks a plain bearer the real channel
// never accepts (WebDesk's `ControlAuthGuard` wants mTLS + an OAuth token), and it downloads each artifact from the
// presigned URL in the contract body. Those URLs are signed against WebDesk's container-internal object store, on a
// separate Docker daemon the ERP cannot (and, by the airlock, must not) reach. So the bytes cross the estate boundary
// ONLY over the control channel: `contract.read`'s `.../contract/:version/artifacts/:artifact` route.
//
// WHAT THIS FILE IS. It originates no network call of its own: every byte moves through `WebdeskControlClient`
// (`../webdev/webdesk-control-client.ts`, the one file that talks to WebDesk), which is why this file is not in
// `egress-inventory.test.ts`'s allowlist. The bundle's presigned URLs are kept only as opaque lookup keys, to
// learn which artifact a caller means; this file never requests one.
//
// The snapshot service still verifies `contentHash` and the block-library sha256 over the bytes it receives, so
// nothing here is trusted: a wrong or truncated body fails those tripwires exactly as before.
import {
  EditorialUnavailableError,
  WebdeskControlNotConfiguredError,
  WebdeskControlTokenError,
  WebdeskControlTransportError,
  type WebdeskControlClient,
  type WebdeskControlResponse,
} from "../webdev/webdesk-control-client";
import { toBundleMeta } from "./contract-fetch-http";
import {
  ContractControlNotConfiguredError, WebdevControlEgressError,
  type ContractBundleMeta, type WebdevControlProvider,
} from "./contract-fetch-provider";

/** The part of `WebdeskControlClient` this provider uses (a test double needs only these two). */
export type ContractChannelClient = Pick<WebdeskControlClient, "getContract" | "getContractArtifact">;

type ArtifactRef = { slug: string; version: string; artifact: "sdkTs" | "sdkPhp" | "openapi" | "contractMd" | "blockLibrary" };

/** Bundles are re-read on every refresh and each carries fresh URLs; keep the lookup bounded. */
const MAX_REMEMBERED_URLS = 128;

export class WebdeskChannelContractProvider implements WebdevControlProvider {
  readonly key = "webdesk-control" as const;

  readonly #client: ContractChannelClient;
  /** url -> what it stands for, from the bundles this instance returned. Insertion-ordered, oldest evicted first. */
  readonly #urls = new Map<string, ArtifactRef>();

  constructor(client: ContractChannelClient) {
    this.#client = client;
  }

  async getContractBundle(slug: string): Promise<ContractBundleMeta> {
    const res = await this.#through(`contract read for "${slug}"`, () => this.#client.getContract(slug));
    if (res.status !== 200) {
      throw new WebdevControlEgressError(`webdesk-control contract read for "${slug}" returned ${res.status}: ${res.bodyText.slice(0, 200)}`);
    }
    if (res.json === null) {
      throw new WebdevControlEgressError(`webdesk-control contract read for "${slug}" returned non-JSON`);
    }
    const meta = toBundleMeta(res.json);
    if (!meta) {
      throw new WebdevControlEgressError(`webdesk-control contract read for "${slug}" returned an unrecognized shape`);
    }
    const a = meta.artifacts;
    this.#remember(a.sdkTsUrl, { slug, version: meta.version, artifact: "sdkTs" });
    this.#remember(a.sdkPhpUrl, { slug, version: meta.version, artifact: "sdkPhp" });
    this.#remember(a.openapiUrl, { slug, version: meta.version, artifact: "openapi" });
    this.#remember(a.contractMdUrl, { slug, version: meta.version, artifact: "contractMd" });
    this.#remember(a.blockLibraryUrl, { slug, version: meta.version, artifact: "blockLibrary" });
    return meta;
  }

  /** The bytes of the artifact `url` stood for in a bundle this instance returned, over the control channel. The URL
   *  itself is never requested. Any other URL is refused: this provider is not a general downloader. */
  async downloadArtifact(url: string): Promise<Buffer> {
    const ref = this.#urls.get(url);
    if (!ref) throw new WebdevControlEgressError("artifact URL is not from a bundle this provider fetched");
    const what = `contract artifact '${ref.artifact}' for "${ref.slug}" ${ref.version}`;
    const res = await this.#through(what, () => this.#client.getContractArtifact(ref.slug, ref.version, ref.artifact));
    if (res.status < 200 || res.status >= 300) {
      // "answered HTTP", not "returned": the completion port reads "returned 404" as "no contract published yet".
      throw new WebdevControlEgressError(`webdesk-control ${what} answered HTTP ${res.status}`);
    }
    if (!res.bodyBytes) throw new WebdevControlEgressError(`webdesk-control ${what} came back without a raw body`);
    return res.bodyBytes;
  }

  #remember(url: string | null, ref: ArtifactRef): void {
    if (!url) return;
    this.#urls.delete(url); // re-insert so a repeated URL counts as the newest
    this.#urls.set(url, ref);
    while (this.#urls.size > MAX_REMEMBERED_URLS) {
      const oldest = this.#urls.keys().next().value as string;
      this.#urls.delete(oldest);
    }
  }

  /** Runs one client call and maps the client's error classes to the two this seam's callers already handle. Every
   *  client error message is credential-free by that client's own contract (it redacts transport errors and never
   *  echoes a token-endpoint body). */
  async #through(what: string, call: () => Promise<WebdeskControlResponse>): Promise<WebdeskControlResponse> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof WebdeskControlNotConfiguredError) throw new ContractControlNotConfiguredError(err.message);
      if (
        err instanceof WebdeskControlTransportError ||
        err instanceof WebdeskControlTokenError ||
        err instanceof EditorialUnavailableError
      ) {
        throw new WebdevControlEgressError(`webdesk-control ${what} failed: ${err.message}`);
      }
      throw err;
    }
  }
}
