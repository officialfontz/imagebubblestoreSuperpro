import { loadVault } from "@/lib/store";
import { storageStatus } from "@/lib/storage";
import { requireAuth } from "@/lib/auth";
import { currentMonth, listCaptureMonths, loadCaptureMonth } from "@/lib/captures";
import { scheduleCaptureSweep } from "@/lib/retention";
import VaultApp from "./components/VaultApp";

export const dynamic = "force-dynamic";

/** Everything the shell needs, loaded once for every route that shows it. */
export async function loadShell() {
  // proxy.ts already rejected unauthenticated requests at the edge. This is the
  // second layer, so a mis-scoped matcher can never expose the catalog.
  const role = await requireAuth();
  const [data, captures, months] = await Promise.all([
    loadVault(),
    loadCaptureMonth(currentMonth()).catch(() => null),
    listCaptureMonths().catch(() => [] as string[]),
  ]);
  scheduleCaptureSweep();
  return { role, data, captures, months };
}

export function Shell({ shell, initialActive }: { shell: Awaited<ReturnType<typeof loadShell>>; initialActive?: string }) {
  return (
    <VaultApp
      initialData={shell.data}
      storage={storageStatus()}
      role={shell.role}
      initialCaptures={shell.captures?.captures ?? []}
      captureMonths={shell.months}
      initialActive={initialActive}
    />
  );
}

export default async function Page() {
  return <Shell shell={await loadShell()} />;
}
