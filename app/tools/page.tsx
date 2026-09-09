import { Shell, loadShell } from "../shell";

export const dynamic = "force-dynamic";

export default async function ToolsPage() {
  return <Shell shell={await loadShell()} initialActive="__tools__" />;
}
