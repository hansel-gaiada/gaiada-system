// SCP-5e (BFF §63.26): the content bank's read side: the client picker, the collections as mosaics, the filters as links and one collection's entries. Pure over what the page read: the filters and the
// page cursor are links (they go in the page's query), so the lists need no script; only a STORED item is a client component (`SavedItemCard`, which edits and deletes). An empty list is only ever
// said when the read SUCCEEDED; the page turns a refused or failed read into its own sentence before it gets here. A design's photo, an approved post and a hashtag set are READ from where they live:
// they are drawn here and never edited (the post links to its page, the hashtag sets to the brand book). Colour is never the only signal: used, unused and source are written beside every item.
import Link from "next/link";
import { SimulatedMark } from "./SimulatedMark";
import { SavedItemCard } from "./SavedItemCard";
import { statusLabel } from "@/lib/socialPipeline";
import { clientHref, monthTitle } from "@/lib/socialClient";
import {
  HASHTAGS_KEY, MEDIA_LABEL, filtersFor, fileHref, hasFilter, imageHref, photoKindWords, photoUseWords, previewKind, savedHref, sourceWords,
  type SavedCollection, type SavedEntries, type SavedItem, type SavedPhoto, type SavedView,
} from "@/lib/socialSaved";
import { SOURCES, SOURCE_LABEL } from "@/lib/socialPipeline";
import "./cycles.css";
import "./reports.css";
import "./saved.css";

export interface PickerClient { engagementId: string; clientName: string; mine: boolean }

/** The clients, the caller's first. The chosen one is marked in words for a screen reader as well as by its look. */
export function SavedClientPicker({ deptId, clients, current }: { deptId: string; clients: readonly PickerClient[]; current: string }) {
  return (
    <nav className="scp-saved__clients" aria-label="Clients">
      <span>Client</span>
      {clients.map((c) => (
        <Link key={c.engagementId} className="scp-saved__chip" href={savedHref(deptId, { client: c.engagementId })} aria-current={c.engagementId === current ? "true" : undefined}>
          {c.clientName}{c.mine ? " (yours)" : ""}
        </Link>
      ))}
    </nav>
  );
}

const countWords = (n: number, key: string): string => (key === HASHTAGS_KEY ? (n === 1 ? "1 set" : `${n} sets`) : n === 1 ? "1 item" : `${n} items`);

