import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// In-memory cache TTL 10 min (igual que David)
const CACHE_TTL_MS = 10 * 60 * 1000;
let z0Cache: { data: unknown; timestamp: number } | null = null;

/**
 * Universo completo del pipeline (NI, IN, PO)
 * Base: silver.z0_reporte
 * Enriquecido con POST_ACABADO (WIP 49 cerrado) para OPs en IN
 */
export async function GET() {
  try {
    if (z0Cache && Date.now() - z0Cache.timestamp < CACHE_TTL_MS) {
      return NextResponse.json(z0Cache.data, {
        headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1800", "X-Cache": "HIT" },
      });
    }

    const resultRows = await query(`
      WITH acabado_done AS (
        SELECT DISTINCT pr_id
        FROM silver.wip_real
        WHERE wip_id = '49' AND end_ts IS NOT NULL
      )
      SELECT
        z.*,
        CASE
          WHEN z.status = 'IN' AND ad.pr_id IS NOT NULL THEN 'POST_ACABADO'
          ELSE z.status
        END AS status_final,
        CASE WHEN ad.pr_id IS NOT NULL THEN true ELSE false END AS acabado_completed
      FROM silver.z0_reporte z
      LEFT JOIN acabado_done ad ON ad.pr_id = z.order_id::text
      ORDER BY z.order_id
    `);

    // Sobreescribir status con status_final y limpiar campo auxiliar
    const rows = (resultRows as Record<string, unknown>[]).map((r) => {
      const { status_final, ...rest } = r;
      return { ...rest, status: status_final };
    });

    z0Cache = { data: rows, timestamp: Date.now() };
    return NextResponse.json(rows, {
      headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1800", "X-Cache": "MISS" },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("z0 error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
