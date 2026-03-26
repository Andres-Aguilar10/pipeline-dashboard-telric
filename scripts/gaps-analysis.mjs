import pg from "pg";
const { Client } = pg;
const cert = process.env.DB_SSL_CERT ? Buffer.from(process.env.DB_SSL_CERT, "base64").toString() : undefined;
const key = process.env.DB_SSL_KEY ? Buffer.from(process.env.DB_SSL_KEY, "base64").toString() : undefined;
const client = new Client({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false, cert, key },
});
await client.connect();

const fcWip = (await client.query(`SELECT MAX(fecha_corrida) as fc FROM silver.costo_wip_op`)).rows[0].fc;
const fcDet = (await client.query(`SELECT MAX(fecha_corrida) as fc FROM silver.costo_op_detalle`)).rows[0].fc;

// Total OPs NI/PO activas
const total = (await client.query(`
  SELECT COUNT(DISTINCT pr_id) as n FROM silver.pr
  WHERE TRIM(pol_class) IN ('NI','PO') AND pr_annulment_t IS NULL AND pr_cancelled_t IS NULL
`)).rows[0].n;
console.log(`TOTAL OPs NI/PO activas: ${total}\n`);

// 1. Sin precio
const sinPrecio = (await client.query(`
  SELECT COUNT(DISTINCT pr_id) as n FROM silver.pr
  WHERE TRIM(pol_class) IN ('NI','PO') AND pr_annulment_t IS NULL AND pr_cancelled_t IS NULL
    AND (pol_unit_price = 0 OR pol_unit_price IS NULL)
`)).rows[0].n;
console.log(`1. SIN PRECIO (pol_unit_price=0): ${sinPrecio}`);

// 2. Sin WIPs (pr_id no está en costo_wip_op)
const sinWip = (await client.query(`
  SELECT COUNT(DISTINCT p.pr_id) as n FROM silver.pr p
  WHERE TRIM(p.pol_class) IN ('NI','PO') AND p.pr_annulment_t IS NULL AND p.pr_cancelled_t IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM silver.costo_wip_op w
      WHERE w.fecha_corrida = $1 AND TRIM(w.pr_id) = TRIM(p.pr_id)
    )
`, [fcWip])).rows[0].n;
console.log(`2. SIN DATOS WIP (OP no existe en costo_wip_op): ${sinWip}`);

// 3. Sin detalle costos (cod_ordpro no está en costo_op_detalle)
const sinDetalle = (await client.query(`
  SELECT COUNT(DISTINCT p.pr_id) as n FROM silver.pr p
  WHERE TRIM(p.pol_class) IN ('NI','PO') AND p.pr_annulment_t IS NULL AND p.pr_cancelled_t IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM silver.costo_op_detalle d
      WHERE d.fecha_corrida = $1 AND TRIM(d.cod_ordpro) = TRIM(p.pr_id)
    )
`, [fcDet])).rows[0].n;
console.log(`3. SIN DETALLE COSTOS (OP no existe en costo_op_detalle): ${sinDetalle}`);

// 4. Estilo nuevo (estilo no existe en costo_wip_op => sin historial para cotizar)
const estiloNuevo = (await client.query(`
  SELECT COUNT(DISTINCT p.pr_id) as n FROM silver.pr p
  WHERE TRIM(p.pol_class) IN ('NI','PO') AND p.pr_annulment_t IS NULL AND p.pr_cancelled_t IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM silver.costo_wip_op w
      WHERE w.fecha_corrida = $1 AND TRIM(w.estilo_propio) = TRIM(p.pols_factory_style_id)
    )
`, [fcWip])).rows[0].n;
console.log(`4. ESTILO NUEVO (sin historial en costo_wip_op): ${estiloNuevo}`);

// 5. Sin prendas
const sinPrendas = (await client.query(`
  SELECT COUNT(DISTINCT pr_id) as n FROM silver.pr
  WHERE TRIM(pol_class) IN ('NI','PO') AND pr_annulment_t IS NULL AND pr_cancelled_t IS NULL
    AND (pr_requested_q = 0 OR pr_requested_q IS NULL)
`)).rows[0].n;
console.log(`5. SIN PRENDAS (pr_requested_q=0): ${sinPrendas}`);

