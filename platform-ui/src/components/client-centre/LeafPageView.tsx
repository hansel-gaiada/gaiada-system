import type { RegistryPage } from "@/lib/clientCentre";
import { Breadcrumb } from "./Breadcrumb";

// CMC's leaf-page placeholder, verbatim copy.
export function LeafPageView({ clientName, page, crumbs }: { clientName: string; page: RegistryPage; crumbs: string[] }) {
  return (
    <div className="cc-content">
      <Breadcrumb items={crumbs} />
      <h1>{page.name}</h1>
      <div className="cc-soon">
        <span className="cc-soon__tag">Coming soon</span>
        <h2>This page is being built</h2>
        <p>
          You&apos;ll be able to manage {page.name.toLowerCase()} for {clientName} here — status, providers, owners,
          notes and documents.
        </p>
      </div>
    </div>
  );
}
