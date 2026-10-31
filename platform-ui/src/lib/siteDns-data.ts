import "server-only";
// M6-P6i + M6-P6p — the site console's DNS card: the two server reads. GET sites/:id/dns and GET sites/:id/dns/task (FRONTEND-BFF-CONTRACT).
// Independent on purpose: each returns its own `DnsRead`, so one failing never hides the other. A failure is a sentence, never an empty
// checklist and never "no task": `state: "none"` is drawn only for an answer that said so.
import { platformFetch, PlatformError } from "./platform";
import {
  SiteDnsShapeError, dnsDriftSentence, dnsReadSentence, parseSiteDns, parseSiteDnsTask, type DnsRead, type SiteDns, type SiteDnsTask,
} from "./siteDnsModel";

async function read<T>(what: string, path: string, userId: string, parse: (b: unknown) => T): Promise<DnsRead<T>> {
  try {
    return { state: "ok", data: parse(await platformFetch<unknown>(path, userId)) };
  } catch (e) {
    if (e instanceof SiteDnsShapeError) return { state: "unavailable", kind: "unavailable", message: dnsDriftSentence(what, e.message) };
    if (e instanceof PlatformError) {
      return { state: "unavailable", kind: e.status === 403 ? "forbidden" : "unavailable", message: dnsReadSentence(what, e.status) };
    }
    return { state: "unavailable", kind: "unavailable", message: dnsReadSentence(what, 0) };
  }
}

const root = (company: string, siteId: string) => `/api/${encodeURIComponent(company)}/modules/webdev/sites/${encodeURIComponent(siteId)}/dns`;

/** `siteId` is the `webdev_sites` registry row id: the id the portfolio read gives each site (`console/portfolio` rows are `webdev_sites` rows). */
export const readSiteDns = (userId: string, company: string, siteId: string): Promise<DnsRead<SiteDns>> =>
  read("The DNS checklist", root(company, siteId), userId, parseSiteDns);

export const readSiteDnsTask = (userId: string, company: string, siteId: string): Promise<DnsRead<SiteDnsTask>> =>
  read("The DNS task", `${root(company, siteId)}/task`, userId, (b) => parseSiteDnsTask(b));
