import { notFound } from "next/navigation";
import { Shell, loadShell } from "../../shell";
import { toolBySlug, toolKey } from "@/lib/tools";

export const dynamic = "force-dynamic";

export default async function ToolPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!toolBySlug(slug)) notFound();
  return <Shell shell={await loadShell()} initialActive={toolKey(slug)} />;
}
