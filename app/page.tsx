import { Shell, loadShell } from "./shell";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <Shell shell={await loadShell()} />;
}
