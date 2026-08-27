import { loadVault } from "@/lib/store";
import { storageStatus } from "@/lib/storage";
import { requireAuth } from "@/lib/auth";
import VaultApp from "./components/VaultApp";

export const dynamic = "force-dynamic";

export default async function Page() {
  // proxy.ts already rejected unauthenticated requests at the edge. This is the
  // second layer, so a mis-scoped matcher can never expose the catalog.
  await requireAuth();

  const data = await loadVault();
  return <VaultApp initialData={data} storage={storageStatus()} />;
}
