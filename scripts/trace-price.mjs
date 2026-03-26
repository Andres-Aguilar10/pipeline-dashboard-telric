import pg from "pg";
const { Client } = pg;

const cert = process.env.DB_SSL_CERT
  ? Buffer.from(process.env.DB_SSL_CERT, "base64").toString()
  : undefined;
const key = process.env.DB_SSL_KEY
  ? Buffer.from(process.env.DB_SSL_KEY, "base64").toString()
  : undefined;

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false, cert, key },
});

await client.connect();

// OP 88847 from silver.pr: po_id=LULFA26-0542, pol_id=001, customer=00438
const poId = "LULFA26-0542";
const custId = "00438";
const styleId = "LW3KDNS";

// Step 1: bronze.tg_lotest for this PO (join is on cod_cliente + cod_purord)
console.log(`=== bronze.tg_lotest para PO ${poId}, cliente ${custId} ===`);
const r1 = await client.query(
  `SELECT cod_lotpurord, cod_estcli, precio, cod_moneda, num_prereq, num_predes, flg_status, cod_destino
   FROM bronze.tg_lotest
   WHERE cod_cliente = $1 AND TRIM(cod_purord) = $2`,
  [custId, poId]
);
console.log(`Filas: ${r1.rows.length}`);
for (const r of r1.rows) {
  console.log(`  LOT:${r.cod_lotpurord} estilo:${r.cod_estcli.trim()} precio:${r.precio} moneda:${r.cod_moneda} qty:${r.num_prereq} status:${r.flg_status} dest:${r.cod_destino}`);
}

// Step 2: Check a historical PO of the same style that HAS price
console.log(`\n=== OPs históricas de ${styleId} con precio > 0 ===`);
const r2 = await client.query(
  `SELECT pr_id, po_id, pol_id, pol_unit_price, pr_requested_q, po_customer_name
   FROM silver.pr
   WHERE TRIM(pol_customer_style_id) = $1 AND pol_unit_price > 0
   LIMIT 5`,
  [styleId]
);
for (const r of r2.rows) {
  console.log(`  OP:${r.pr_id} PO:${r.po_id.trim()} precio:${r.pol_unit_price} qty:${r.pr_requested_q}`);
}

// Step 3: For a historical PO with price, check its bronze data
if (r2.rows.length > 0) {
  const histPoId = r2.rows[0].po_id.trim();
  const histPolId = r2.rows[0].pol_id.trim();
  console.log(`\n=== bronze.tg_lotest para PO histórico ${histPoId} ===`);
  const r3 = await client.query(
    `SELECT cod_lotpurord, cod_estcli, precio, cod_moneda, num_prereq, flg_status
     FROM bronze.tg_lotest
     WHERE cod_cliente = $1 AND TRIM(cod_purord) = $2`,
    [custId, histPoId]
  );
  for (const r of r3.rows) {
    console.log(`  LOT:${r.cod_lotpurord} estilo:${r.cod_estcli.trim()} precio:${r.precio} moneda:${r.cod_moneda} qty:${r.num_prereq}`);
  }
}

// Step 4: Count all NI/PO OPs with and without price
console.log("\n=== Resumen precios NI/PO ===");
const r4 = await client.query(`
  SELECT
    TRIM(po_customer_name_grp) as brand,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE pol_unit_price > 0) as con_precio,
    COUNT(*) FILTER (WHERE pol_unit_price = 0 OR pol_unit_price IS NULL) as sin_precio
  FROM silver.pr
  WHERE TRIM(pol_class) IN ('NI','PO')
    AND pr_annulment_t IS NULL AND pr_cancelled_t IS NULL
  GROUP BY TRIM(po_customer_name_grp)
  ORDER BY sin_precio DESC
`);
for (const r of r4.rows) {
  console.log(`  ${r.brand}: total=${r.total} con_precio=${r.con_precio} sin_precio=${r.sin_precio}`);
}

// Step 5: Check if it's only recent POs without price
console.log("\n=== OPs sin precio por fecha de creacion del PO ===");
const r5 = await client.query(`
  SELECT
    DATE_TRUNC('month', po_created_t) as mes,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE pol_unit_price > 0) as con_precio,
    COUNT(*) FILTER (WHERE pol_unit_price = 0 OR pol_unit_price IS NULL) as sin_precio
  FROM silver.pr
  WHERE TRIM(pol_class) IN ('NI','PO')
    AND pr_annulment_t IS NULL AND pr_cancelled_t IS NULL
  GROUP BY DATE_TRUNC('month', po_created_t)
  ORDER BY mes DESC
  LIMIT 12
`);
for (const r of r5.rows) {
  console.log(`  ${r.mes.toISOString().slice(0,7)}: total=${r.total} con_precio=${r.con_precio} sin_precio=${r.sin_precio}`);
}

await client.end();
