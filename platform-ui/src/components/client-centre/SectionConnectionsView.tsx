import {
  registry,
  settingsDef,
  type CentreDraft,
  type ConnectionEntry,
  type RegistrySection,
} from "@/lib/clientCentre";
import { ConnectionAccordion } from "./ConnectionAccordion";

// An area's Connections part: the no-credentials callout (verbatim) and the tools and accounts this area
// uses, one accordion row each, "Shared · N" where another area uses the same tool.
export function SectionConnectionsView({
  section,
  draft,
  canEdit,
  onConnectionChange,
  onAddCustomConnection,
  onRemoveCustomConnection,
}: {
  section: RegistrySection;
  draft: CentreDraft;
  canEdit: boolean;
  onConnectionChange: (connId: string, patch: Partial<ConnectionEntry>) => void;
  onAddCustomConnection: (name: string) => void;
  onRemoveCustomConnection: (connId: string) => void;
}) {
  const def = settingsDef(registry, draft.businessType, section);
  const customConns = draft.customConnections[section.id] ?? [];

  return (
    <div>
      <div className="cc-callout">
        Don&apos;t enter passwords, API keys or card numbers here. Record the account name or ID and note where the
        credential lives (for example &quot;1Password → Xero&quot;).
      </div>
      <h3 className="cc-sec-h">Connections &amp; data sources</h3>
      <ConnectionAccordion
        sectionId={section.id}
        sectionName={section.name}
        businessType={draft.businessType}
        connectionIds={def.connections}
        connections={draft.connections}
        customConnections={customConns}
        canEdit={canEdit}
        onChange={onConnectionChange}
        onAddCustom={onAddCustomConnection}
        onRemoveCustom={onRemoveCustomConnection}
      />
    </div>
  );
}
