import { PageHeader } from "@/components/PageHeader";

// DW-8j: Mail is a tab of the You block's Inbox row, not a Me tab, so it carries its own title (the Me layout draws no strip here).
export default function MailLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader eyebrow="You" title="Mail" />
      {children}
    </>
  );
}
