import { PageHeader } from "@/components/PageHeader";

// DW-8d: My learning lives in the department's Performance block (plan §8), not among Me's tabs, so it carries its
// own title (the Me layout draws none here).
export default function MyLearningLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader eyebrow="Performance" title="My learning" />
      {children}
    </>
  );
}