// 6. Resumen por marca
const porMarca = await client.query(`
  SELECT TRIM(p.po_customer_name_grp) as brand,
    COUNT(DISTINCT p.pr_id) as total_ops,
    COUNT(DISTINCT p.pr_id) FILTER (
      WHERE p.pol_unit_price = 0 OR p.pol_unit_price IS NULL
    ) as sin_precio,
    COUNT(DISTINCT p.pr_id) FILTER (
      WHERE NOT EXISTS (
        SELECT 1 FROM silver.costo_wip_op w
        WHERE w.fecha_corrida = $1 AND TRIM(w.estilo_propio) = TRIM(p.pols_factory_style_id)
      )
    ) as estilo_nuevo,
    COUNT(DISTINCT p.pr_id) FILTER (
      WHERE NOT EXISTS (
        SELECT 1 FROM silver.costo_op_detalle d
        WHERE d.fecha_corrida = $2 AND TRIM(d.cod_ordpro) = TRIM(p.pr_id)
      )
    ) as sin_detalle,
    COUNT(DISTINCT p.pr_id) FILTER (
      WHERE p.pr_requested_q = 0 OR p.pr_requested_q IS NULL
    ) as sin_prendas
  FROM silver.pr p
  WHERE TRIM(p.pol_class) IN ('NI','PO') AND p.pr_annulment_t IS NULL AND p.pr_cancelled_t IS NULL
  GROUP BY TRIM(p.po_customer_name_grp)
  ORDER BY total_ops DESC
`, [fcWip, fcDet]);

console.log(`\n=== RESUMEN POR MARCA ===`);
console.log(`${"Marca".padEnd(12)} ${"Total".padStart(6)} ${"SinPrec".padStart(8)} ${"EstNuevo".padStart(9)} ${"SinDet".padStart(7)} ${"SinQty".padStart(7)}`);
for (const r of porMarca.rows) {
  console.log(`${(r.brand||"(null)").padEnd(12)} ${String(r.total_ops).padStart(6)} ${String(r.sin_precio).padStart(8)} ${String(r.estilo_nuevo).padStart(9)} ${String(r.sin_detalle).padStart(7)} ${String(r.sin_prendas).padStart(7)}`);
}

// 7. OPs con WIP costo = 0
const wipCero = (await client.query(`
  SELECT COUNT(DISTINCT pr_id) as n FROM silver.costo_wip_op
  WHERE fecha_corrida = $1
    AND (costo_manufactura = 0 OR costo_manufactura IS NULL)
    AND (costo_textil = 0 OR costo_textil IS NULL)
`, [fcWip])).rows[0].n;
console.log(`\n7. OPs con WIP pero costos manufactura+textil = 0: ${wipCero}`);

// 8. Overlap analysis: how many OPs have MULTIPLE issues
const overlap = await client.query(`
  SELECT
    CASE WHEN p.pol_unit_price = 0 OR p.pol_unit_price IS NULL THEN 1 ELSE 0 END as no_price,
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM silver.costo_wip_op w WHERE w.fecha_corrida = $1 AND TRIM(w.estilo_propio) = TRIM(p.pols_factory_style_id)
    ) THEN 1 ELSE 0 END as no_cotiz,
    COUNT(DISTINCT p.pr_id) as n
  FROM silver.pr p
  WHERE TRIM(p.pol_class) IN ('NI','PO') AND p.pr_annulment_t IS NULL AND p.pr_cancelled_t IS NULL
  GROUP BY 1, 2
  ORDER BY 1, 2
`, [fcWip]);
console.log(`\n=== CRUCE: Precio vs Cotizador ===`);
for (const r of overlap.rows) {
  const lbl = `precio=${r.no_price ? 'NO' : 'SI'} cotiz=${r.no_cotiz ? 'NO' : 'SI'}`;
  console.log(`  ${lbl}: ${r.n} OPs`);
}

await client.end();
