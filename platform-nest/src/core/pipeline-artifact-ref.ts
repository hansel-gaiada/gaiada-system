// M6-P4e: how `pipeline.artifacts.get` resolves a ref.
//
// The delivery flow stores the accepted design (and the PRD) as TEXT in `pipeline_stages.artifact_ref`,
// not as a `files` id, so the original by-value lookup answered `resolvable:false` and `code.scaffold`
// failed with `artifact_fetch_failed`. Passing the text itself back as a `?ref=` query string is not a
// fix either (a design brief is many KB and a GET line is not). So a ref may now also name the STAGE:
// `stage:<stage uuid>` resolves that stage's own `artifact_ref`, whatever shape it has (a file id, a URL,
// or inline text). The stage lookup stays the authorization boundary, exactly as for a by-value ref.
// Existing runs are unchanged: nothing is rewritten, and a by-value ref still resolves as before.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STAGE_REF = new RegExp(`^stage:(${UUID})$`, "i");
const FILE_ID = new RegExp(`^${UUID}$`, "i");

/** The stage id inside a `stage:<uuid>` ref, or null when the ref is not a stage ref. */
export function parseStageRef(ref: string): string | null {
  const m = STAGE_REF.exec(ref.trim());
  return m ? m[1].toLowerCase() : null;
}

export type ArtifactShape = "file" | "external" | "inline" | "empty";

/** What a stage's `artifact_ref` value IS: a stored file id, an external reference (URL / ssh remote),
 *  stored-inline text (the delivery flow's design and PRD), or nothing. */
export function classifyArtifactValue(value: string | null | undefined): ArtifactShape {
  const v = (value ?? "").trim();
  if (!v) return "empty";
  if (FILE_ID.test(v)) return "file";
  if (/^(https?:\/\/|ssh:\/\/|git@)\S*$/i.test(v)) return "external";
  return "inline";
}
