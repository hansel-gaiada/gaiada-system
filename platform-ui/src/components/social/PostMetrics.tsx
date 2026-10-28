"use client";
// SCP-3c (BFF §63.10 "Metrics", plan §4.2) — the Metrics block of a LIVE Social Media post: the latest numbers, the engagement rate as a percentage, the client's average,
// a "Boost candidate" chip, a SIMULATED chip, where the numbers came from (Pulled, Typed in, Simulated) and when they were captured; and, for the client's officer, an
// "Enter metrics" form per variant (one network each).
//
// IT DRAWS THE READ (`GET posts/:postId/metrics`) and decides nothing: the rate, the average and the boost mark are the server's. A counter the server did not report reads
// "Not reported", never 0. After a save the page asks the server for the aggregate again (`loadPostMetrics`), so the rate and the mark shown are the server's own.
//
// WHO MAY TYPE (`canEnterMetrics`): the client's officer, found by the read's `officer`, since a live post lists no step in `actions[]`. The server decides the write: a 400
// names its `field`, which is put beside that input; any other refusal is said in words (`refusalText`) under the form.
import { useId, useState, useTransition } from "react";
import { RefusalNote } from "@/components/social/PostRefusal";
import { SimulatedMark } from "@/components/social/SimulatedMark";
import { formatDateTime } from "@/lib/format";
import {
  COUNTERS, COUNTER_LABEL, SOURCE_WORDS, buildMetricsBody, canEnterMetrics, emptyMetricsForm, formatCount, formatRate,
  type Counter, type FieldErrors, type MetricsForm, type PostMetrics,
} from "@/lib/socialMetrics";
import { networkLabel, type PipelinePost, type Refusal } from "@/lib/socialPipeline";
import { enterPostMetrics, loadPostMetrics } from "@/lib/socialPipelineActions";

export interface PostMetricsSectionProps {
  post: PipelinePost;
  /** `undefined`: not asked for (the post is not live). `null`: the read failed, so the block says it cannot tell. */
  metrics: PostMetrics | null | undefined;
  /** The signed-in person, for the officer's form. */
  viewerId?: string | null;
  /** Called after a snapshot is saved (the page refreshes what else it shows). */
  onSaved?: () => void;
}

/** The inputs of one counter, in the order the form lists them: reach first (required), then the rest. */
const FORM_COUNTERS: readonly Counter[] = COUNTERS;

