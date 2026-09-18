import { NextResponse } from "next/server";
import { accounts, db } from "@/db";
import { syncAccount } from "@/lib/gmail";
import { triageEnabled, triageMessages } from "@/lib/triage";

export const maxDuration = 300;

export async function POST() {
  const all = await db.select().from(accounts);
  const results = await Promise.allSettled(all.map((a) => syncAccount(a)));
  const report = results.map((r, i) =>
    r.status === "fulfilled"
      ? { ok: true as const, email: r.value.email, added: r.value.added, mode: r.value.mode }
      : { ok: false as const, email: all[i].email, error: String((r.reason as Error)?.message ?? r.reason) },
  );

  // Triage newly synced messages (plus a bounded backfill of anything not yet labeled) with Jev.
  const newIds = results.flatMap((r) => (r.status === "fulfilled" ? r.value.addedIds : []));
  let triage: { enabled: boolean; triaged: number; failed: number; error?: string } = {
    enabled: triageEnabled(),
    triaged: 0,
    failed: 0,
  };
  if (triage.enabled) {
    try {
      triage = { ...triage, ...(await triageMessages(newIds)) };
    } catch (err) {
      triage.error = String((err as Error)?.message ?? err);
    }
  }

  return NextResponse.json({ accounts: report, triage });
}
