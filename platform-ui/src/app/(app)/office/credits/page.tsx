import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { PageHeader } from "@/components/PageHeader";
import { Card, Eyebrow } from "@/components/ui";
import { OFFICE_ASSET_CREDITS, OFFICE_CREDIT_AUTHORS } from "@/lib/office-credits";
import "@/components/office/office.css";

// The attribution surface legal/asset-licences.md obliges: "a credits surface must ship with the
// feature, not after it... generated from the repo's own credit data, not hand-maintained." Every
// fact rendered below (which files, which authors, which licence) comes from
// lib/office-credits.generated.ts, produced by `npm run gen:office-credits` against the LPC
// project's own CREDITS.csv — nothing on this page is typed by hand except the surrounding prose.
export const metadata = { title: "Sprite credits" };

export default async function OfficeCreditsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  return (
    <>
      <PageHeader title="Sprite credits" breadcrumbs={[{ label: "The Office", href: "/office" }]} />

      <Card
        title="Where the art comes from"
        hint="The Office's human and internal-agent avatars use the Universal LPC Spritesheet Character Generator asset set."
      >
        <p className="office-credits__lede">
          Character art is drawn from the{" "}
          <a href="https://github.com/liberatedpixelcup/Universal-LPC-Spritesheet-Character-Generator" target="_blank" rel="noreferrer">
            Universal LPC Spritesheet Character Generator
          </a>{" "}
          project. Every asset in that library is multi-licensed; per{" "}
          <code>legal/asset-licences.md</code>, this estate elects <strong>OGA-BY 3.0</strong> wherever it is
          offered and <strong>CC0</strong> where that is the only free option — never the CC-BY-SA/GPL routes
          the same files also offer, so nothing here carries a share-alike obligation onto this codebase.
          OGA-BY still requires attribution, which is what this page exists to give: the author, the
          licence, and a link to the source, for every one of the 24 files shipped.
        </p>
      </Card>

      <Card title={`Contributing artists (${OFFICE_CREDIT_AUTHORS.length})`}>
        <ul className="office-credits__authors">
          {OFFICE_CREDIT_AUTHORS.map((author) => (
            <li key={author}>{author}</li>
          ))}
        </ul>
      </Card>

      <Card title={`Assets shipped (${OFFICE_ASSET_CREDITS.length})`} hint="Each asset ships as two files, walk.png and sit.png, sharing one licence and author list.">
        <div className="office-credits__table-wrap">
          <table className="office-credits__table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Licence</th>
                <th>Authors</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {OFFICE_ASSET_CREDITS.map((a) => (
                <tr key={a.asset}>
                  <td><code>{a.asset}</code></td>
                  <td>
                    <Eyebrow className="office-credits__licence">{a.licence}</Eyebrow>
                  </td>
                  <td>{a.authors.join(", ")}</td>
                  <td><a href={a.url} target="_blank" rel="noreferrer">View →</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
