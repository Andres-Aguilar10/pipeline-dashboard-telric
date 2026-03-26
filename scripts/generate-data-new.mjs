import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public", "data");

const cert = process.env.DB_SSL_CERT
  ? Buffer.from(process.env.DB_SSL_CERT, "base64").toString()
  : undefined;
const key = process.env.DB_SSL_KEY
  ? Buffer.from(process.env.DB_SSL_KEY, "base64").toString()
  : undefined;

const connStr = `postgresql://${process.env.DB_USER}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;

const client = new pg.Client({
  connectionString: connStr,
  ssl: { rejectUnauthorized: false, cert, key },
  connectionTimeoutMillis: 30000,
  query_timeout: 600000,
  statement_timeout: 600000,
});

// ═══════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════
const RANGOS = [
  { id: "pequeno", name: "Pequeño (200-500)", min: 200, max: 500 },
  { id: "mediano", name: "Mediano (501-1K)", min: 501, max: 1000 },
  { id: "grande", name: "Grande (1K-4K)", min: 1001, max: 4000 },
  { id: "masivo", name: "Masivo (4K+)", min: 4001, max: 999999 },
];

// WIP classification: textil vs manufactura (10c, 19c, 50 excluded — sin costo)
const TEXTIL_WIPS = new Set(["14", "16", "19a", "24"]);
const MANUF_WIPS  = new Set(["34", "36", "37", "40", "43", "44", "45", "49"]);

function getRangoId(qty) {
  for (const r of RANGOS) {
    if (qty >= r.min && qty <= r.max) return r.id;
  }
  return qty < 200 ? "pequeno" : "masivo";
}

// ═══════════════════════════════════════════
// buildCotizador — UNCHANGED from original
// hist:       { opId: { prendas, wips: { wipId: { textil_total, manuf_total } } } }
// gastosHist: { opId: { prendas, cif, ga, gv, avios, mp } }
// ═══════════════════════════════════════════
const WIP_UMBRAL_PCT = 10;
function buildCotizador(hist, gastosHist, qty) {
  const allHistOps = Object.entries(hist);
  if (allHistOps.length === 0) return null;

  const rangoActual = getRangoId(qty);

  const allHistWips = new Set();
  for (const [, d] of allHistOps) {
    for (const w of Object.keys(d.wips)) allHistWips.add(w);
  }

  const allRangos = [
    ...RANGOS,
    { id: "promedio", name: "Promedio General", min: 200, max: 999999 },
  ];

  // First pass: determine wips_op via promedio — umbral por cantidad de OPs (no prendas)
  const promedioOps = allHistOps.filter(([, d]) => d.prendas >= 200);
  const opsCountByWip = {};
  let globalMaxOps = 0;
  for (const w of allHistWips) {
    const opsConWip = promedioOps.filter(([, d]) => d.wips[w]);
    if (opsConWip.length === 0) continue;
    opsCountByWip[w] = opsConWip.length;
    if (opsConWip.length > globalMaxOps) globalMaxOps = opsConWip.length;
  }

  const wipsOP = [];
  for (const [w, count] of Object.entries(opsCountByWip)) {
    const pct = globalMaxOps > 0 ? count / globalMaxOps * 100 : 0;
    if (pct >= WIP_UMBRAL_PCT) wipsOP.push(w);
  }
  const wipsOPSet = new Set(wipsOP);

  const rangos = {};
  for (const rango of allRangos) {
    const opsR = allHistOps.filter(([, d]) => d.prendas >= rango.min && d.prendas <= rango.max);
    if (opsR.length === 0) { rangos[rango.id] = null; continue; }

    const wips = {};
    let tTotal = 0, mTotal = 0;

    for (const w of allHistWips) {
      const opsConWip = opsR.filter(([, d]) => d.wips[w]);
      if (opsConWip.length === 0) continue;
      const sumTextil  = opsConWip.reduce((a, [, d]) => a + d.wips[w].textil_total, 0);
      const sumManuf   = opsConWip.reduce((a, [, d]) => a + d.wips[w].manuf_total, 0);
      const sumPrendas = opsConWip.reduce((a, [, d]) => a + d.prendas, 0);
      const tPond = sumPrendas > 0 ? sumTextil / sumPrendas : 0;
      const mPond = sumPrendas > 0 ? sumManuf  / sumPrendas : 0;
      wips[w] = { textil: +tPond.toFixed(4), manuf: +mPond.toFixed(4), ops: opsConWip.length, prendas: sumPrendas };
      if (wipsOPSet.has(w)) { tTotal += tPond; mTotal += mPond; }
    }

    const opIds = opsR.map(([id]) => id);
    const gastosOps = opIds.map(id => gastosHist[id]).filter(Boolean);
    let cif = 0, ga = 0, gv = 0;
    if (gastosOps.length > 0) {
      cif = gastosOps.reduce((a, g) => a + g.cif, 0) / gastosOps.length;
      ga  = gastosOps.reduce((a, g) => a + g.ga,  0) / gastosOps.length;
      gv  = gastosOps.reduce((a, g) => a + g.gv,  0) / gastosOps.length;
    }

    const opsConAvios = gastosOps.filter(g => g.avios > 0 && g.prendas > 0);
    const aviosPond = opsConAvios.length > 0
      ? opsConAvios.reduce((a, g) => a + g.avios, 0) / opsConAvios.reduce((a, g) => a + g.prendas, 0)
      : 0;
    const opsConMP = gastosOps.filter(g => g.mp > 0 && g.prendas > 0);
    const mpPond = opsConMP.length > 0
      ? opsConMP.reduce((a, g) => a + g.mp, 0) / opsConMP.reduce((a, g) => a + g.prendas, 0)
      : 0;

    rangos[rango.id] = {
      name: rango.name,
      ops: opsR.length,
      textil: +tTotal.toFixed(4),
      manuf: +mTotal.toFixed(4),
      costo_base: +(tTotal + mTotal).toFixed(4),
      gastos: {
        cif: +cif.toFixed(4),
        ga: +ga.toFixed(4),
        gv: +gv.toFixed(4),
        avios: +aviosPond.toFixed(4),
        mp: +mpPond.toFixed(4),
        ops_con_gastos: gastosOps.length,
        ops_con_avios: opsConAvios.length,
        ops_con_mp: opsConMP.length,
      },
      wips,
    };
  }

  return {
    rango_actual: rangoActual,
    total_ops_hist: allHistOps.length,
    wips_op: wipsOP,
    rangos,
  };
}

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════
async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  console.log("Connecting...");
  await client.connect();
  console.log("Connected.");

  // ─── 1. z0 y z1 (sin cambios) ───
  const z0 = (await client.query("SELECT * FROM silver.z0_reporte")).rows;
  console.log(`z0: ${z0.length}`);
  const z1 = (await client.query("SELECT * FROM silver.z1_reporte")).rows;
  console.log(`z1: ${z1.length}`);

  const z1ByOrder = {};
  for (const r of z1) {
    if (!z1ByOrder[r.order_id]) z1ByOrder[r.order_id] = new Set();
    z1ByOrder[r.order_id].add(r.process_id);
  }

  // ─── 2. Prendas desde bd_margen (fuente canónica) — se carga PRIMERO ───
  // Usadas para filtrar y calcular en todos los pasos siguientes
  console.log("Loading prendas from bd_margen...");
  let t = Date.now();
  const bdMargenRows = (await client.query(`
    SELECT cod_ordpro::text AS pr_id, SUM(prendas_requeridas)::numeric AS prendas
    FROM silver.bd_margen
    WHERE factura IS NOT NULL
    GROUP BY cod_ordpro
  `)).rows;
  const bdMargenPrendas = {};
  for (const r of bdMargenRows) bdMargenPrendas[r.pr_id] = Number(r.prendas);
  console.log(`bd_margen prendas: ${bdMargenRows.length} OPs en ${Date.now() - t}ms`);

  // ─── 3. Cargar TODOS los históricos de una vez (2 queries) ───
  // Reemplaza: costo_wip_op + costo_op_detalle (múltiples queries en loop)
  // Sin filtro pr_requested_q en SQL — el filtro >= 200 se aplica después con bd_margen prendas
  console.log("Loading mv_telric_ops (Facturadas)...");
  t = Date.now();
  const facOpsRows = (await client.query(`
    SELECT
      op::text,
      TRIM(style)        AS style,
      TRIM(client)       AS client,
      TRIM(garment_type) AS garment_type,
      indirect_factory_cost,
      indirect_admin_cost,
      indirect_sales_cost,
      trim_cost,
      raw_material_cost,
      fabric_cost
    FROM silver.mv_telric_ops
    WHERE category = 'Facturada'
  `)).rows;
  // Filtrar con bd_margen prendas (fuente canónica), no con pr_requested_q de Telric
  const facOpsFiltered = facOpsRows.filter(r => (bdMargenPrendas[r.op] ?? 0) >= 200);
  console.log(`mv_telric_ops: ${facOpsRows.length} rows → ${facOpsFiltered.length} con bd_margen >= 200 en ${Date.now() - t}ms`);

  console.log("Loading mv_telric_wip_dist (Facturadas)...");
  t = Date.now();
  const facWipRows = (await client.query(`
    SELECT
      op::text,
      wip_id::text,
      allocated_cost
    FROM silver.mv_telric_wip_dist
    WHERE category = 'Facturada'
  `)).rows;
  console.log(`mv_telric_wip_dist: ${facWipRows.length} rows in ${Date.now() - t}ms`);

  // ─── 3. Construir índices en memoria ───

  // wipsByOp: opId → { wipId: { textil_total, manuf_total } }
  // allocated_cost se clasifica en textil o manufactura según wip_id
  const wipsByOp = {};
  for (const r of facWipRows) {
    const opId  = r.op;
    const wipId = r.wip_id.trim();
    const cost  = Number(r.allocated_cost);
    if (!wipsByOp[opId]) wipsByOp[opId] = {};
    wipsByOp[opId][wipId] = {
      textil_total: TEXTIL_WIPS.has(wipId) ? cost : 0,
      manuf_total:  MANUF_WIPS.has(wipId)  ? cost : 0,
    };
  }

  // gastosByOp: opId → { prendas, cif, ga, gv, avios, mp }
  // prendas siempre de bd_margen (fuente canónica); facOpsFiltered ya garantiza que existen en bd_margen
  // mp = raw_material_cost + fabric_cost  (equivale a costo_materia_prima + costo_tela)
  const gastosByOp = {};
  for (const r of facOpsFiltered) {
    const prendas = bdMargenPrendas[r.op];  // garantizado >= 200 por facOpsFiltered
    gastosByOp[r.op] = {
      prendas,
      // CIF/GA/GV en mv_telric_ops son TOTALES; buildCotizador los promedia simple → dividir por prenda
      cif:   Number(r.indirect_factory_cost) / prendas,
      ga:    Number(r.indirect_admin_cost)   / prendas,
      gv:    Number(r.indirect_sales_cost)   / prendas,
      // avios y mp son TOTALES → buildCotizador los divide por prendas (promedio ponderado)
      avios: Number(r.trim_cost),
      mp:    Number(r.raw_material_cost) + Number(r.fabric_cost),
    };
  }

  // Índice por style para recurrente
  const opsByStyle = {};
  for (const r of facOpsFiltered) {
    if (!opsByStyle[r.style]) opsByStyle[r.style] = [];
    opsByStyle[r.style].push(r);
  }

  // Índice por garment_type para nuevo (fallback) y filtrado rápido
  const opsByType = {};
  for (const r of facOpsFiltered) {
    if (!opsByType[r.garment_type]) opsByType[r.garment_type] = [];
    opsByType[r.garment_type].push(r);
  }

  // Construye los objetos hist/gastos que espera buildCotizador
  function buildHistGastos(filteredOps) {
    const hist   = {};
    const gastos = {};
    for (const r of filteredOps) {
      hist[r.op] = { prendas: bdMargenPrendas[r.op], wips: wipsByOp[r.op] || {} };
      if (gastosByOp[r.op]) gastos[r.op] = gastosByOp[r.op];
    }
    return { hist, gastos };
  }

  // Cache por clave para no recomputar el mismo estilo/combo varias veces
  const hgCache = {};
  function getCached(key, filteredOps) {
    if (!hgCache[key]) hgCache[key] = buildHistGastos(filteredOps);
    return hgCache[key];
  }

  // ─── 4. IN OPs: costos reales + WIPs completados ───
  const inOps   = z0.filter(r => r.status === "IN");
  const inPrIds = inOps.map(r => (r.order_id || "").trim()).filter(Boolean);
  console.log(`IN OPs: ${inOps.length}`);

  // Real WIP costs — mv_telric_wip_dist (reemplaza costo_wip_op con pr_id = ANY)
  const realWipCosts = {};
  if (inPrIds.length > 0) {
    console.log("Loading real WIP costs for IN OPs...");
    t = Date.now();
    const rows = (await client.query(`
      SELECT op::text, wip_id::text, allocated_cost
      FROM silver.mv_telric_wip_dist
      WHERE op::text = ANY($1)
    `, [inPrIds])).rows;
    for (const r of rows) {
      const opId  = r.op;
      const wipId = r.wip_id.trim();
      const cost  = Number(r.allocated_cost);
      if (!realWipCosts[opId]) realWipCosts[opId] = {};
      realWipCosts[opId][wipId] = {
        textil_total: TEXTIL_WIPS.has(wipId) ? cost : 0,
        manuf_total:  MANUF_WIPS.has(wipId)  ? cost : 0,
      };
    }
    console.log(`Real WIP costs: ${rows.length} rows para ${Object.keys(realWipCosts).length} OPs en ${Date.now() - t}ms`);
  }

  // Real materials — mv_telric_ops (reemplaza query compleja con MAX(fecha_corrida))
  // mp = raw_material_cost + fabric_cost  |  avios = trim_cost
  const realMaterials = {};
  if (inPrIds.length > 0) {
    console.log("Loading real materials for IN OPs...");
    t = Date.now();
    const rows = (await client.query(`
      SELECT op::text, raw_material_cost, fabric_cost, trim_cost
      FROM silver.mv_telric_ops
      WHERE op::text = ANY($1)
    `, [inPrIds])).rows;
    for (const r of rows) {
      const mp    = Number(r.raw_material_cost) + Number(r.fabric_cost);
      const avios = Number(r.trim_cost);
      if (mp > 0 || avios > 0) {
        realMaterials[r.op] = { mp_total: mp, avios_total: avios };
      }
    }
    console.log(`Real materials: ${Object.keys(realMaterials).length} OPs en ${Date.now() - t}ms`);
  }

  // Completed WIPs — sin cambios, sigue usando wip_real
  const completedWips = {};
  if (inPrIds.length > 0) {
    const rows = (await client.query(`
      SELECT DISTINCT pr_id, wip_id
      FROM silver.wip_real
      WHERE end_ts IS NOT NULL AND pr_id = ANY($1)
    `, [inPrIds])).rows;
    for (const r of rows) {
      const op = (r.pr_id || "").trim();
      const w  = (r.wip_id || "").trim();
      if (!completedWips[op]) completedWips[op] = new Set();
      completedWips[op].add(w);
    }
    console.log(`Completed WIPs: ${Object.keys(completedWips).length} OPs`);
  }

  // ─── 5. Calcular cotizador para cada OP ───
  console.log("Calculating...");
  const z0Out = z0.map(op => {
    const opId   = (op.order_id || "").trim();
    const qty    = bdMargenPrendas[opId] ?? Number(op.pol_requested_q) ?? 0;
    const result = { ...op };

    let hist, gastos, metodo;

    if (op.style_type === "recurrente") {
      const estilo = (op.pol_customer_style_id || "").trim();
      const ops    = opsByStyle[estilo] || [];
      ({ hist, gastos } = getCached(`rec:${estilo}`, ops));
      metodo = "recurrente";

    } else if (op.style_type === "nuevo") {
      const cli  = (op.po_customer_name || "").trim();
      const tipo = (op.pol_garment_class_description || "").trim();
      const comboKey = `nuevo:${cli}|||${tipo}`;

      if (!hgCache[comboKey]) {
        // ILIKE: histórico.client contiene el nombre del cliente actual
        const ops = (opsByType[tipo] || []).filter(r =>
          r.client.toLowerCase().includes(cli.toLowerCase())
        );
        hgCache[comboKey] = buildHistGastos(ops);
      }
      ({ hist, gastos } = hgCache[comboKey]);
      metodo = "nuevo";

      // Fallback: sin match cliente+tipo → toda TdV para ese tipo
      if (Object.keys(hist).length === 0 && tipo) {
        ({ hist, gastos } = getCached(`tipo:${tipo}`, opsByType[tipo] || []));
        metodo = "nuevo_tipo";
      }
    }

    if (!hist || Object.keys(hist).length === 0) {
      result.cotizador = null;
      return result;
    }

    const cot = buildCotizador(hist, gastos, qty);
    if (!cot) { result.cotizador = null; return result; }
    cot.metodo = metodo;

    // IN OPs: inyectar costos reales de WIPs completados
    if (op.status === "IN") {
      const realCosts = realWipCosts[opId] || {};
      const doneSet   = completedWips[opId] || new Set();

      const realWips = {};
      for (const [w, costs] of Object.entries(realCosts)) {
        if (doneSet.has(w)) {
          realWips[w] = {
            textil: qty > 0 ? +(costs.textil_total / qty).toFixed(4) : 0,
            manuf:  qty > 0 ? +(costs.manuf_total  / qty).toFixed(4) : 0,
          };
        }
      }
      cot.real_wips      = realWips;
      cot.completed_wips = [...doneSet];

      const mat = realMaterials[opId];
      if (mat && qty > 0) {
        cot.real_materials = {
          mp:    +(mat.mp_total    / qty).toFixed(4),
          avios: +(mat.avios_total / qty).toFixed(4),
        };
      }
    }

    result.cotizador = cot;
    return result;
  });

  // ─── 6. Escribir z0_new.json (no toca z0.json hasta validar) ───
  fs.writeFileSync(path.join(outDir, "z0_new.json"), JSON.stringify(z0Out));
  const conCotiz    = z0Out.filter(r => r.cotizador).length;
  const conRec      = z0Out.filter(r => r.cotizador?.metodo === "recurrente").length;
  const conNuevo    = z0Out.filter(r => r.cotizador?.metodo === "nuevo").length;
  const conTipo     = z0Out.filter(r => r.cotizador?.metodo === "nuevo_tipo").length;
  const sinCotiz    = z0Out.filter(r => !r.cotizador).length;
  console.log(`z0_new: ${z0Out.length} → con cotizador: ${conCotiz} (rec=${conRec}, nuevo=${conNuevo}, nuevo_tipo=${conTipo}) | sin cotizador: ${sinCotiz}`);

  // z1 no cambia
  fs.writeFileSync(path.join(outDir, "z1.json"), JSON.stringify(z1));
  console.log(`z1: ${z1.length} rows`);

  await client.end();
  console.log("Done.");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
