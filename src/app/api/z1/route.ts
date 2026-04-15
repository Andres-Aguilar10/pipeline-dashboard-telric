import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// In-memory cache TTL 10 min
const CACHE_TTL_MS = 10 * 60 * 1000;
let z1Cache: { data: unknown; timestamp: number } | null = null;

export async function GET() {
  try {
    if (z1Cache && Date.now() - z1Cache.timestamp < CACHE_TTL_MS) {
      return NextResponse.json(z1Cache.data, {
        headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1800", "X-Cache": "HIT" },
      });
    }
    const rows = await query(`SELECT * FROM silver.z1_reporte ORDER BY order_id, process_id`);
    z1Cache = { data: rows, timestamp: Date.now() };
    return NextResponse.json(rows, {
      headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1800", "X-Cache": "MISS" },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("z1 error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
