# Skills — what is installed, and what should be

**Inventory taken 2026-08-23** from `/opt/hermes-zen/skills/`. These are **vendor stock skills**;
none are Gaiada-authored. They are not vendored into this repo — this file records what is on the box
and the disposition decision for each.

## Installed today (13, all stock)

| Skill | Relevant to an ERP router seat? | Disposition |
|---|---|---|
| `github` | yes — the WebDev delivery rail uses it | **keep**, tier per the risk ladder |
| `software-development` | yes | **keep** |
| `research` | yes — Zedano frames questions before routing | **keep** |
| `note-taking` | yes — meeting/MOM adjacent | **keep** |
| `email` | maybe — the mail subsystem is PLANNED and approval-only | **hold** until the mail program lands |
| `social-media` | maybe — SMM department overlap; risk of bypassing `dept-smm` | **hold** — belongs to a seat, not the router |
| `creative` | maybe — same overlap with `dept-creative` | **hold** — belongs to a seat |
| `media` | maybe | **hold** |
| `productivity` | unclear, generic | **review** |
| `autonomous-ai-agents` | **no** — the estate's agents come from `agent_registry`, not a skill | **drop** |
| `mlops` | **no** | **drop** |
| `apple` | **no** | **drop** |
| `smart-home` | **no** | **drop** |

## Why this is not cosmetic

`.skills_prompt_snapshot.json` on the box is **41 KB**. That prompt is assembled and carried on
requests, so every call pays context and token cost for skills the seat will never use — including
`apple` and `smart-home` in an ERP.

There is a second, sharper reason. Once Hermes is demoted to **router** (tracker P1), its tool view is
cut to roughly four `agents.*` tools plus a small read set, and the acceptance test is that **it
provably cannot call a PM tool directly**. A skill that grants capability outside that view either
breaks the demotion or is dead weight in the prompt. Both are bad; the second is merely cheaper.

**The department-shaped skills (`social-media`, `creative`, `media`, `email`) belong to department
seats, not to the router.** Leaving them on Zedano recreates the exact defect the whole program
exists to correct: one big agent holding everything.

## The rule

**A skill is capability. Capability is governed by `agent_registry` + the hub tool view + Cerbos —
never by what happens to be installed in a directory on the box.** Skills present but outside the
seat's tool view should be removed rather than left inert, so that the box's contents and the
registry cannot disagree.
