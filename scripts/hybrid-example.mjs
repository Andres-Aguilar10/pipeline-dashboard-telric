import pg from "pg";

const NAMES = {
  "10c":"Abast. Hilo","14":"Teñido Hilado","16":"Tejido Tela",
  "19a":"Teñido","19c":"Despacho","24":"Estampado Tela",
  "34":"Corte","36":"Estampado Pieza","37":"Bordado Pieza","40":"Costura",
  "43":"Bordado Prenda","44":"Estampado Prenda","45":"Lavado Prenda",
  "49":"Acabado","50":"Mov. Logístico",
};

const cert = process.env.DB_SSL_CERT ? Buffer.from(process.env.DB_SSL_CERT, "base64").toString() : undefined;
const key = process.env.DB_SSL_KEY ? Buffer.from(process.env.DB_SSL_KEY, "base64").toString() : undefined;
const client = new pg.Client({
  connectionString: `postgresql://${process.env.DB_USER}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: { rejectUnauthorized: false, cert, key },
});

await client.connect();

const maxF = (await client.query("SELECT MAX(fecha_corrida)::text as mf FROM silver.costo_wip_op")).rows[0].mf;
const maxFG = (await client.query("SELECT MAX(fecha_corrida)::text as mf FROM silver.costo_op_detalle")).rows[0].mf;

const prendas = 860;

// 1. Costos REALES de OP 85274
const realCosts = (await client.query(`
  SELECT wip_id, SUM(COALESCE(costo_textil,0)) as textil, SUM(COALESCE(costo_manufactura,0)) as manuf
  FROM silver.costo_wip_op WHERE pr_id = '85274' AND version_calculo = 'FLUIDA' AND fecha_corrida = $1
  GROUP BY wip_id`, [maxF])).rows;
const realMap = {};
for (const r of realCosts) {
  realMap[r.wip_id] = { textil: parseFloat(r.textil), manuf: parseFloat(r.manuf) };
}

// 2. WIPs completadas
const done = new Set((await client.query("SELECT DISTINCT wip_id FROM silver.wip_real WHERE pr_id = '85274' AND end_ts IS NOT NULL")).rows.map(r => r.wip_id));

// 3. Cotizador histórico estilo LM3FWCS
const histAll = (await client.query(`
  SELECT pr_id, wip_id, prendas_requeridas,
    SUM(COALESCE(costo_textil,0)) as total_textil, SUM(COALESCE(costo_manufactura,0)) as total_manuf
  FROM silver.costo_wip_op WHERE TRIM(estilo_cliente) = 'LM3FWCS'
    AND version_calculo = 'FLUIDA' AND fecha_corrida = $1 AND prendas_requeridas >= 200
  GROUP BY pr_id, wip_id, prendas_requeridas`, [maxF])).rows;

const hist = {};
const allWips = new Set();
for (const r of histAll) {
  const op = r.pr_id.trim(), w = r.wip_id.trim(), p = Number(r.prendas_requeridas);
  if (!hist[op]) hist[op] = { prendas: p, wips: {} };
  hist[op].wips[w] = { textil_total: parseFloat(r.total_textil), manuf_total: parseFloat(r.total_manuf) };
  allWips.add(w);
}

// 4. Umbral 20%
const promedioOps = Object.entries(hist).filter(([,d]) => d.prendas >= 200);
const wipPrendas = {};
let globalMax = 0;
for (const w of allWips) {
  const opsW = promedioOps.filter(([,d]) => d.wips[w]);
  if (opsW.length === 0) continue;
  const sum = opsW.reduce((a,[,d]) => a + d.prendas, 0);
  wipPrendas[w] = sum;
  if (sum > globalMax) globalMax = sum;
}
const wipsOP = [];
for (const [w, p] of Object.entries(wipPrendas)) {
  if ((p / globalMax * 100) >= 20) wipsOP.push(w);
}
const wipsOPSet = new Set(wipsOP);

// 5. Rango mediano (501-1000)
const opsRango = Object.entries(hist).filter(([,d]) => d.prendas >= 501 && d.prendas <= 1000);

console.log("=== COTIZADOR HIBRIDO OP 85274 ===");
console.log("Estilo: LM3FWCS | Prendas:", prendas, "| Rango: mediano (501-1K)");
console.log("WIPs del 20%:", wipsOP.sort().join(", "));
console.log("WIPs completadas:", [...done].sort().join(", "));
console.log("OPs en rango mediano:", opsRango.length);
console.log("");

let costoBase = 0;
console.log("WIP   | Proceso          | Fuente   | $/prenda");
console.log("------+------------------+----------+---------");

for (const w of wipsOP.sort()) {
  const isCompleted = done.has(w);
  const hasReal = realMap[w] !== undefined;
  const name = (NAMES[w] || w).padEnd(17);

  if (isCompleted && hasReal) {
    const pp = (realMap[w].textil + realMap[w].manuf) / prendas;
    costoBase += pp;
    console.log(`${w.padEnd(6)}| ${name}| REAL     | ${pp.toFixed(4)}`);
  } else {
    // Estimado: rango mediano
    const opsConWip = opsRango.filter(([,d]) => d.wips[w]);
    if (opsConWip.length > 0) {
      const sumT = opsConWip.reduce((a,[,d]) => a + d.wips[w].textil_total, 0);
      const sumM = opsConWip.reduce((a,[,d]) => a + d.wips[w].manuf_total, 0);
      const sumP = opsConWip.reduce((a,[,d]) => a + d.prendas, 0);
      const pp = sumP > 0 ? (sumT + sumM) / sumP : 0;
      costoBase += pp;
      console.log(`${w.padEnd(6)}| ${name}| ESTIMADO | ${pp.toFixed(4)} (${opsConWip.length} ops, rango mediano)`);
    } else {
      // Fallback promedio
      const allOps = promedioOps.filter(([,d]) => d.wips[w]);
      if (allOps.length > 0) {
        const sumT = allOps.reduce((a,[,d]) => a + d.wips[w].textil_total, 0);
        const sumM = allOps.reduce((a,[,d]) => a + d.wips[w].manuf_total, 0);
        const sumP = allOps.reduce((a,[,d]) => a + d.prendas, 0);
        const pp = sumP > 0 ? (sumT + sumM) / sumP : 0;
        costoBase += pp;
        console.log(`${w.padEnd(6)}| ${name}| PROMEDIO  | ${pp.toFixed(4)} (${allOps.length} ops, fallback)`);
      }
    }
  }
}
console.log("------+------------------+----------+---------");
console.log(`COSTO BASE:${" ".repeat(26)}${costoBase.toFixed(4)}`);

// 6. Gastos del cotizador (rango mediano)
const gastosRows = (await client.query(`
  SELECT cod_ordpro, prendas_requeridas::numeric as prendas,
    COALESCE(costo_indirecto_fijo::numeric,0) as cif,
    COALESCE(gasto_administracion::numeric,0) as ga,
    COALESCE(gasto_ventas::numeric,0) as gv,
    COALESCE(costo_avios::numeric,0) as avios,
    COALESCE(costo_materia_prima::numeric,0) as mp
  FROM silver.costo_op_detalle WHERE TRIM(estilo_cliente) = 'LM3FWCS'
    AND version_calculo = 'FLUIDA' AND fecha_corrida = $1 AND prendas_requeridas::numeric >= 200
`, [maxFG])).rows;

const gastosRango = gastosRows.filter(r => parseFloat(r.prendas) >= 501 && parseFloat(r.prendas) <= 1000);
const gOps = gastosRango.length > 0 ? gastosRango : gastosRows;
const source = gastosRango.length > 0 ? "mediano" : "promedio";

let cif = 0, ga = 0, gv = 0, avios = 0, mp = 0;
if (gOps.length > 0) {
  cif = gOps.reduce((a,g) => a + parseFloat(g.cif), 0) / gOps.length;
  ga = gOps.reduce((a,g) => a + parseFloat(g.ga), 0) / gOps.length;
  gv = gOps.reduce((a,g) => a + parseFloat(g.gv), 0) / gOps.length;
  const conAvios = gOps.filter(g => parseFloat(g.avios) > 0 && parseFloat(g.prendas) > 0);
  avios = conAvios.length > 0 ? conAvios.reduce((a,g) => a + parseFloat(g.avios), 0) / conAvios.reduce((a,g) => a + parseFloat(g.prendas), 0) : 0;
  const conMP = gOps.filter(g => parseFloat(g.mp) > 0 && parseFloat(g.prendas) > 0);
  mp = conMP.length > 0 ? conMP.reduce((a,g) => a + parseFloat(g.mp), 0) / conMP.reduce((a,g) => a + parseFloat(g.prendas), 0) : 0;
}

console.log(`\nGastos (fuente: ${source}, ${gOps.length} ops):`);
console.log(`  CIF:    ${cif.toFixed(4)}`);
console.log(`  GA:     ${ga.toFixed(4)}`);
console.log(`  GV:     ${gv.toFixed(4)}`);
console.log(`  Avios:  ${avios.toFixed(4)}`);
console.log(`  MP:     ${mp.toFixed(4)}`);

const totalGastos = cif + ga + gv + avios + mp;
const costoTotal = costoBase + totalGastos;
const factorMarca = 0.95; // LULULEMON
const precio = costoTotal * (1 + 0.15 * 1.0 * factorMarca);

console.log("\n═══════════════════════════════════");
console.log(`  Costo base (WIPs): ${costoBase.toFixed(4)}`);
console.log(`  Gastos:            ${totalGastos.toFixed(4)}`);
console.log(`  COSTO TOTAL:       ${costoTotal.toFixed(4)} /prenda`);
console.log(`  PRECIO COTIZ:      ${precio.toFixed(4)} /prenda`);
console.log(`  Precio cliente:    10.1420 /prenda`);
console.log("═══════════════════════════════════");

await client.end();
