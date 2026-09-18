import { NextResponse } from "next/server";
import { accounts, db } from "@/db";
import { syncAccount } from "@/lib/gmail";

export const maxDuration = 300;

export async function POST() {
  const all = await db.select().from(accounts);
  const results = await Promise.allSettled(all.map((a) => syncAccount(a)));
  const report = results.map((r, i) =>
    r.status === "fulfilled"
      ? { ok: true, ...r.value }
      : { email: all[i].email, ok: false, error: String((r.reason as Error)?.message ?? r.reason) },
  );
  return NextResponse.json(report);
}
