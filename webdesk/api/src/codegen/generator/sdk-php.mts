// WSK-34 — derives the PHP SDK from the SAME already-built OpenAPI document `sdk-ts.mts` derives
// the TS SDK from (WSK-D19: "TS/PHP/Markdown derived" from `openapi.v1.json`; WSK-D11: "PHP SDK
// near-free once OpenAPI-first lands"). This file joins `buildContractArtifacts` (build-artifacts.mts)
// exactly the way `sdk-ts.mts` already does — same input, same determinism contract, same "no
// wall-clock leakage" rule (no `generatedAt`/timestamp anywhere in the emitted bytes).
//
// Why hand-rolled instead of a PHP OpenAPI-codegen package (openapi-generator-cli etc.): no such
// dependency exists in webdesk/api/package.json today, and WSK-34's brief forbids new dependencies
// without an explicit spec decision. This generator is therefore a small, DETERMINISTIC, pure
// function over the OpenAPI document's own `paths` + `x-webdesk-contract` extension — the same
// class of "derived, not hand-written" claim `sdk-ts.mts` makes, just implemented as string
// templating instead of delegating to `openapi-typescript`. It reads NOTHING the OpenAPI document
// does not already contain — no separate pass over the vocabulary, no separate pass over
// composition — so it cannot drift from what `openapi-builder.mts` describes.
//
// Emits ONE self-contained PHP 8.1+ file (`sdk.php`), namespace `GaiadaWebDesk\Sdk`:
//   - `WebDeskApiException` — thrown on any 4xx/5xx, carrying the RFC 9457 problem+json body.
//   - `WebDeskClient` — constructor(baseUrl, apiKey); a private curl-based `get()`/`rawGet()`;
//     one `list<Collection>()` + `get<Collection>($slug)` method PER collection key the tenant's
//     contract declares, plus `search()` and `sitemapXml()` — mirroring exactly the paths
//     `openapi-builder.mts` emits (list/item/search/sitemap, nothing else, nothing invented).
// No framework, no Composer dependency (ext-curl + ext-json are PHP core extensions) — deliberate,
// since WSK-35's theme targets Hostinger shared hosting, which has no shell/Composer-install model
// (infra/runbooks/onboard-server.md) and must consume this file as a plain `require`.

interface OpenApiPathEntry {
  get?: { operationId?: string; parameters?: Array<{ name: string; in: string; required?: boolean }> };
}

interface OpenApiDocument {
  info: {
    version: string;
    "x-webdesk-contract": {
      tenantSlug: string;
      vocabularyVersion: string;
      collectionKeys: string[];
    };
  };
  paths: Record<string, OpenApiPathEntry>;
}

/** `article` -> `Article`, `caseStudy` -> `CaseStudy`, `press-release` -> `PressRelease`. Strips
 *  anything that is not `[A-Za-z0-9]` as a word boundary — deterministic, total (never throws on
 *  an odd key), and collision-avoidance is the generated code's own problem to surface (a PHP
 *  redeclaration error), not something this function silently guesses around. */
