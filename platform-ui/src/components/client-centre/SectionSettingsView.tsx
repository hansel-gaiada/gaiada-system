import {
  registry,
  settingsDef,
  groupedFields,
  fieldsFilledCount,
  connectionIdsFor,
  connectionsConnectedCount,
  type CentreDraft,
  type ConnectionEntry,
  type RegistrySection,
} from "@/lib/clientCentre";
import { FieldControl } from "./FieldControl";
import { ConnectionAccordion } from "./ConnectionAccordion";
import { Breadcrumb } from "./Breadcrumb";

// CMC's `renderSettings`: lede + the no-credentials callout (verbatim) + stats + fields grouped by
// `fieldGroups` order, each carrying its "Shared · N" + help text + connections accordion.
export function SectionSettingsView({
  clientName,
  section,
  crumbs,
  draft,
  canEdit,
  onFieldChange,
  onConnectionChange,
  onAddCustomConnection,
  onRemoveCustomConnection,
}: {
  clientName: string;
  section: RegistrySection;
  crumbs: string[];
  draft: CentreDraft;
  canEdit: boolean;
  onFieldChange: (key: string, value: string) => void;
  onConnectionChange: (connId: string, patch: Partial<ConnectionEntry>) => void;
  onAddCustomConnection: (name: string) => void;
  onRemoveCustomConnection: (connId: string) => void;
}) {
  const def = settingsDef(registry, section);
  const customConns = draft.customConnections[section.id] ?? [];
  const connIds = connectionIdsFor(section.id, def, draft.customConnections);
  const filled = fieldsFilledCount(draft.profile, def.fields);
  const connected = connectionsConnectedCount(draft.connections, connIds);

  return (
    <div className="cc-content">
      <Breadcrumb items={[...crumbs, "Settings"]} />
      <div className="cc-head-row"><h1>{section.name} settings</h1></div>
      <p className="cc-lede">
        What a {section.name.toLowerCase()} specialist needs to know to run this section for {clientName}. Fields
        marked <em className="cc-shared">Shared</em> are the same value across every section that uses them.
        Changes save automatically.
      </p>
      <div className="cc-stats">
        <div className="cc-stat"><b>{filled}<span className="cc-stat__of">/{def.fields.length}</span></b><span>setup fields completed</span></div>
        <div className="cc-stat"><b>{connected}<span className="cc-stat__of">/{connIds.length}</span></b><span>connections connected</span></div>
      </div>
      <div className="cc-callout">
        Don&apos;t enter passwords, API keys or card numbers here. Record the account name or ID and note where the
        credential lives (for example &quot;1Password → Xero&quot;).
      </div>

      {groupedFields(registry, def.fields).map(([group, keys]) => (
        <div key={group}>
          <h2 className="cc-sec-h">{group}</h2>
          <div className="cc-form">
            {keys.map((k) => (
              <FieldControl
                key={k}
                fieldKey={k}
                value={draft.profile[k] ?? ""}
                businessType={draft.businessType}
                excludeSectionId={section.id}
                canEdit={canEdit}
                onChange={onFieldChange}
              />
            ))}
          </div>
        </div>
      ))}

      <h2 className="cc-sec-h">Connections &amp; data sources</h2>
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
