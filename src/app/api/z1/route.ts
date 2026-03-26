import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { Z1_QUERY } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const rows = await query(Z1_QUERY);
    return NextResponse.json(rows, {
      headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=7200" },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("z1 error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
