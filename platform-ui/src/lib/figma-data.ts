import "server-only";
// DW-6k UI: the readers behind the Designs section and the Figma block of Tools & connections (BFF §36.5, §36.8). Each returns a
// `ReadResult`: a refusal or a failed read is DATA the page renders in words, never an empty list that reads as "no designs".
// A link read also carries `figmaConnected`, so "Figma isn't connected" is said by the page and never inferred from an empty list.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import {
  connectionPath, linksPath, normalizeConnection, normalizeLinks,
  type FigmaConnection, type FigmaLinks, type FigmaTargetKind,
} from "./figma";

/** `GET figma-links?targetKind=&targetId=`: the target's links, each refreshed first by the server when its cache is due. */
export const readFigmaLinks = (u: string, t: string, kind: FigmaTargetKind, targetId: string): Promise<ReadResult<FigmaLinks>> =>
  readResult(
    platformFetch<unknown>(linksPath(t, kind, targetId), u).then((raw) => {
      const l = normalizeLinks(raw);
      if (!l) throw new Error("The Figma links read returned an unexpected answer.");
      return l;
    }),
  );

/** `GET integrations/figma`: whether the company has a token linked and of which kind. Never the token. */
export const readFigmaConnection = (u: string, t: string): Promise<ReadResult<FigmaConnection>> =>
  readResult(
    platformFetch<unknown>(connectionPath(t), u).then((raw) => {
      const c = normalizeConnection(raw);
      if (!c) throw new Error("The Figma connection read returned an unexpected answer.");
      return c;
    }),
  );
