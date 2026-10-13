import {
  registry,
  settingsDef,
  groupedFields,
  type CentreDraft,
  type RegistrySection,
} from "@/lib/clientCentre";
import { FieldControl } from "./FieldControl";

// An area's Setup part: the fields this area's specialist needs, grouped by `fieldGroups` order, each
// carrying its "Shared · N" badge and help text. Changes save automatically (see `useCentreAutosave`).
export function SectionSetupView({
  clientName,
  section,
  draft,
  canEdit,
  onFieldChange,
}: {
  clientName: string;
  section: RegistrySection;
  draft: CentreDraft;
  canEdit: boolean;
  onFieldChange: (key: string, value: string) => void;
}) {
  const def = settingsDef(registry, draft.businessType, section);
  const groups = groupedFields(registry, def.fields);

  return (
    <div>
      <p className="cc-lede">
        What a {section.name.toLowerCase()} specialist needs to know to work for {clientName}. Fields
        marked <em className="cc-shared">Shared</em> hold the same value in every area that uses them.
        Changes save automatically.
      </p>
      {groups.length === 0 && <p className="cc-lede">This area has no setup fields.</p>}
      {groups.map(([group, keys]) => (
        <div key={group}>
          <h3 className="cc-sec-h">{group}</h3>
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
    </div>
  );
}
