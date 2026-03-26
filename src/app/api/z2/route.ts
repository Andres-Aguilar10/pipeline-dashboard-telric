import { NextRequest, NextResponse } from "next/server";
import { queryParams } from "@/lib/db";

export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const orderId = req.nextUrl.searchParams.get("order_id");
  if (!orderId) {
    return NextResponse.json({ error: "order_id requerido" }, { status: 400 });
  }

  try {
    const rows = await queryParams(
      "SELECT * FROM silver.z2_reporte WHERE order_id = $1 ORDER BY sku_category_id, sku_id",
      [orderId]
    );
    return NextResponse.json(rows, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error desconocido";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
