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

for (const tbl of ['costo_wip_op', 'costo_op_detalle']) {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='silver' AND table_name=$1 ORDER BY ordinal_position`, [tbl]
  );
  console.log(`=== silver.${tbl} ===`);
  console.log(r.rows.map(x => x.column_name).join(", "));
  console.log();
}

await client.end();
