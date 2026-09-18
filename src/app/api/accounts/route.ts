import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { accounts, db } from "@/db";

export async function GET() {
  const rows = await db
    .select({
      id: accounts.id,
      email: accounts.email,
      color: accounts.color,
      lastSyncedAt: accounts.lastSyncedAt,
    })
    .from(accounts)
    .orderBy(asc(accounts.createdAt));
  return NextResponse.json(rows);
}
