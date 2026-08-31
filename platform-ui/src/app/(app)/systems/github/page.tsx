import { redirect } from "next/navigation";

// MOVED 2026-08-31 (owner decision) — the org-wide GitHub registry now lives on the Web Dev
// department's Repositories tab, alongside the pipeline-provisioned inventory it is the superset of.
//
// WHY, and it is worth keeping the reason: Web Dev already owns Repositories / Sites / Portfolio.
// Having a second "Sites & Repos" under Systems meant two pages with the same name and different
// data, and the intuitive one was the empty one. That is not hypothetical — on the first real look at
// the shipped feature, the operator opened `/departments/d-webdev/repositories`, saw only the
// pipeline list, and reasonably concluded the 221-repo crawl had not populated anything.
//
// This route is kept as a REDIRECT rather than deleted. It was live for several releases, it is in
// this session's transcript and in the blueprint's §5.4 prose, and a 404 on a path someone has open
// in a tab teaches them nothing. The redirect teaches them where it went.
//
// `d-webdev` is the Web Dev department's stable route id (the same one the tab set is keyed on).
export default function SystemsGithubMoved() {
  redirect("/departments/d-webdev/repositories");
}