export function PostMetricsSection({ post, metrics, viewerId, onSaved }: PostMetricsSectionProps) {
  const uid = useId();
  const [data, setData] = useState<PostMetrics | null | undefined>(metrics);
  const [seen, setSeen] = useState(metrics);
  // A fresh read from the server replaces what a save showed: the server's copy is the truth.
  if (metrics !== seen) { setSeen(metrics); setData(metrics); }
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (post.pipelineStatus !== "live" || data === undefined) return null;
  const canEnter = canEnterMetrics(post, viewerId);
  const latest = data?.latest ?? null;

  return (
    <section aria-labelledby={`${uid}-h`} className="scp-metrics">
      <h3 className="scp-post__section-title" id={`${uid}-h`}>Metrics</h3>
      {data === null ? (
        <p className="scp-note" role="status" style={{ margin: 0 }}>The numbers could not be read, so they are not shown here. This is not a statement that there are none.</p>
      ) : (
        <>
          <div className="scp-post__chips">
            {data.boostCandidate && <span className="scp-chip scp-chip--boost">Boost candidate</span>}
            {data.simulated && <SimulatedMark of="metrics" />}
          </div>
          {latest ? (
            <>
              <dl className="scp-metrics__grid" aria-label="Latest numbers">
                {FORM_COUNTERS.filter((k) => k !== "impressions" || latest.impressions !== null).map((k) => (
                  <div key={k} className="scp-metrics__cell">
                    <dt className="scp-row__label">{COUNTER_LABEL[k]}</dt>
                    <dd className={`scp-metrics__value${latest[k] === null ? " scp-row__value--empty" : ""}`}>{formatCount(latest[k])}</dd>
                  </div>
                ))}
              </dl>
              <p className="scp-metrics__source">
                Source: <strong>{SOURCE_WORDS[latest.source]}</strong>, captured {formatDateTime(latest.capturedAt)}.
              </p>
            </>
          ) : (
            <p className="scp-note" style={{ margin: 0 }}>No numbers for this post yet.</p>
          )}
          <dl className="scp-metrics__grid" aria-label="Engagement rate">
            <div className="scp-metrics__cell">
              <dt className="scp-row__label">Engagement rate</dt>
              <dd className="scp-metrics__value">{formatRate(data.engagementRate)}</dd>
              {data.engagementRate === null && <dd className="scp-field__hint">It needs a reach.</dd>}
            </div>
            <div className="scp-metrics__cell">
              <dt className="scp-row__label">This client&apos;s average, last 90 days</dt>
              <dd className="scp-metrics__value">{formatRate(data.accountAverageRate)}</dd>
              {data.accountAverageRate === null && <dd className="scp-field__hint">No other live post of this client has a rate yet.</dd>}
            </div>
          </dl>
          <p className="scp-field__hint" style={{ margin: 0 }}>
            Engagement rate is likes, comments, saves and shares over reach.
            {data.boostCandidate ? " This post is well above the client's average, so it is worth considering for a boost." : ""}
          </p>
        </>
      )}

      {notice && <p className="scp-post__banner scp-post__banner--ok" role="status">{notice}</p>}

      {canEnter && (
        post.variants.length === 0 ? (
          <p className="scp-note" style={{ margin: 0 }}>This post has no network to type numbers in for.</p>
        ) : (
          <div className="scp-metrics__enter">
            {post.variants.map((v) => {
              const label = networkLabel(v.network);
              const open = openId === v.id;
              return (
                <div key={v.id} className="scp-metrics__variant">
                  <button
                    type="button" className="lux-btn lux-btn--sm" aria-expanded={open} aria-controls={`${uid}-f-${v.id}`}
                    onClick={() => { setOpenId(open ? null : v.id); setNotice(null); }}
                  >
                    {open ? `Close the ${label} form` : `Enter metrics for ${label}`}
                  </button>
                  {open && (
                    <MetricsFormFor
                      id={`${uid}-f-${v.id}`} variantId={v.id} postId={post.id} label={label}
                      onSaved={(next) => {
                        setOpenId(null);
                        setNotice(`Metrics saved for ${label}.`);
                        if (next) setData(next);
                        onSaved?.();
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
    </section>
  );
}

function MetricsFormFor({ id, variantId, postId, label, onSaved }: { id: string; variantId: string; postId: string; label: string; onSaved: (next: PostMetrics | null) => void }) {
  const [form, setForm] = useState<MetricsForm>(() => emptyMetricsForm());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [refusal, setRefusal] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setRefusal(null);
    const built = buildMetricsBody(form);
    if (!built.ok) { setErrors(built.errors); return; }
    setErrors({});
    start(async () => {
      const r = await enterPostMetrics(variantId, built.body);
      if (r.ok) {
        const next = await loadPostMetrics(postId);
        onSaved(next);
        return;
      }
      // A 400 names its field: it goes beside that input. Anything else is a refusal in words.
      const f = r.refusal.field;
      if (r.refusal.status === 400 && f && (f === "capturedAt" || (COUNTERS as readonly string[]).includes(f))) setErrors({ [f]: r.message });
      else setRefusal({ refusal: r.refusal, message: r.message });
    });
  }

  const set = (k: Counter | "capturedAt", v: string) => {
    setForm((f) => (k === "capturedAt" ? { ...f, capturedAt: v } : { ...f, values: { ...f.values, [k]: v } }));
    setErrors((x) => ({ ...x, [k]: undefined }));
  };

  return (
    <form id={id} className="scp-dialog scp-metrics__form" role="group" aria-label={`Enter metrics for ${label}`} onSubmit={submit} noValidate>
      <p className="scp-field__hint" style={{ margin: 0 }}>Type in the numbers the network shows for {label}. Reach is required; leave a number blank when the network does not show it.</p>
      <div className="scp-metrics__fields">
        <Field id={`${id}-at`} label="Captured at" error={errors.capturedAt}>
          <input id={`${id}-at`} className="scp-input" type="datetime-local" value={form.capturedAt} onChange={(e) => set("capturedAt", e.target.value)} {...aria(errors.capturedAt, `${id}-at`)} />
        </Field>
        {FORM_COUNTERS.map((k) => (
          <Field key={k} id={`${id}-${k}`} label={k === "reach" ? "Reach (required)" : COUNTER_LABEL[k]} error={errors[k]}>
            <input
              id={`${id}-${k}`} className="scp-input" type="text" inputMode="numeric" autoComplete="off" value={form.values[k]}
              onChange={(e) => set(k, e.target.value)} {...aria(errors[k], `${id}-${k}`)}
            />
          </Field>
        ))}
      </div>
      <div className="scp-row__buttons">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>{pending ? "Saving…" : "Save metrics"}</button>
      </div>
      {refusal && <RefusalNote refusal={refusal.refusal} message={refusal.message} />}
    </form>
  );
}

const aria = (error: string | undefined, id: string) => (error ? { "aria-invalid": true as const, "aria-describedby": `${id}-err` } : {});

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="scp-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error && <span id={`${id}-err`} className="scp-msg scp-msg--error" role="alert">{error}</span>}
    </div>
  );
}