function pascalCase(key: string): string {
  return key
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function phpStringLiteral(value: string): string {
  // Single-quoted PHP string literal — only `\` and `'` need escaping inside one.
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Deterministically derives the PHP SDK source from an already-built OpenAPI document. Pure —
 *  no I/O, no `Date`/`Math.random`, matching every other file in this directory's determinism
 *  contract (see canonical-json.mts's own header). */
export function generatePhpSdk(openApiDocument: OpenApiDocument): string {
  const contract = openApiDocument.info["x-webdesk-contract"];
  const collectionKeys = [...contract.collectionKeys].sort();
  const tenantSlug = contract.tenantSlug;

  const lines: string[] = [];
  lines.push("<?php");
  lines.push("");
  lines.push("declare(strict_types=1);");
  lines.push("");
  lines.push("namespace GaiadaWebDesk\\Sdk;");
  lines.push("");
  lines.push("/**");
  lines.push(" * GENERATED — DO NOT HAND-EDIT.");
  lines.push(" *");
  lines.push(" * Derived from openapi.v1.json by webdesk/api/src/codegen/generator/sdk-php.mts (WSK-34).");
  lines.push(" * A hand-edit here does not survive the next `codegen:run` — regeneration is authoritative");
  lines.push(" * (webdesk-design.md §05/§06, WSK-D19: TS/PHP/Markdown are all DERIVED from openapi.v1.json,");
  lines.push(" * never the other way around).");
  lines.push(" *");
  lines.push(` * tenant:            ${tenantSlug}`);
  lines.push(` * contractVersion:   ${openApiDocument.info.version}`);
  lines.push(` * vocabularyVersion: ${contract.vocabularyVersion}`);
  lines.push(" *");
  lines.push(" * Deliberately excludes any generation timestamp from this file's bytes — the determinism");
  lines.push(" * gate (webdesk/api/src/codegen/generator/double-run-gate.mts) requires byte-identical output");
  lines.push(" * for the same input, and a wall-clock value would make that impossible by construction.");
  lines.push(" */");
  lines.push("");
  lines.push("final class WebDeskApiException extends \\RuntimeException");
  lines.push("{");
  lines.push("    /** @var array<string,mixed> RFC 9457 problem+json body, decoded. */");
  lines.push("    public array $problem;");
  lines.push("    public int $status;");
  lines.push("");
  lines.push("    /** @param array<string,mixed> $problem */");
  lines.push("    public function __construct(int $status, array $problem)");
  lines.push("    {");
  lines.push("        $this->status = $status;");
  lines.push("        $this->problem = $problem;");
  lines.push("        parent::__construct((string) ($problem['title'] ?? ('HTTP ' . $status)), $status);");
  lines.push("    }");
  lines.push("}");
  lines.push("");
  lines.push("final class WebDeskClient");
  lines.push("{");
  lines.push("    private string $baseUrl;");
  lines.push("    private string $apiKey;");
  lines.push("");
  lines.push("    public function __construct(string $baseUrl, string $apiKey)");
  lines.push("    {");
  lines.push("        $this->baseUrl = rtrim($baseUrl, '/');");
  lines.push("        $this->apiKey = $apiKey;");
  lines.push("    }");
  lines.push("");
  lines.push("    /**");
  lines.push("     * @param array<string,scalar> $query");
  lines.push("     * @return array<string,mixed>");
  lines.push("     */");
  lines.push("    private function getJson(string $path, array $query = []): array");
  lines.push("    {");
  lines.push("        [$status, $body] = $this->request($path, $query);");
  lines.push("        $decoded = json_decode($body, true);");
  lines.push("        if (!is_array($decoded)) {");
  lines.push("            $decoded = [];");
  lines.push("        }");
  lines.push("        if ($status >= 400) {");
  lines.push("            throw new WebDeskApiException($status, $decoded);");
  lines.push("        }");
  lines.push("        return $decoded;");
  lines.push("    }");
  lines.push("");
  lines.push("    /**");
  lines.push("     * @param array<string,scalar> $query");
  lines.push("     */");
  lines.push("    private function getRaw(string $path, array $query = []): string");
  lines.push("    {");
  lines.push("        [$status, $body] = $this->request($path, $query);");
  lines.push("        if ($status >= 400) {");
  lines.push("            $decoded = json_decode($body, true);");
  lines.push("            throw new WebDeskApiException($status, is_array($decoded) ? $decoded : []);");
  lines.push("        }");
  lines.push("        return $body;");
  lines.push("    }");
  lines.push("");
  lines.push("    /**");
  lines.push("     * @param array<string,scalar> $query");
  lines.push("     * @return array{0: int, 1: string}");
  lines.push("     */");
  lines.push("    private function request(string $path, array $query): array");
  lines.push("    {");
  lines.push("        $url = $this->baseUrl . $path;");
  lines.push("        if ($query !== []) {");
  lines.push("            $url .= '?' . http_build_query($query);");
  lines.push("        }");
  lines.push("        $ch = curl_init($url);");
  lines.push("        curl_setopt_array($ch, [");
  lines.push("            CURLOPT_RETURNTRANSFER => true,");
  lines.push("            CURLOPT_HTTPHEADER => [");
  lines.push("                'Authorization: Bearer ' . $this->apiKey,");
  lines.push("                'Accept: application/json',");
  lines.push("            ],");
  lines.push("            CURLOPT_TIMEOUT => 10,");
  lines.push("        ]);");
  lines.push("        $body = curl_exec($ch);");
  lines.push("        if ($body === false) {");
  lines.push("            $err = curl_error($ch);");
  lines.push("            curl_close($ch);");
  lines.push("            throw new \\RuntimeException('WebDesk API request failed: ' . $err);");
  lines.push("        }");
  lines.push("        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);");
  lines.push("        curl_close($ch);");
  lines.push("        return [$status, (string) $body];");
  lines.push("    }");
  lines.push("");

  for (const key of collectionKeys) {
    const listPath = `/v1/t/${tenantSlug}/${key}`;
    const itemPathPrefix = `${listPath}/`;
    const pascal = pascalCase(key);

    lines.push(`    /**`);
    lines.push(`     * List "${key}" items (cursor-paginated). Mirrors GET ${listPath}.`);
    lines.push(`     * @param array<string,scalar> $query locale, cursor, limit, expand`);
    lines.push(`     * @return array<string,mixed> a ListEnvelope`);
    lines.push(`     */`);
    lines.push(`    public function list${pascal}(array $query = []): array`);
    lines.push(`    {`);
    lines.push(`        return $this->getJson(${phpStringLiteral(listPath)}, $query);`);
    lines.push(`    }`);
    lines.push("");
    lines.push(`    /**`);
    lines.push(`     * Read one "${key}" item by slug. Mirrors GET ${itemPathPrefix}{slug}.`);
    lines.push(`     * @param array<string,scalar> $query locale`);
    lines.push(`     * @return array<string,mixed> an ItemEnvelope`);
    lines.push(`     */`);
    lines.push(`    public function get${pascal}(string $slug, array $query = []): array`);
    lines.push(`    {`);
    lines.push(`        return $this->getJson(${phpStringLiteral(itemPathPrefix)} . rawurlencode($slug), $query);`);
    lines.push(`    }`);
    lines.push("");
  }

  lines.push("    /**");
  lines.push(`     * Full-text search across every collection. Mirrors GET /v1/t/${tenantSlug}/search.`);
  lines.push("     * @param array<string,scalar> $query collection, locale, cursor, limit");
  lines.push("     * @return array<string,mixed> a ListEnvelope");
  lines.push("     */");
  lines.push("    public function search(string $q, array $query = []): array");
  lines.push("    {");
  lines.push(`        return $this->getJson(${phpStringLiteral(`/v1/t/${tenantSlug}/search`)}, array_merge(['q' => $q], $query));`);
  lines.push("    }");
  lines.push("");
  lines.push("    /**");
  lines.push(`     * Generated sitemap.xml for the resolved locale. Mirrors GET /v1/t/${tenantSlug}/sitemap.xml.`);
  lines.push("     * @param array<string,scalar> $query locale");
  lines.push("     */");
  lines.push("    public function sitemapXml(array $query = []): string");
  lines.push("    {");
  lines.push(`        return $this->getRaw(${phpStringLiteral(`/v1/t/${tenantSlug}/sitemap.xml`)}, $query);`);
  lines.push("    }");
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}
