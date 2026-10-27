// SCP-1e (plan §1) — the eight steps a post goes through, as a row of words: Draft, Proofread, HoD approval, Creative, Final check, Client, Schedule, Live. The steps
// and where a post sits on them come from `lib/socialPipeline.ts` (`STEPS`, `stepOf`), which reads the fixture twin: a post in changes sits at the step of whoever
// holds it, a blocked post at the step it was blocked from, and either says so beside the step. A finished step is "Done" to a screen reader, the current one is
// `aria-current="step"`: the position is never colour alone.
import { STEPS, stepOf, type PipelinePost } from "@/lib/socialPipeline";

export function PostStepper({ post }: { post: PipelinePost }) {
  const { index, side } = stepOf(post);
  return (
    <ol className="scp-stepper" aria-label="The post's steps">
      {STEPS.map((s, i) => {
        const state = i < index || (i === index && post.pipelineStatus === "live") ? "done" : i === index ? "current" : "todo";
        return (
          <li
            key={s.key}
            className={`scp-stepper__step scp-stepper__step--${state}${state === "current" && side === "blocked" ? " scp-stepper__step--blocked" : ""}`}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="scp-stepper__dot" aria-hidden="true" />
            <span>{s.label}</span>
            {state === "done" && <span className="scp-sr">, done</span>}
            {state === "current" && side && <span className="scp-stepper__side">{side === "changes" ? "Changes asked" : "Blocked"}</span>}
          </li>
        );
      })}
    </ol>
  );
}
