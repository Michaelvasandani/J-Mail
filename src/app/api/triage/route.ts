import { NextRequest, NextResponse } from "next/server";
import { retriageAll, triageEnabled, triageMessages } from "@/lib/triage";

export const maxDuration = 300;

/**
 * POST /api/triage          → label any messages that don't have labels yet
 * POST /api/triage?reset=1  → drop all labels and re-label recent messages (after changing questions)
 */
export async function POST(req: NextRequest) {
  if (!triageEnabled()) {
    return NextResponse.json({ error: "TYPESAFE_API_KEY is not set" }, { status: 503 });
  }
  const reset = new URL(req.url).searchParams.get("reset") === "1";
  const result = reset ? await retriageAll() : await triageMessages([]);
  return NextResponse.json(result);
}
