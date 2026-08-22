"use client";
import { useState } from "react";
import { DataTable, type Column } from "@/components/data/DataTable";
import { BulkActionBar } from "@/components/data/BulkActionBar";
import { ToastQueueProvider } from "@/components/ToastQueue";
import { bulkDeleteClientsAction } from "@/lib/clientsBulkActions";

// Reference implementation (Phase 4 exit criterion, §8.1: "bulk-action bar ships on at least
// one real list page") wiring DataTable's new `selection` prop + BulkActionBar + the toast
// queue together. Selection state lives HERE, not in DataTable, so it survives DataTable's own
// internal sort/filter/page changes and so this bar can read it — exactly the split the
// component inventory calls for ("row-selection state (client component wrapping DataTable) + a
// floating action bar").
export function ClientsTable({
  columns, rows, canManage, viewKey,
}: {
  columns: Column[];
  rows: Record<string, unknown>[];
  canManage: boolean;
  viewKey?: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const table = (
    <DataTable
      columns={columns}
      rows={rows}
      link={{ base: "/clients", idKey: "id", labelKey: "name" }}
      csvName="clients"
      pageSize={20}
      viewKey={viewKey}
      selection={
        canManage
          ? {
              selectedIds: selected,
              getRowId: (r) => String(r.id),
              onToggle: (id, checked) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (checked) next.add(id); else next.delete(id);
                  return next;
                }),
              onToggleAll: (ids, checked) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
                  return next;
                }),
            }
          : undefined
      }
    />
  );

  if (!canManage) return table;

  return (
    <ToastQueueProvider>
      <BulkActionBar
        selectedIds={[...selected]}
        itemLabel="client"
        onClear={() => setSelected(new Set())}
        actions={[
          {
            key: "delete",
            label: "Delete",
            danger: true,
            confirmMessage: `Delete ${selected.size} client${selected.size === 1 ? "" : "s"}? This can't be undone.`,
            run: (ids) => bulkDeleteClientsAction(ids),
          },
        ]}
      />
      {table}
    </ToastQueueProvider>
  );
}