/** The collections as mosaics: label, count and up to four previews (images, thumbnails or the newest titles). */
export function SavedCollectionTiles({ deptId, client, collections, open }: { deptId: string; client: string; collections: readonly SavedCollection[]; open: string | null }) {
  return (
    <ul className="scp-saved__mosaic" aria-label="Collections">
      {collections.map((c) => {
        const kind = previewKind(c);
        return (
          <li key={c.key}>
            <Link className="scp-saved__tile" href={savedHref(deptId, { client, collection: c.key })} aria-current={open === c.key ? "true" : undefined}>
              <h3 className="scp-saved__tile-title">{c.label}</h3>
              <span className="scp-saved__tile-count">{countWords(c.count, c.key)}{c.derived ? " · read from the designs and the brand book" : ""}</span>
              {c.count === 0 ? <span className="scp-saved__tile-count">Nothing here yet</span> : kind === "text" ? (
                <ul className="scp-saved__titles">{c.previews.slice(0, 3).map((p, i) => <li key={`${p}-${i}`}>{p}</li>)}</ul>
              ) : (
                <span className="scp-saved__previews" aria-hidden="true">
                  {c.previews.slice(0, 4).map((p) => (
                    <span key={p} className="scp-saved__preview">
                      {/* eslint-disable-next-line @next/next/no-img-element -- the asset and file routes stream the stored bytes; the tile's name carries the collection */}
                      <img src={kind === "asset" ? imageHref(p) : fileHref(p)} alt="" loading="lazy" decoding="async" />
                    </span>
                  ))}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** The filters as links that keep the others: pillar (from the brand book), used or unused, and source. A filter the collection does not support is not drawn. */
export function SavedFilters({ deptId, client, collection, view, pillars }: { deptId: string; client: string; collection: SavedCollection; view: SavedView; pillars: readonly string[] }) {
  const f = filtersFor(collection);
  if (!f.pillar && !f.used && !f.source) return null;
  const to = (o: Partial<SavedView>) => savedHref(deptId, { client, collection: collection.key, pillar: view.pillar, used: view.used, source: view.source, ...o, cursor: null });
  const pillarList = [...new Set([...(view.pillar && !pillars.includes(view.pillar) ? [view.pillar] : []), ...pillars])];
  return (
    <nav className="scp-saved__filters" aria-label="Filter this collection">
      {f.pillar && (
        <div className="scp-saved__filter" role="group" aria-label="Pillar">
          <span>Pillar</span>
          <Link className="scp-saved__chip" href={to({ pillar: null })} aria-current={view.pillar === null ? "true" : undefined}>All</Link>
          {pillarList.map((p) => <Link key={p} className="scp-saved__chip" href={to({ pillar: p })} aria-current={view.pillar === p ? "true" : undefined}>{p}</Link>)}
        </div>
      )}
      {f.used && (
        <div className="scp-saved__filter" role="group" aria-label="Used">
          <span>Used</span>
          <Link className="scp-saved__chip" href={to({ used: null })} aria-current={view.used === null ? "true" : undefined}>All</Link>
          <Link className="scp-saved__chip" href={to({ used: true })} aria-current={view.used === true ? "true" : undefined}>Used</Link>
          <Link className="scp-saved__chip" href={to({ used: false })} aria-current={view.used === false ? "true" : undefined}>Not used yet</Link>
        </div>
      )}
      {f.source && (
        <div className="scp-saved__filter" role="group" aria-label="Source">
          <span>Source</span>
          <Link className="scp-saved__chip" href={to({ source: null })} aria-current={view.source === null ? "true" : undefined}>All</Link>
          {SOURCES.map((s) => <Link key={s} className="scp-saved__chip" href={to({ source: s })} aria-current={view.source === s ? "true" : undefined}>{SOURCE_LABEL[s]}</Link>)}
        </div>
      )}
    </nav>
  );
}

const asItem = (p: SavedPhoto, id: string): SavedItem => ({
  id, category: "photos", holds: p.holds, title: p.title, body: null, url: p.url, media: p.media, asset: p.asset, source: p.source, aiNote: p.aiNote, pillar: p.pillar,
  useCount: 0, lastUsedAt: null, used: p.used, addedBy: p.addedBy, addedAt: p.addedAt,
});

function PhotoTile({ p }: { p: SavedPhoto }) {
  return (
    <article className="scp-saved__card" aria-label={p.title}>
      <span className="scp-saved__media">
        <span className="scp-saved__ph" aria-hidden="true">{p.title}</span>
        {/* eslint-disable-next-line @next/next/no-img-element -- the asset route streams the stored bytes; the card's title names it */}
        {p.asset && <img src={imageHref(p.asset.versionId)} alt="" loading="lazy" decoding="async" />}
      </span>
      <h4 className="scp-saved__title">{p.title}</h4>
      <p className="scp-saved__meta">
        <span className="scp-saved__badge">{photoKindWords(p)}</span>
        <span className={p.used ? "scp-saved__badge scp-saved__badge--used" : "scp-saved__badge"}>{photoUseWords(p)}</span>
        <span>{sourceWords(p.source)}</span>
        {p.pillar && <span>Pillar: {p.pillar}</span>}
      </p>
      {p.aiNote && <p className="scp-saved__meta">AI note: {p.aiNote}</p>}
      <p className="scp-field__hint">Read from the designs of this client&apos;s posts: it is changed on the post, not here.</p>
    </article>
  );
}

export interface EntriesProps {
  deptId: string;
  client: string;
  collection: SavedCollection;
  entries: SavedEntries;
  nextCursor: string | null;
  view: SavedView;
  viewerId: string;
  pillars: readonly string[];
  collections: readonly SavedCollection[];
}

/** One collection's entries: photos and posts as a grid, the rest as a list, with the page link and an empty state in words. */
export function SavedEntriesView({ deptId, client, collection, entries, nextCursor, view, viewerId, pillars, collections }: EntriesProps) {
  const filtered = hasFilter(view);
  const clear = savedHref(deptId, { client, collection: collection.key });
  const empty = entries.items.length === 0;
  const first = view.cursor === null;
  return (
    <section aria-label={collection.label} className="scp-saved">
      <h3 className="scp-section__title">{collection.label}</h3>
      {empty ? (
        <p className="scp-note" role="status">
          {filtered ? "Nothing in this collection matches the filter." : first ? `Nothing in ${collection.label} yet.` : "That is the end of the list."}
          {" "}
          {filtered ? <Link className="scp-link" href={clear}>Show everything in {collection.label}</Link> : !first ? <Link className="scp-link" href={clear}>Back to the first page</Link> : null}
        </p>
      ) : entries.kind === "photos" ? (
        <ul className="scp-saved__grid" aria-label={collection.label}>
          {entries.items.map((p) => (
            <li key={p.key}>
              {p.savedItemId
                ? <SavedItemCard item={asItem(p, p.savedItemId)} viewerId={viewerId} pillars={pillars} collections={collections} usedWords={photoUseWords(p)} onGrid />
                : <PhotoTile p={p} />}
            </li>
          ))}
        </ul>
      ) : entries.kind === "posts" ? (
        <ul className="scp-saved__grid" aria-label={collection.label}>
          {entries.items.map((p) => (
            <li key={p.postId}>
              <article className="scp-saved__card" aria-label={p.title}>
                <span className="scp-saved__media">
                  <span className="scp-saved__ph" aria-hidden="true">{p.title}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element -- the file route streams the stored design; the card's title names the post */}
                  {p.thumbFileId && <img src={fileHref(p.thumbFileId)} alt="" loading="lazy" decoding="async" />}
                </span>
                <h4 className="scp-saved__title"><Link className="scp-link" href={`/departments/${encodeURIComponent(deptId)}/posts/${encodeURIComponent(p.postId)}`}>{p.title}</Link></h4>
                <p className="scp-saved__meta">
                  <span className="scp-saved__badge">{statusLabel(p.pipelineStatus)}</span>
                  {p.format && <span>{p.format}</span>}
                  {p.cycleMonth && <span>{monthTitle(p.cycleMonth)}</span>}
                  {p.simulated && <SimulatedMark of="post" />}
                </p>
              </article>
            </li>
          ))}
        </ul>
      ) : entries.kind === "hashtags" ? (
        <>
          <ul className="scp-saved__list" aria-label={collection.label}>
            {entries.items.map((s) => (
              <li key={s.key} className="scp-saved__card">
                <h4 className="scp-saved__title">{s.name}</h4>
                <ul className="scp-saved__tags" aria-label={`Tags in ${s.name}`}>{s.tags.map((t) => <li key={t} className="scp-saved__tag">#{t.replace(/^#/, "")}</li>)}</ul>
              </li>
            ))}
          </ul>
          <p className="scp-field__hint">Hashtag sets are the client&apos;s brand book. Edit them there, on the <Link className="scp-link" href={clientHref(deptId, client, "brand")}>Client profile</Link> tab.</p>
        </>
      ) : (
        <ul className="scp-saved__list" aria-label={collection.label}>
          {entries.items.map((i) => (
            <li key={i.id}><SavedItemCard item={i} viewerId={viewerId} pillars={pillars} collections={collections} /></li>
          ))}
        </ul>
      )}
      {(nextCursor || !first) && !empty && (
        <p className="scp-saved__more">
          {!first && <Link className="scp-link" href={savedHref(deptId, { client, collection: collection.key, pillar: view.pillar, used: view.used, source: view.source })}>First page</Link>}
          {nextCursor && <Link className="scp-link" href={savedHref(deptId, { client, collection: collection.key, pillar: view.pillar, used: view.used, source: view.source, cursor: nextCursor })}>Next page</Link>}
        </p>
      )}
      {entries.kind === "photos" && entries.items.some((p) => p.media === "video") && <p className="scp-field__hint">{MEDIA_LABEL.video}s are Drive links: the Asset Library stores images only.</p>}
    </section>
  );
}
