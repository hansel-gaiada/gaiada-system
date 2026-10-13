"use client";
// DW-5b — the "Shared campaign" cell of the Social campaigns screen: where a social campaign is linked into a shared
// campaign's part, and the controls to link it or unlink it (contract §31.4 links). The choices are the shared campaigns
// where THIS department has a part. The server decides (part update plus read on the child); a refusal such as
// `already_linked` is shown as a sentence.
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { linkToPartAction, unlinkFromPartAction } from "@/lib/campaignActions";
import type { OurPartChoice, SocialLinkRef } from "@/lib/campaigns";
import "@/components/agency/campaigns.css";

export function SocialCampaignLink({
  socialCampaignId, linked, linkStatus, choices,
}: {
  socialCampaignId: string;
  /** The shared campaign this one is linked into; null when it is not linked. */
  linked: SocialLinkRef | null;
  /** `unknown` when the shared campaigns' links could not all be read: "not linked" would then be a guess. */
  linkStatus: "known" | "unknown";
  choices: OurPartChoice[];
}) {
  const router = useRouter();
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(fn: () => ReturnType<typeof linkToPartAction>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) return setError(res.error);
      setPick("");
      router.refresh();
    });
  }

  if (linked) {
    return (
      <span className="cmp-inline">
        <Link href={`/agency/${linked.sharedCampaignId}`}>{linked.sharedCampaignName}</Link>
        <Button
          variant="ghost" size="sm" disabled={pending}
          onClick={() => run(() => unlinkFromPartAction(linked.sharedCampaignId, linked.partId, "social_campaign", socialCampaignId))}
        >
          {pending ? "Unlinking…" : "Unlink"}
        </Button>
        {error && <span className="cmp-error" role="alert">{error}</span>}
      </span>
    );
  }
  if (linkStatus === "unknown") return <span className="cmp-note">Link status unavailable</span>;
  if (choices.length === 0) {
    return <span className="cmp-note">Not linked. This department has no part in a shared campaign to link it to.</span>;
  }
  const chosen = choices.find((c) => c.partId === pick);
  return (
    <span className="cmp-inline">
      <select
        className="cmp-select" value={pick} onChange={(e) => setPick(e.target.value)} disabled={pending}
        aria-label="Link to a shared campaign"
      >
        <option value="">Link to a shared campaign…</option>
        {choices.map((c) => (
          <option key={c.partId} value={c.partId}>
            {c.campaignName}{c.partStatus === "cancelled" ? " (our part is cancelled)" : ""}
          </option>
        ))}
      </select>
      <Button
        variant="ghost" size="sm" disabled={pending || !chosen}
        onClick={() => chosen && run(() => linkToPartAction(chosen.campaignId, chosen.partId, "social_campaign", socialCampaignId))}
      >
        {pending ? "Linking…" : "Link"}
      </Button>
      {error && <span className="cmp-error" role="alert">{error}</span>}
    </span>
  );
}
