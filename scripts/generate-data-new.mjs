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
// buildCotizador
// hist:          { opId: { prendas, wips: { wipId: { textil_total, manuf_total } } } }
// gastosHist:    { opId: { prendas, cif, ga, gv, avios, mp } }  (avios/mp son TOTALES)
// qty:           prendas de la OP nueva
// flatIndirectos: { cif, ga, gv } — tasa flat TdV últimos 12 meses
// ═══════════════════════════════════════════
// ── IQR filter: devuelve solo valores dentro de [Q1-1.5×IQR, Q3+1.5×IQR]
function filterIQR(values) {
  if (values.length < 4) return values; // muy pocos datos, no filtrar
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return values.filter(v => v >= lo && v <= hi);
}

const WIP_UMBRAL_PCT = 10;
function buildCotizador(hist, gastosHist, qty, flatIndirectos) {
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

    // ── WIPs: IQR + proximidad por prendas dentro del rango ──
    const wips = {};
    let tTotal = 0, mTotal = 0;

    for (const w of allHistWips) {
      const opsConWip = opsR.filter(([, d]) => d.wips[w]);
      if (opsConWip.length === 0) continue;

      // Costo por prenda de cada OP para este WIP
      const wipData = opsConWip.map(([, d]) => ({
        prendas: d.prendas,
        costoPrenda: (d.wips[w].textil_total + d.wips[w].manuf_total) / d.prendas,
        textil_total: d.wips[w].textil_total,
        manuf_total:  d.wips[w].manuf_total,
      }));

      // IQR: filtrar outliers por costo/prenda
      const costos = wipData.map(d => d.costoPrenda);
      const costosLimpios = filterIQR(costos);
      const costosSet = new Set(costosLimpios);
      const wipLimpio = wipData.filter(d => costosSet.has(d.costoPrenda));
      const wipFinal = wipLimpio.length > 0 ? wipLimpio : wipData; // fallback si IQR elimina todo

      // Proximidad: peso = 1/(1+|prendas_hist - qty|)
      const pesos = wipFinal.map(d => 1 / (1 + Math.abs(d.prendas - qty)));
      const sumP  = pesos.reduce((a, b) => a + b, 0);
      const tPond = wipFinal.reduce((a, d, i) => a + (pesos[i] / sumP) * (d.textil_total / d.prendas), 0);
      const mPond = wipFinal.reduce((a, d, i) => a + (pesos[i] / sumP) * (d.manuf_total  / d.prendas), 0);

      wips[w] = { textil: +tPond.toFixed(4), manuf: +mPond.toFixed(4), ops: wipFinal.length, prendas: wipFinal.reduce((a, d) => a + d.prendas, 0) };
      if (wipsOPSet.has(w)) { tTotal += tPond; mTotal += mPond; }
    }

    // ── MP/avíos: IQR + proximidad por prendas dentro del rango ──
    const gastosR = opsR.map(([id]) => gastosHist[id]).filter(Boolean);

    // Avíos: IQR sobre avíos/prenda, luego proximidad
    const opsConAviosRaw = gastosR.filter(g => g.avios > 0 && g.prendas > 0);
    const aviosPP = opsConAviosRaw.map(g => g.avios / g.prendas);
    const aviosLimpios = filterIQR(aviosPP);
    const aviosSet = new Set(aviosLimpios);
    const opsConAvios = opsConAviosRaw.filter(g => aviosSet.has(g.avios / g.prendas));
    const opsAviosFinal = opsConAvios.length > 0 ? opsConAvios : opsConAviosRaw;
    let aviosPond = 0;
    if (opsAviosFinal.length > 0) {
      const pesos = opsAviosFinal.map(g => 1 / (1 + Math.abs(g.prendas - qty)));
      const sumP  = pesos.reduce((a, b) => a + b, 0);
      aviosPond   = opsAviosFinal.reduce((a, g, i) => a + (pesos[i] / sumP) * (g.avios / g.prendas), 0);
    }

    // MP: IQR sobre mp/prenda, luego proximidad
    const opsConMPRaw = gastosR.filter(g => g.mp > 0 && g.prendas > 0);
    const mpPP = opsConMPRaw.map(g => g.mp / g.prendas);
    const mpLimpios = filterIQR(mpPP);
    const mpSet = new Set(mpLimpios);
    const opsConMP = opsConMPRaw.filter(g => mpSet.has(g.mp / g.prendas));
    const opsMPFinal = opsConMP.length > 0 ? opsConMP : opsConMPRaw;
    let mpPond = 0;
    if (opsMPFinal.length > 0) {
      const pesos = opsMPFinal.map(g => 1 / (1 + Math.abs(g.prendas - qty)));
      const sumP  = pesos.reduce((a, b) => a + b, 0);
      mpPond      = opsMPFinal.reduce((a, g, i) => a + (pesos[i] / sumP) * (g.mp / g.prendas), 0);
    }

    // prod_months: proximidad ponderada (para fórmula avíos futuro en IN)
    const opsConPM = gastosR.filter(g => g.prod_months > 0 && g.prendas > 0);
    let prodMonthsPond = 0;
    if (opsConPM.length > 0) {
      const pesos = opsConPM.map(g => 1 / (1 + Math.abs(g.prendas - qty)));
      const sumP  = pesos.reduce((a, b) => a + b, 0);
      prodMonthsPond = opsConPM.reduce((a, g, i) => a + (pesos[i] / sumP) * g.prod_months, 0);
    }

    rangos[rango.id] = {
      name: rango.name,
      ops: opsR.length,
      textil: +tTotal.toFixed(4),
      manuf: +mTotal.toFixed(4),
      costo_base: +(tTotal + mTotal).toFixed(4),
      gastos: {
        // CIF/GA/GV: tasa flat TdV (últimos 12 meses) — igual en todos los rangos
        cif:   +flatIndirectos.cif.toFixed(4),
        ga:    +flatIndirectos.ga.toFixed(4),
        gv:    +flatIndirectos.gv.toFixed(4),
        // MP/avíos: IQR + proximidad por prendas dentro del rango
        avios:       +aviosPond.toFixed(4),
        mp:          +mpPond.toFixed(4),
        prod_months: +prodMonthsPond.toFixed(2),
        ops_con_avios: opsAviosFinal.length,
        ops_con_mp:    opsMPFinal.length,
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

  // ─── 2. Prendas desde bd_margen (fuente canónica) — se carga PRIMERO ───
  // También calcula la fecha máxima para ventana de 24 meses del histórico
  console.log("Loading prendas from bd_margen...");
  let t = Date.now();
  const bdMargenRows = (await client.query(`
    SELECT
      cod_ordpro::text AS pr_id,
      SUM(prendas_requeridas)::numeric AS prendas,
      MAX(TO_DATE(fecha, 'DD/MM/YYYY')) AS ultima_fecha
    FROM silver.bd_margen
    WHERE factura IS NOT NULL
    GROUP BY cod_ordpro
  `)).rows;
  const bdMargenPrendas = {};
  const bdMargenFecha   = {};
  for (const r of bdMargenRows) {
    bdMargenPrendas[r.pr_id] = Number(r.prendas);
    bdMargenFecha[r.pr_id]   = r.ultima_fecha; // Date object
  }

  // Fecha de corte: últimos 24 meses desde MAX(fecha) en bd_margen
  const fechaMax24 = new Date(Math.max(...Object.values(bdMargenFecha).map(d => new Date(d))));
  fechaMax24.setMonth(fechaMax24.getMonth() - 24);
  console.log(`bd_margen prendas: ${bdMargenRows.length} OPs | ventana histórico 24m desde ${fechaMax24.toISOString().slice(0,10)} en ${Date.now() - t}ms`);

  // ─── 3. Cargar TODOS los históricos de una vez (2 queries) ───
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
      fabric_cost,
      prod_months
    FROM silver.mv_telric_ops
    WHERE category = 'Facturada'
  `)).rows;
  // Filtrar: prendas >= 200 Y facturada dentro de los últimos 24 meses
  const facOpsFiltered = facOpsRows.filter(r => {
    const prendas = bdMargenPrendas[r.op] ?? 0;
    const fecha   = bdMargenFecha[r.op];
    return prendas >= 200 && fecha && new Date(fecha) >= fechaMax24;
  });
  console.log(`mv_telric_ops: ${facOpsRows.length} rows → ${facOpsFiltered.length} con bd_margen >= 200 y 24m en ${Date.now() - t}ms`);

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
  // Solo OPs que pasaron el filtro 24m + prendas >= 200
  const facOpsSet = new Set(facOpsFiltered.map(r => r.op));
  const wipsByOp = {};
  for (const r of facWipRows) {
    if (!facOpsSet.has(r.op)) continue; // skip OPs fuera de ventana 24m
    const wipId = r.wip_id.trim();
    const cost  = Number(r.allocated_cost);
    if (!wipsByOp[r.op]) wipsByOp[r.op] = {};
    wipsByOp[r.op][wipId] = {
      textil_total: TEXTIL_WIPS.has(wipId) ? cost : 0,
      manuf_total:  MANUF_WIPS.has(wipId)  ? cost : 0,
    };
  }
  console.log(`wipsByOp: ${Object.keys(wipsByOp).length} OPs (filtrado 24m)`);

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
      avios:       Number(r.trim_cost),
      mp:          Number(r.raw_material_cost) + Number(r.fabric_cost),
      prod_months: Number(r.prod_months),
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
      SELECT op::text, raw_material_cost, fabric_cost, trim_cost, prod_months
      FROM silver.mv_telric_ops
      WHERE op::text = ANY($1)
    `, [inPrIds])).rows;
    for (const r of rows) {
      const mp    = Number(r.raw_material_cost) + Number(r.fabric_cost);
      const avios = Number(r.trim_cost);
      if (mp > 0 || avios > 0) {
        realMaterials[r.op] = { mp_total: mp, avios_total: avios, prod_months: Number(r.prod_months) };
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

  // ─── 4b. Flat indirects: tasa TdV últimos 12 meses ───
  console.log("Calculating flat indirect rates (last 12 months)...");
  t = Date.now();
  const flatRow = (await client.query(`
    WITH fecha_max AS (
      SELECT MAX(TO_DATE(fecha, 'DD/MM/YYYY')) AS max_fecha FROM silver.bd_margen WHERE factura IS NOT NULL
    ),
    ops_12m AS (
      SELECT DISTINCT cod_ordpro::text AS op
      FROM silver.bd_margen, fecha_max
      WHERE factura IS NOT NULL
        AND TO_DATE(fecha, 'DD/MM/YYYY') >= fecha_max.max_fecha - interval '12 months'
    ),
    prendas_op AS (
      SELECT cod_ordpro::text AS op, SUM(prendas_requeridas)::numeric AS prendas
      FROM silver.bd_margen WHERE factura IS NOT NULL
      GROUP BY cod_ordpro
    )
    SELECT
      SUM(o.indirect_factory_cost) / NULLIF(SUM(p.prendas), 0) AS cif,
      SUM(o.indirect_admin_cost)   / NULLIF(SUM(p.prendas), 0) AS ga,
      SUM(o.indirect_sales_cost)   / NULLIF(SUM(p.prendas), 0) AS gv
    FROM silver.mv_telric_ops o
    JOIN ops_12m ON ops_12m.op = o.op::text
    JOIN prendas_op p ON p.op = o.op::text
    WHERE o.category = 'Facturada'
  `)).rows[0];
  const flatIndirectos = {
    cif: Number(flatRow.cif),
    ga:  Number(flatRow.ga),
    gv:  Number(flatRow.gv),
  };
  console.log(`Flat indirectos: CIF=${flatIndirectos.cif.toFixed(4)} GA=${flatIndirectos.ga.toFixed(4)} GV=${flatIndirectos.gv.toFixed(4)} en ${Date.now() - t}ms`);

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

    const cot = buildCotizador(hist, gastos, qty, flatIndirectos);
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
        const mp_prenda        = mat.mp_total    / qty;
        const avios_hist_prenda = mat.avios_total / qty;

        // Avío Futuro = MAX(0; C/U × (prod_months_similar - prod_months_in + 1) - avios_hist)
        const rangoData        = cot.rangos[cot.rango_actual] || cot.rangos["promedio"];
        const avios_similar    = rangoData?.gastos?.avios      ?? 0;
        const prod_months_sim  = rangoData?.gastos?.prod_months ?? 0;
        const prod_months_in   = mat.prod_months;
        const cu               = prod_months_sim > 0 ? avios_similar / prod_months_sim : 0;
        const avios_futuro     = Math.max(0, cu * (prod_months_sim - prod_months_in + 1) - avios_hist_prenda);
        const avios_total      = avios_hist_prenda + avios_futuro;

        cot.real_materials = {
          mp:           +mp_prenda.toFixed(4),
          avios:        +avios_total.toFixed(4),
          avios_hist:   +avios_hist_prenda.toFixed(4),
          avios_futuro: +avios_futuro.toFixed(4),
          prod_months_in:  prod_months_in,
          prod_months_sim: +prod_months_sim.toFixed(2),
        };
      }
    }

    result.cotizador = cot;
    return result;
  });

  // ─── 6. Escribir z0.json ───
  fs.writeFileSync(path.join(outDir, "z0.json"), JSON.stringify(z0Out));
  const conCotiz    = z0Out.filter(r => r.cotizador).length;
  const conRec      = z0Out.filter(r => r.cotizador?.metodo === "recurrente").length;
  const conNuevo    = z0Out.filter(r => r.cotizador?.metodo === "nuevo").length;
  const conTipo     = z0Out.filter(r => r.cotizador?.metodo === "nuevo_tipo").length;
  const sinCotiz    = z0Out.filter(r => !r.cotizador).length;
  console.log(`z0: ${z0Out.length} → con cotizador: ${conCotiz} (rec=${conRec}, nuevo=${conNuevo}, nuevo_tipo=${conTipo}) | sin cotizador: ${sinCotiz}`);

  // z1 no cambia
  fs.writeFileSync(path.join(outDir, "z1.json"), JSON.stringify(z1));
  console.log(`z1: ${z1.length} rows`);

  await client.end();
  console.log("Done.");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
