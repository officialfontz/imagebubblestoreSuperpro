import { loadVault } from "@/lib/store";
import { storageStatus } from "@/lib/storage";
import { requireAuth } from "@/lib/auth";
import { currentMonth, listCaptureMonths, loadCaptureMonth } from "@/lib/captures";
import { scheduleCaptureSweep } from "@/lib/retention";
import VaultApp from "./components/VaultApp";

export const dynamic = "force-dynamic";

export default async function Page() {
  // proxy.ts already rejected unauthenticated requests at the edge. This is the
  // second layer, so a mis-scoped matcher can never expose the catalog.
  const role = await requireAuth();

  const [data, captures, months] = await Promise.all([
    loadVault(),
    // Only the current month is sent down. Older proof is a click (the month
    // picker) or a search away, and shipping a year of it would undo the whole
    // reason the catalogs are split.
    loadCaptureMonth(currentMonth()).catch(() => null),
    listCaptureMonths().catch(() => [] as string[]),
  ]);

  // Expiry rides on traffic the app already gets; never awaited, so a slow
  // sweep can never hold up a page load.
  scheduleCaptureSweep();

  return (
    <VaultApp
      initialData={data}
      storage={storageStatus()}
      role={role}
      initialCaptures={captures?.captures ?? []}
      captureMonths={months}
    />
  );
}
