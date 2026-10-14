import { PageHeader } from "@/components/PageHeader";

// DW-8b: the Inbox is its own row in You, not a Me tab, so it carries its own title (the Me layout draws none here).
export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader eyebrow="You" title="Inbox" />
      {children}
    </>
  );
}
