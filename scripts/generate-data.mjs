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

const RANGOS = [
  { id: "pequeno", name: "Pequeño (200-500)", min: 200, max: 500 },
  { id: "mediano", name: "Mediano (501-1K)", min: 501, max: 1000 },
  { id: "grande", name: "Grande (1K-4K)", min: 1001, max: 4000 },
  { id: "masivo", name: "Masivo (4K+)", min: 4001, max: 999999 },
];

function getRangoId(qty) {
  for (const r of RANGOS) {
    if (qty >= r.min && qty <= r.max) return r.id;
  }
  return qty < 200 ? "pequeno" : "masivo";
}

// Build cotizador from historical ops data
// hist: { opId: { prendas, wips: { wipId: { textil_total, manuf_total } } } }
// gastosHist: { opId: { prendas, cif, ga, gv } }  (from costo_op_detalle)
// qty: prendas_requeridas of the current OP
const WIP_UMBRAL_PCT = 20; // % de prendas mínimo para considerar un WIP como "usado"
function buildCotizador(hist, gastosHist, qty) {
  const allHistOps = Object.entries(hist);
  if (allHistOps.length === 0) return null;

  const rangoActual = getRangoId(qty);

  // Collect ALL unique WIPs from history
  const allHistWips = new Set();
  for (const [, d] of allHistOps) {
    for (const w of Object.keys(d.wips)) allHistWips.add(w);
  }

  const allRangos = [
    ...RANGOS,
    { id: "promedio", name: "Promedio General", min: 200, max: 999999 },
  ];

  // First pass: compute all WIP data for promedio to determine wips_op
  const promedioOps = allHistOps.filter(([, d]) => d.prendas >= 200);
  const promedioMaxPrendas = {};
  let globalMaxPrendas = 0;
  for (const w of allHistWips) {
    const opsConWip = promedioOps.filter(([, d]) => d.wips[w]);
    if (opsConWip.length === 0) continue;
    const sumPrendas = opsConWip.reduce((a, [, d]) => a + d.prendas, 0);
    promedioMaxPrendas[w] = sumPrendas;
    if (sumPrendas > globalMaxPrendas) globalMaxPrendas = sumPrendas;
  }

  // wips_op: WIPs where %prendas >= umbral (based on promedio)
  const wipsOP = [];
  for (const [w, prendas] of Object.entries(promedioMaxPrendas)) {
    const pct = globalMaxPrendas > 0 ? prendas / globalMaxPrendas * 100 : 0;
    if (pct >= WIP_UMBRAL_PCT) wipsOP.push(w);
  }
  const wipsOPSet = new Set(wipsOP);

  const rangos = {};
  for (const rango of allRangos) {
    const opsR = allHistOps.filter(([, d]) => d.prendas >= rango.min && d.prendas <= rango.max);
    if (opsR.length === 0) { rangos[rango.id] = null; continue; }

    const wips = {};
    let tTotal = 0, mTotal = 0;

    // Iterate ALL historical WIPs
    for (const w of allHistWips) {
      const opsConWip = opsR.filter(([, d]) => d.wips[w]);
      if (opsConWip.length === 0) continue;
      const sumTextil = opsConWip.reduce((a, [, d]) => a + d.wips[w].textil_total, 0);
      const sumManuf = opsConWip.reduce((a, [, d]) => a + d.wips[w].manuf_total, 0);
      const sumPrendas = opsConWip.reduce((a, [, d]) => a + d.prendas, 0);
      const tPond = sumPrendas > 0 ? sumTextil / sumPrendas : 0;
      const mPond = sumPrendas > 0 ? sumManuf / sumPrendas : 0;
      wips[w] = { textil: +tPond.toFixed(4), manuf: +mPond.toFixed(4), ops: opsConWip.length, prendas: sumPrendas };

      // costo_base only sums WIPs that pass the 20% threshold
      if (wipsOPSet.has(w)) {
        tTotal += tPond;
        mTotal += mPond;
      }
    }

    // Gastos indirectos/admin/ventas: promedio simple de OPs en este rango
    // Avíos/MP: promedio ponderado (SUM total / SUM prendas) — son TOTALES en costo_op_detalle
    const opIds = opsR.map(([id]) => id);
    const gastosOps = opIds.map(id => gastosHist[id]).filter(Boolean);
    let cif = 0, ga = 0, gv = 0;
    if (gastosOps.length > 0) {
      cif = gastosOps.reduce((a, g) => a + g.cif, 0) / gastosOps.length;
      ga = gastosOps.reduce((a, g) => a + g.ga, 0) / gastosOps.length;
      gv = gastosOps.reduce((a, g) => a + g.gv, 0) / gastosOps.length;
    }

    // Avíos: ponderado con OPs que tienen avios > 0
    const opsConAvios = gastosOps.filter(g => g.avios > 0 && g.prendas > 0);
    const aviosPond = opsConAvios.length > 0
      ? opsConAvios.reduce((a, g) => a + g.avios, 0) / opsConAvios.reduce((a, g) => a + g.prendas, 0)
      : 0;
    // MP: ponderado con OPs que tienen mp > 0
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

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  console.log("Connecting...");
  await client.connect();
  console.log("Connected.");

  // 1. Load z0 and z1
  const z0 = (await client.query("SELECT * FROM silver.z0_reporte")).rows;
  console.log(`z0: ${z0.length}`);
  const z1 = (await client.query("SELECT * FROM silver.z1_reporte")).rows;
  console.log(`z1: ${z1.length}`);

  // z1 grouped by order → unique WIP list
  const z1ByOrder = {};
  for (const r of z1) {
    if (!z1ByOrder[r.order_id]) z1ByOrder[r.order_id] = new Set();
    z1ByOrder[r.order_id].add(r.process_id);
  }

  // ═══════════════════════════════════════════
  // RECURRENTE: lookup by estilo_cliente
  // ═══════════════════════════════════════════
  const estilos = [...new Set(
    z0.filter(r => r.style_type === "recurrente")
      .map(r => (r.pol_customer_style_id || "").trim())
      .filter(Boolean)
  )];
  console.log(`Estilos recurrentes: ${estilos.length}`);

  // Get latest fecha_corrida for each cost table (as text to avoid JS Date serialization issues)
  const [{ rows: [{ max_fecha: maxFechaWip }] }, { rows: [{ max_fecha: maxFechaGastos }] }] = await Promise.all([
    client.query(`SELECT MAX(fecha_corrida)::text as max_fecha FROM silver.costo_wip_op`),
    client.query(`SELECT MAX(fecha_corrida)::text as max_fecha FROM silver.costo_op_detalle`),
  ]);
  console.log(`Última fecha_corrida → costo_wip_op: ${maxFechaWip}, costo_op_detalle: ${maxFechaGastos}`);

  console.log("Loading costo_wip_op (recurrente)...");
  let t = Date.now();
  const wipRowsRec = (await client.query(`
    SELECT pr_id, wip_id, prendas_requeridas, estilo_cliente,
      SUM(COALESCE(costo_textil, 0)) as total_textil,
      SUM(COALESCE(costo_manufactura, 0)) as total_manuf
    FROM silver.costo_wip_op
    WHERE prendas_requeridas >= 200
      AND version_calculo = 'FLUIDA'
      AND fecha_corrida = $2
      AND TRIM(estilo_cliente) = ANY($1)
    GROUP BY pr_id, wip_id, prendas_requeridas, estilo_cliente
  `, [estilos, maxFechaWip])).rows;
  console.log(`costo_wip_op (recurrente): ${wipRowsRec.length} rows in ${Date.now() - t}ms`);

  // Organize recurrente: estilo → { opId: { prendas, wips } }
  const histRec = {};
  for (const r of wipRowsRec) {
    const e = (r.estilo_cliente || "").trim();
    const op = (r.pr_id || "").trim();
    const w = (r.wip_id || "").trim();
    const p = Number(r.prendas_requeridas);
    if (!histRec[e]) histRec[e] = {};
    if (!histRec[e][op]) histRec[e][op] = { prendas: p, wips: {} };
    histRec[e][op].wips[w] = {
      textil_total: Number(r.total_textil),
      manuf_total: Number(r.total_manuf),
    };
  }

  // ═══════════════════════════════════════════
  // GASTOS from costo_op_detalle (recurrente)
  // ═══════════════════════════════════════════
  console.log("Loading costo_op_detalle (recurrente)...");
  t = Date.now();
  const gastosRowsRec = (await client.query(`
    SELECT cod_ordpro, prendas_requeridas::numeric as prendas, estilo_cliente,
      COALESCE(costo_indirecto_fijo::numeric, 0) as cif,
      COALESCE(gasto_administracion::numeric, 0) as ga,
      COALESCE(gasto_ventas::numeric, 0) as gv,
      COALESCE(costo_avios::numeric, 0) as avios,
      COALESCE(costo_materia_prima::numeric, 0) as mp
    FROM silver.costo_op_detalle
    WHERE prendas_requeridas::numeric >= 200
      AND version_calculo = 'FLUIDA'
      AND fecha_corrida = $2
      AND TRIM(estilo_cliente) = ANY($1)
  `, [estilos, maxFechaGastos])).rows;
  console.log(`costo_op_detalle (recurrente): ${gastosRowsRec.length} rows in ${Date.now() - t}ms`);

  // Organize: estilo → { opId: { prendas, cif, ga, gv, avios, mp } }
  const gastosRec = {};
  for (const r of gastosRowsRec) {
    const e = (r.estilo_cliente || "").trim();
    const op = (r.cod_ordpro || "").trim();
    if (!gastosRec[e]) gastosRec[e] = {};
    gastosRec[e][op] = {
      prendas: Number(r.prendas),
      cif: Number(r.cif),
      ga: Number(r.ga),
      gv: Number(r.gv),
      avios: Number(r.avios),
      mp: Number(r.mp),
    };
  }

  // ═══════════════════════════════════════════
  // NUEVO: lookup by cliente + tipo_de_producto
  // Like cotizador: ILIKE for cliente, exact match for tipo_de_producto
  // ═══════════════════════════════════════════
  const nuevoCombos = {};
  for (const r of z0.filter(r => r.style_type === "nuevo")) {
    const cli = (r.po_customer_name || "").trim();
    const tipo = (r.pol_garment_class_description || "").trim();
    if (cli && tipo) {
      const key = `${cli}|||${tipo}`;
      nuevoCombos[key] = { cli, tipo };
    }
  }
  const combos = Object.values(nuevoCombos);
  console.log(`Combos nuevo (cliente+tipo): ${combos.length}`);

  const histNuevo = {};
  const gastosNuevo = {};
  t = Date.now();

  for (let i = 0; i < combos.length; i++) {
    const { cli, tipo } = combos[i];
    const comboKey = `${cli}|||${tipo}`;

    // WIP costs (like cotizador: ILIKE for cliente, exact for tipo_de_producto)
    const rows = (await client.query(`
      SELECT pr_id, wip_id, prendas_requeridas,
        SUM(COALESCE(costo_textil, 0)) as total_textil,
        SUM(COALESCE(costo_manufactura, 0)) as total_manuf
      FROM silver.costo_wip_op
      WHERE prendas_requeridas >= 200
        AND version_calculo = 'FLUIDA'
        AND fecha_corrida = $3
        AND cliente ILIKE $1
        AND tipo_de_producto = $2
      GROUP BY pr_id, wip_id, prendas_requeridas
    `, [`%${cli}%`, tipo, maxFechaWip])).rows;

    if (rows.length > 0) {
      histNuevo[comboKey] = {};
      for (const r of rows) {
        const op = (r.pr_id || "").trim();
        const w = (r.wip_id || "").trim();
        const p = Number(r.prendas_requeridas);
        if (!histNuevo[comboKey][op]) histNuevo[comboKey][op] = { prendas: p, wips: {} };
        histNuevo[comboKey][op].wips[w] = {
          textil_total: Number(r.total_textil),
          manuf_total: Number(r.total_manuf),
        };
      }
    }

    // Gastos from costo_op_detalle (same matching as cotizador)
    const gRows = (await client.query(`
      SELECT cod_ordpro, prendas_requeridas::numeric as prendas,
        COALESCE(costo_indirecto_fijo::numeric, 0) as cif,
        COALESCE(gasto_administracion::numeric, 0) as ga,
        COALESCE(gasto_ventas::numeric, 0) as gv,
        COALESCE(costo_avios::numeric, 0) as avios,
        COALESCE(costo_materia_prima::numeric, 0) as mp
      FROM silver.costo_op_detalle
      WHERE prendas_requeridas::numeric >= 200
        AND version_calculo = 'FLUIDA'
        AND fecha_corrida = $3
        AND cliente ILIKE $1
        AND tipo_de_producto = $2
    `, [`%${cli}%`, tipo, maxFechaGastos])).rows;

    if (gRows.length > 0) {
      gastosNuevo[comboKey] = {};
      for (const r of gRows) {
        const op = (r.cod_ordpro || "").trim();
        gastosNuevo[comboKey][op] = {
          prendas: Number(r.prendas),
          cif: Number(r.cif),
          ga: Number(r.ga),
          gv: Number(r.gv),
          avios: Number(r.avios),
          mp: Number(r.mp),
        };
      }
    }

    if ((i + 1) % 10 === 0) console.log(`  nuevo combo ${i + 1}/${combos.length}`);
  }
  console.log(`costo_wip_op + gastos (nuevo): ${combos.length} combos in ${Date.now() - t}ms`);

  // ═══════════════════════════════════════════
  // FALLBACK: solo tipo_de_producto (toda TdV)
  // Para "nuevo" OPs sin match por cliente+tipo
  // ═══════════════════════════════════════════
  const tiposSinCombo = new Set();
  for (const r of z0.filter(r => r.style_type === "nuevo")) {
    const cli = (r.po_customer_name || "").trim();
    const tipo = (r.pol_garment_class_description || "").trim();
    if (!histNuevo[`${cli}|||${tipo}`] && tipo) tiposSinCombo.add(tipo);
  }
  const tiposArr = [...tiposSinCombo];
  console.log(`Tipos sin combo (fallback solo tipo): ${tiposArr.length}`);

  const histTipo = {};
  const gastosTipo = {};
  t = Date.now();

  for (const tipo of tiposArr) {
    const rows = (await client.query(`
      SELECT pr_id, wip_id, prendas_requeridas,
        SUM(COALESCE(costo_textil, 0)) as total_textil,
        SUM(COALESCE(costo_manufactura, 0)) as total_manuf
      FROM silver.costo_wip_op
      WHERE prendas_requeridas >= 200
        AND version_calculo = 'FLUIDA'
        AND fecha_corrida = $2
        AND tipo_de_producto = $1
      GROUP BY pr_id, wip_id, prendas_requeridas
    `, [tipo, maxFechaWip])).rows;

    if (rows.length > 0) {
      histTipo[tipo] = {};
      for (const r of rows) {
        const op = (r.pr_id || "").trim();
        const w = (r.wip_id || "").trim();
        const p = Number(r.prendas_requeridas);
        if (!histTipo[tipo][op]) histTipo[tipo][op] = { prendas: p, wips: {} };
        histTipo[tipo][op].wips[w] = {
          textil_total: Number(r.total_textil),
          manuf_total: Number(r.total_manuf),
        };
      }
    }

    const gRows = (await client.query(`
      SELECT cod_ordpro, prendas_requeridas::numeric as prendas,
        COALESCE(costo_indirecto_fijo::numeric, 0) as cif,
        COALESCE(gasto_administracion::numeric, 0) as ga,
        COALESCE(gasto_ventas::numeric, 0) as gv,
        COALESCE(costo_avios::numeric, 0) as avios,
        COALESCE(costo_materia_prima::numeric, 0) as mp
      FROM silver.costo_op_detalle
      WHERE prendas_requeridas::numeric >= 200
        AND version_calculo = 'FLUIDA'
        AND fecha_corrida = $2
        AND tipo_de_producto = $1
    `, [tipo, maxFechaGastos])).rows;

    if (gRows.length > 0) {
      gastosTipo[tipo] = {};
      for (const r of gRows) {
        const op = (r.cod_ordpro || "").trim();
        gastosTipo[tipo][op] = {
          prendas: Number(r.prendas),
          cif: Number(r.cif),
          ga: Number(r.ga),
          gv: Number(r.gv),
          avios: Number(r.avios),
          mp: Number(r.mp),
        };
      }
    }
  }
  console.log(`Fallback solo tipo: ${tiposArr.length} tipos in ${Date.now() - t}ms`);

  // ═══════════════════════════════════════════
  // IN OPs: load real costs + completed WIPs
  // ═══════════════════════════════════════════
  const inOps = z0.filter(r => r.status === "IN");
  console.log(`IN OPs: ${inOps.length}`);
  const inPrIds = inOps.map(r => (r.order_id || "").trim()).filter(Boolean);

  // Real WIP costs for IN OPs
  const realWipCosts = {};
  if (inPrIds.length > 0) {
    console.log("Loading real WIP costs for IN OPs...");
    t = Date.now();
    const realRows = (await client.query(`
      SELECT pr_id, wip_id,
        SUM(COALESCE(costo_textil, 0)) as total_textil,
        SUM(COALESCE(costo_manufactura, 0)) as total_manuf
      FROM silver.costo_wip_op
      WHERE version_calculo = 'FLUIDA'
        AND fecha_corrida = $2
        AND pr_id = ANY($1)
      GROUP BY pr_id, wip_id
    `, [inPrIds, maxFechaWip])).rows;
    for (const r of realRows) {
      const op = (r.pr_id || "").trim();
      const w = (r.wip_id || "").trim();
      if (!realWipCosts[op]) realWipCosts[op] = {};
      realWipCosts[op][w] = {
        textil_total: Number(r.total_textil),
        manuf_total: Number(r.total_manuf),
      };
    }
    console.log(`Real WIP costs: ${realRows.length} rows for ${Object.keys(realWipCosts).length} OPs in ${Date.now() - t}ms`);
  }

  // Real materials (MP + tela, avios) for IN OPs — max fecha por OP dentro del SQL
  const realMaterials = {};
  if (inPrIds.length > 0) {
    console.log("Loading real materials for IN OPs...");
    t = Date.now();
    const matRows = (await client.query(`
      WITH max_fechas AS (
        SELECT pr_id, MAX(fecha_corrida) AS max_fecha
        FROM silver.costo_wip_op
        WHERE version_calculo = 'FLUIDA' AND pr_id = ANY($1)
        GROUP BY pr_id
      )
      SELECT cwo.pr_id,
        SUM(COALESCE(cwo.costo_materia_prima, 0)) AS total_mp,
        SUM(COALESCE(cwo.costo_tela, 0))          AS total_tela,
        SUM(COALESCE(cwo.costo_avios, 0))          AS total_avios
      FROM silver.costo_wip_op cwo
      JOIN max_fechas mf ON cwo.pr_id = mf.pr_id AND cwo.fecha_corrida = mf.max_fecha
      WHERE cwo.version_calculo = 'FLUIDA'
      GROUP BY cwo.pr_id
    `, [inPrIds])).rows;
    for (const r of matRows) {
      const op = (r.pr_id || "").trim();
      const mp = Number(r.total_mp) + Number(r.total_tela);
      const avios = Number(r.total_avios);
      if (mp > 0 || avios > 0) {
        realMaterials[op] = { mp_total: mp, avios_total: avios };
      }
    }
    console.log(`Real materials: ${Object.keys(realMaterials).length} OPs in ${Date.now() - t}ms`);
  }

  // Completed WIPs (end_ts IS NOT NULL in wip_real)
  const completedWips = {};
  if (inPrIds.length > 0) {
    const doneRows = (await client.query(`
      SELECT DISTINCT pr_id, wip_id
      FROM silver.wip_real
      WHERE end_ts IS NOT NULL AND pr_id = ANY($1)
    `, [inPrIds])).rows;
    for (const r of doneRows) {
      const op = (r.pr_id || "").trim();
      const w = (r.wip_id || "").trim();
      if (!completedWips[op]) completedWips[op] = new Set();
      completedWips[op].add(w);
    }
    console.log(`Completed WIPs loaded for ${Object.keys(completedWips).length} OPs`);
  }

  // ═══════════════════════════════════════════
  // Calculate for each z0 OP
  // ═══════════════════════════════════════════
  console.log("Calculating...");
  const z0Out = z0.map(op => {
    const qty = Number(op.pol_requested_q) || 0;
    const wipsSet = z1ByOrder[op.order_id];
    const wipsOP = wipsSet ? [...wipsSet] : [];
    const result = { ...op };

    let h, g, metodo;
    if (op.style_type === "recurrente") {
      const estilo = (op.pol_customer_style_id || "").trim();
      h = histRec[estilo];
      g = gastosRec[estilo] || {};
      metodo = "recurrente";
    } else if (op.style_type === "nuevo") {
      const cli = (op.po_customer_name || "").trim();
      const tipo = (op.pol_garment_class_description || "").trim();
      const comboKey = `${cli}|||${tipo}`;
      h = histNuevo[comboKey];
      g = gastosNuevo[comboKey] || {};
      metodo = "nuevo";
      // Fallback: sin match cliente+tipo → buscar solo por tipo (toda TdV)
      if (!h && tipo) {
        h = histTipo[tipo];
        g = gastosTipo[tipo] || {};
        metodo = "nuevo_tipo";
      }
    }

    if (!h) {
      result.cotizador = null;
      return result;
    }

    const cot = buildCotizador(h, g, qty);
    if (cot) cot.metodo = metodo;

    // For IN OPs: inject real costs per WIP
    const opId = (op.order_id || "").trim();
    if (op.status === "IN" && cot) {
      const realCosts = realWipCosts[opId] || {};
      const doneSet = completedWips[opId] || new Set();
      // real_wips: { wipId: { textil, manuf, source: "real" } }
      // For each completed WIP that has real cost, store per-prenda cost
      const realWips = {};
      for (const [w, costs] of Object.entries(realCosts)) {
        if (doneSet.has(w)) {
          realWips[w] = {
            textil: qty > 0 ? +(costs.textil_total / qty).toFixed(4) : 0,
            manuf: qty > 0 ? +(costs.manuf_total / qty).toFixed(4) : 0,
          };
        }
      }
      cot.real_wips = realWips;
      cot.completed_wips = [...doneSet];

      // Real materials (MP+tela, avios) per prenda
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

  // 6. Write
  fs.writeFileSync(path.join(outDir, "z0.json"), JSON.stringify(z0Out));
  const conCotiz = z0Out.filter(r => r.cotizador).length;
  const conRec = z0Out.filter(r => r.cotizador?.metodo === "recurrente").length;
  const conNuevo = z0Out.filter(r => r.cotizador?.metodo === "nuevo").length;
  const conNuevoTipo = z0Out.filter(r => r.cotizador?.metodo === "nuevo_tipo").length;
  const sinCotiz = z0Out.filter(r => !r.cotizador).length;
  console.log(`z0: ${z0Out.length} rows → con cotizador: ${conCotiz} (rec=${conRec}, nuevo=${conNuevo}, nuevo_tipo_fallback=${conNuevoTipo}) | sin cotizador: ${sinCotiz}`);
  fs.writeFileSync(path.join(outDir, "z1.json"), JSON.stringify(z1));
  console.log(`z1: ${z1.length} rows`);

  await client.end();
  console.log("Done.");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
