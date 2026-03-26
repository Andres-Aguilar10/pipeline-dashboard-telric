import { readFileSync, writeFileSync } from "fs";

const z0 = JSON.parse(readFileSync("public/data/z0.json", "utf8"));

// ── helpers ──────────────────────────────────────────────────────────────
function getCosto(d) {
  const cot = d.cotizador;
  if (!cot) return null;
  const ra = cot.rangos[cot.rango_actual] ? cot.rango_actual : "promedio";
  const r = cot.rangos[ra];
  if (!r) return null;
  const g = r.gastos || {};
  let base = r.costo_base || 0;
  if (cot.real_wips && cot.completed_wips?.length > 0) {
    const ds = new Set(cot.completed_wips);
    let rt = 0, et = 0;
    for (const w of cot.wips_op || []) {
      const rw = cot.real_wips[w];
      if (rw && ds.has(w)) rt += rw.textil + rw.manuf;
      else if (r.wips?.[w]) et += r.wips[w].textil + r.wips[w].manuf;
    }
    base = rt + et;
  }
  return +(base + (g.cif || 0) + (g.ga || 0) + (g.gv || 0) + (g.avios || 0) + (g.mp || 0)).toFixed(2);
}

function getAvance(d) {
  const wips = d.cotizador?.wips_op || [];
  const done = (d.cotizador?.completed_wips || []).filter(w => wips.includes(w));
  return wips.length > 0 ? Math.round(done.length / wips.length * 100) : 0;
}

// ── compute per-status datasets ──────────────────────────────────────────
const statuses = ["ALL", "NI", "IN", "PO"];
const datasets = {};

for (const st of statuses) {
  const ops = st === "ALL" ? z0 : z0.filter(d => d.status === st);

  // marcas donut
  const marcaMap = {};
  ops.forEach(d => {
    const m = d.po_customer_name_grp || "N/A";
    marcaMap[m] = (marcaMap[m] || 0) + 1;
  });
  const topMarcas = Object.entries(marcaMap).sort((a, b) => b[1] - a[1]).slice(0, 7);

  // avance dist (solo IN tiene sentido, pero calcular para todos)
  const avanceDist = { "0%": 0, "1-25%": 0, "26-50%": 0, "51-75%": 0, "76-99%": 0, "100%": 0 };
  ops.forEach(d => {
    const p = getAvance(d);
    if (p === 0) avanceDist["0%"]++;
    else if (p <= 25) avanceDist["1-25%"]++;
    else if (p <= 50) avanceDist["26-50%"]++;
    else if (p <= 75) avanceDist["51-75%"]++;
    else if (p < 100) avanceDist["76-99%"]++;
    else avanceDist["100%"]++;
  });

  // scatter
  const MARCA_COLORS = { LULU: "#6366f1", GREY: "#10b981", OTHERS: "#f59e0b", PATA: "#ef4444", LACO: "#3b82f6" };
  const scatterRows = ops.filter(d => d.pol_unit_price > 0 && d.cotizador).map(d => {
    const costo = getCosto(d);
    if (!costo) return null;
    const precio = +Number(d.pol_unit_price).toFixed(2);
    const qty = +d.pol_requested_q || 0;
    const gap = +(precio - costo).toFixed(2);
    const impacto = +(gap * qty).toFixed(0);
    return { op: d.order_id.trim(), marca: d.po_customer_name_grp || "N/A", costo, precio, qty, gap, impacto };
  }).filter(Boolean);

  const byMarca = {};
  scatterRows.forEach(r => {
    if (!byMarca[r.marca]) byMarca[r.marca] = { perdida: [], ganancia: [] };
    (r.impacto < 0 ? byMarca[r.marca].perdida : byMarca[r.marca].ganancia).push({
      x: r.precio, y: r.costo,
      r: Math.max(4, Math.sqrt(Math.abs(r.impacto)) / 8),
      op: r.op, impacto: r.impacto, qty: r.qty, gap: r.gap
    });
  });

  const scatterDS = [];
  for (const [m, v] of Object.entries(byMarca)) {
    const base = MARCA_COLORS[m] || "#94a3b8";
    if (v.perdida.length) scatterDS.push({ label: m + " ↓", data: v.perdida, backgroundColor: "#ef444455", borderColor: "#ef4444", borderWidth: 1 });
    if (v.ganancia.length) scatterDS.push({ label: m + " ↑", data: v.ganancia, backgroundColor: (base) + "55", borderColor: base, borderWidth: 1 });
  }
  const maxVal = scatterRows.length ? Math.max(...scatterRows.map(r => Math.max(r.costo, r.precio))) * 1.15 : 30;
  scatterDS.push({ label: "Break-even", data: [{ x: 0, y: 0, r: 0 }, { x: maxVal, y: maxVal, r: 0 }], type: "line", borderColor: "#f87171", borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, fill: false });

  // top 15 losses
  const top15 = [...scatterRows].sort((a, b) => a.impacto - b.impacto).slice(0, 15);

  // KPIs
  const totalPerdida = scatterRows.filter(r => r.impacto < 0).reduce((a, b) => a + b.impacto, 0);
  const totalGanancia = scatterRows.filter(r => r.impacto >= 0).reduce((a, b) => a + b.impacto, 0);
  const conCot = ops.filter(d => d.cotizador).length;
  const conPrecio = scatterRows.length;
  const enPerdida = scatterRows.filter(r => r.impacto < 0).length;
  const avgAvance = ops.length ? Math.round(ops.reduce((a, d) => a + getAvance(d), 0) / ops.length) : 0;
  const conReal = ops.filter(d => d.cotizador?.real_wips && Object.keys(d.cotizador.real_wips).length > 0).length;
  const vencidas = ops.filter(d => d.pol_required_ship_date && new Date(d.pol_required_ship_date) < new Date()).length;

  // bar by marca (sin cotizador)
  const marcaBar = topMarcas.map(([m]) => {
    const opsM = ops.filter(d => (d.po_customer_name_grp || "N/A") === m);
    return { marca: m, total: opsM.length, sinCot: opsM.filter(d => !d.cotizador).length, vencidas: opsM.filter(d => d.pol_required_ship_date && new Date(d.pol_required_ship_date) < new Date()).length };
  });

  datasets[st] = {
    kpis: { total: ops.length, conCot, conPrecio, enPerdida, avgAvance, conReal, vencidas, totalPerdida: Math.round(totalPerdida), totalGanancia: Math.round(totalGanancia), neto: Math.round(totalPerdida + totalGanancia) },
    topMarcas, avanceDist, scatterDS, top15, marcaBar,
    tableRows: ops.slice(0, 50).map(d => ({
      op: d.order_id.trim(),
      marca: d.po_customer_name_grp || "N/A",
      estilo: d.pr_style_code || "—",
      qty: d.pol_requested_q || 0,
      avance: getAvance(d),
      costo: getCosto(d),
      precio: d.pol_unit_price > 0 ? +Number(d.pol_unit_price).toFixed(2) : null,
      entrega: d.pol_required_ship_date || null,
      status: d.status,
      hasCot: !!d.cotizador
    }))
  };
}

const DATA = JSON.stringify(datasets);

// ── HTML ──────────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Pipeline TdV — Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;font-size:13px;overflow-x:hidden}
/* header */
.hdr{background:#1e293b;border-bottom:1px solid #334155;padding:10px 20px;display:flex;align-items:center;gap:10px}
.hdr h1{font-size:.95rem;font-weight:700;color:#f1f5f9}
.hdr .badge{font-size:.68rem;background:#0f172a;color:#64748b;padding:2px 8px;border-radius:4px;border:1px solid #334155}
.hdr .date{margin-left:auto;font-size:.7rem;color:#475569}
/* tabs */
.tabs{display:flex;gap:4px;padding:10px 20px 0;background:#1e293b;border-bottom:1px solid #334155}
.tab{padding:7px 14px;border-radius:6px 6px 0 0;font-size:.78rem;font-weight:500;cursor:pointer;border:1px solid transparent;border-bottom:none;color:#64748b;transition:all .15s}
.tab:hover{color:#94a3b8;background:#0f172a40}
.tab.active{background:#0f172a;border-color:#334155;color:#e2e8f0}
.tab .cnt{font-size:.65rem;background:#334155;border-radius:8px;padding:1px 5px;margin-left:4px}
.tab[data-st="NI"].active{color:#fbbf24;border-top:2px solid #f59e0b}
.tab[data-st="IN"].active{color:#34d399;border-top:2px solid #10b981}
.tab[data-st="PO"].active{color:#f87171;border-top:2px solid #ef4444}
.tab[data-st="ALL"].active{color:#e2e8f0;border-top:2px solid #94a3b8}
/* layout */
.wrap{display:grid;grid-template-columns:1fr 360px;height:calc(100vh - 82px);overflow:hidden}
.left{overflow-y:auto;padding:14px 16px}
.right{background:#1e293b;border-left:1px solid #334155;overflow-y:auto;padding:14px}
/* kpis */
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.kpi{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:10px 12px}
.kpi .v{font-size:1.3rem;font-weight:700}
.kpi .l{font-size:.68rem;color:#64748b;margin-top:2px}
/* analytics toggle */
.an-toggle{background:#1e293b;border:1px solid #334155;border-radius:7px;padding:8px 12px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;margin-bottom:10px;user-select:none}
.an-toggle span{font-size:.75rem;font-weight:600;color:#60a5fa}
.an-toggle .arr{font-size:.7rem;color:#475569;transition:transform .2s}
.an-toggle.open .arr{transform:rotate(180deg)}
.analytics{display:none;margin-bottom:12px}
.analytics.open{display:block}
/* kpi mini */
.kmini{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:10px}
.km{background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:7px 8px;text-align:center}
.km .v{font-size:1rem;font-weight:700}
.km .l{font-size:.62rem;color:#64748b;margin-top:2px}
.red{color:#f87171}.green{color:#4ade80}.amber{color:#fbbf24}.blue{color:#60a5fa}.purple{color:#a78bfa}.gray{color:#94a3b8}
/* charts grid */
.g2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.g1{margin-bottom:8px}
.cc{background:#0f172a;border:1px solid #1e293b;border-radius:7px;padding:12px}
.cc h3{font-size:.68rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px}
.cw160{position:relative;height:160px}
.cw200{position:relative;height:200px}
.cw140{position:relative;height:140px}
/* divider */
.divider{font-size:.65rem;font-weight:700;color:#334155;text-transform:uppercase;letter-spacing:.1em;margin:12px 0 8px;display:flex;align-items:center;gap:8px}
.divider::after{content:"";flex:1;height:1px;background:#1e293b}
/* table */
.tw{background:#1e293b;border:1px solid #334155;border-radius:8px;overflow:hidden}
.th{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #334155}
.th span{font-size:.75rem;color:#94a3b8;font-weight:500}
.srch{background:#0f172a;border:1px solid #334155;border-radius:5px;padding:4px 8px;font-size:.72rem;color:#e2e8f0;width:160px}
table{width:100%;border-collapse:collapse;font-size:.72rem}
thead th{background:#0f172a;padding:7px 8px;text-align:left;color:#64748b;font-weight:500;border-bottom:1px solid #334155;white-space:nowrap}
tbody td{padding:6px 8px;border-bottom:1px solid #1e293b22;color:#cbd5e1;white-space:nowrap}
tbody tr:hover td{background:#0f172a50;cursor:pointer}
tbody tr.sel td{background:#172554}
.bar-wrap{display:inline-flex;align-items:center;gap:4px}
.bar-bg{background:#1e293b;border-radius:2px;height:4px;width:44px;overflow:hidden;display:inline-block}
.bar-fill{background:#34d399;height:100%}
.bs-IN{display:inline-block;padding:1px 5px;border-radius:3px;font-size:.65rem;font-weight:600;background:#064e3b;color:#34d399}
.bs-NI{background:#451a03;color:#fbbf24}.bs-PO{background:#450a0a;color:#f87171}
.loss{color:#f87171}.gain{color:#4ade80}.neutral{color:#64748b}
/* right panel */
.ptitle{font-size:.9rem;font-weight:700;color:#f1f5f9;margin-bottom:2px}
.psub{font-size:.68rem;color:#64748b;margin-bottom:12px}
.psec h4{font-size:.65rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.04em;padding-bottom:4px;border-bottom:1px solid #334155;margin-bottom:6px;margin-top:10px}
.ct{width:100%;border-collapse:collapse;font-size:.7rem}
.ct th{color:#64748b;font-weight:500;padding:3px 5px;text-align:right;border-bottom:1px solid #1e293b}
.ct th:first-child,.ct td:first-child{text-align:left;color:#94a3b8}
.ct td{padding:3px 5px;border-bottom:1px solid #1e293b22;text-align:right;color:#cbd5e1}
.rng{background:#1d4ed8;color:#e0f2fe;border-radius:3px;padding:1px 4px}
.breal{background:#064e3b;color:#34d399;padding:1px 4px;border-radius:3px;font-size:.6rem}
.bcot{background:#1e3a5f;color:#60a5fa;padding:1px 4px;border-radius:3px;font-size:.6rem}
.total-r td{font-weight:700;color:#f1f5f9;border-top:1px solid #334155;padding-top:5px}
.price-box{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px 10px;display:flex;justify-content:space-between;margin-top:8px}
.price-box .l{font-size:.65rem;color:#64748b;margin-bottom:2px}
.price-box .v{font-size:.95rem;font-weight:700}
.no-sel{display:flex;align-items:center;justify-content:center;height:200px;color:#334155;font-size:.8rem;flex-direction:column;gap:8px}
</style>
</head>
<body>
<div class="hdr">
  <h1>Pipeline TdV</h1>
  <span class="badge">z0 · 1,385 OPs</span>
  <span class="badge">costo_wip_op · 2026-03-11</span>
  <span class="date">Actualizado: 2026-03-18</span>
</div>

<div class="tabs">
  <div class="tab" data-st="ALL">Todos <span class="cnt">1,385</span></div>
  <div class="tab" data-st="NI">No Iniciadas <span class="cnt">307</span></div>
  <div class="tab active" data-st="IN">En Producción <span class="cnt">1,077</span></div>
  <div class="tab" data-st="PO">Solo PO <span class="cnt">1</span></div>
</div>

<div class="wrap">
<div class="left">

  <!-- KPI CARDS -->
  <div class="kpis" id="kpis"></div>

  <!-- ANALYTICS TOGGLE -->
  <div class="an-toggle open" id="anToggle">
    <span id="anTitle">📊 Análisis — EN PRODUCCIÓN</span>
    <span class="arr">▼</span>
  </div>
  <div class="analytics open" id="analytics">
    <div class="kmini" id="kmini"></div>
    <div class="g2">
      <div class="cc"><h3>Avance WIPs por OP</h3><div class="cw160"><canvas id="distChart"></canvas></div></div>
      <div class="cc"><h3>OPs por marca</h3><div class="cw160"><canvas id="donutChart"></canvas></div></div>
    </div>
    <div class="g1 cc"><h3 id="scatterTitle">Precio vs Costo — burbuja = impacto $ total</h3><div class="cw200"><canvas id="bubbleChart"></canvas></div></div>
    <div class="g2">
      <div class="cc"><h3>Top pérdidas/ganancias ($)</h3><div class="cw140"><canvas id="barLossChart"></canvas></div></div>
      <div class="cc"><h3>OPs por marca</h3><div class="cw140"><canvas id="barMarcaChart"></canvas></div></div>
    </div>
  </div>

  <!-- TABLE -->
  <div class="divider">Detalle de OPs</div>
  <div class="tw">
    <div class="th">
      <span id="tableCount">— OPs</span>
      <input class="srch" id="search" placeholder="Buscar OP, marca, estilo…">
    </div>
    <div style="overflow-x:auto">
    <table>
      <thead><tr>
        <th>OP</th><th>Estado</th><th>Marca</th><th>Estilo</th><th>Prendas</th><th>Avance</th><th>Costo</th><th>Precio</th><th>Margen $</th><th>Entrega</th>
      </tr></thead>
      <tbody id="tbody"></tbody>
    </table>
    </div>
  </div>

</div><!-- /left -->

<div class="right" id="panel">
  <div class="no-sel">
    <span style="font-size:1.5rem">👆</span>
    Selecciona una OP para ver el cotizador
  </div>
</div>
</div><!-- /wrap -->

<script>
const DATA = ${DATA};
const z0raw = ${JSON.stringify(z0.map(d => ({
  op: d.order_id?.trim(),
  marca: d.po_customer_name_grp || "N/A",
  estilo: d.pr_style_code || "—",
  qty: d.pol_requested_q || 0,
  status: d.status,
  cot: d.cotizador,
  precio: d.pol_unit_price > 0 ? +Number(d.pol_unit_price).toFixed(2) : null,
  entrega: d.pol_required_ship_date || null
})))};

const DONUT_COLORS = ["#6366f1","#10b981","#f59e0b","#ef4444","#3b82f6","#8b5cf6","#f472b6","#14b8a6"];
const GRID = "#334155", TICK = "#94a3b8";
let charts = {};
let activeSt = "IN";
let selectedOp = null;
let allRows = [];

function fmt(n){if(n==null)return"—";return"$"+Math.abs(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}
function fmtK(n){if(n==null)return"—";const s=n<0?"-":"";return s+"$"+Math.abs(n).toLocaleString("en-US",{maximumFractionDigits:0})}

function getAvance(cot){
  if(!cot)return 0;
  const wips=cot.wips_op||[];
  const done=(cot.completed_wips||[]).filter(w=>wips.includes(w));
  return wips.length>0?Math.round(done.length/wips.length*100):0;
}
function getCosto(cot){
  if(!cot)return null;
  const ra=cot.rangos[cot.rango_actual]?cot.rango_actual:"promedio";
  const r=cot.rangos[ra];if(!r)return null;
  const g=r.gastos||{};let base=r.costo_base||0;
  if(cot.real_wips&&cot.completed_wips?.length>0){
    const ds=new Set(cot.completed_wips);let rt=0,et=0;
    for(const w of cot.wips_op||[]){const rw=cot.real_wips[w];if(rw&&ds.has(w))rt+=rw.textil+rw.manuf;else if(r.wips?.[w])et+=r.wips[w].textil+r.wips[w].manuf;}
    base=rt+et;
  }
  return+(base+(g.cif||0)+(g.ga||0)+(g.gv||0)+(g.avios||0)+(g.mp||0)).toFixed(2);
}

function destroyAll(){Object.values(charts).forEach(c=>c?.destroy());charts={}}

function renderCharts(st){
  destroyAll();
  const d=DATA[st];
  const kpiColors={ALL:"gray",NI:"amber",IN:"green",PO:"red"};
  const c=kpiColors[st]||"gray";

  // KPI cards
  const kpis=[
    {v:d.kpis.total,l:"Total OPs",c},
    {v:d.kpis.avgAvance+"%",l:"Avance prom. WIPs",c:"purple"},
    {v:d.kpis.conCot,l:"Con cotizador",c:"blue"},
    {v:d.kpis.enPerdida,l:"OPs en pérdida",c:"red"},
  ];
  document.getElementById("kpis").innerHTML=kpis.map(k=>
    \`<div class="kpi"><div class="v \${k.c}">\${k.v}</div><div class="l">\${k.l}</div></div>\`
  ).join("");

  // kpi mini
  const km=[
    {v:fmtK(d.kpis.totalPerdida),l:"Pérdida total",c:"red"},
    {v:fmtK(d.kpis.totalGanancia),l:"Ganancia total",c:"green"},
    {v:fmtK(d.kpis.neto),l:"Neto estimado",c:d.kpis.neto>=0?"green":"red"},
    {v:d.kpis.conPrecio,l:"Con precio",c:"amber"},
    {v:d.kpis.conReal||0,l:"Costos reales",c:"blue"},
  ];
  document.getElementById("kmini").innerHTML=km.map(k=>
    \`<div class="km"><div class="v \${k.c}">\${k.v}</div><div class="l">\${k.l}</div></div>\`
  ).join("");

  document.getElementById("anTitle").textContent="📊 Análisis — "+(st==="ALL"?"Todos":{NI:"No Iniciadas",IN:"En Producción",PO:"Solo PO"}[st]||st);
  document.getElementById("scatterTitle").textContent="Precio vs Costo ("+d.kpis.conPrecio+" OPs con precio) · burbuja = impacto $ total";

  // dist chart
  charts.dist=new Chart(document.getElementById("distChart"),{
    type:"bar",
    data:{labels:Object.keys(d.avanceDist),datasets:[{label:"OPs",data:Object.values(d.avanceDist),backgroundColor:["#47556980","#3b82f680","#6366f180","#a855f780","#ec489980","#34d39980"],borderRadius:4}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{color:GRID},ticks:{color:TICK,font:{size:9}}},y:{grid:{color:GRID},ticks:{color:TICK,font:{size:9}}}}}
  });

  // donut
  charts.donut=new Chart(document.getElementById("donutChart"),{
    type:"doughnut",
    data:{labels:d.topMarcas.map(([k])=>k),datasets:[{data:d.topMarcas.map(([,v])=>v),backgroundColor:DONUT_COLORS,borderColor:"#0f172a",borderWidth:2}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"right",labels:{color:TICK,font:{size:9},boxWidth:8}}}}
  });

  // bubble
  charts.bubble=new Chart(document.getElementById("bubbleChart"),{
    type:"bubble",
    data:{datasets:d.scatterDS},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{position:"right",labels:{color:TICK,font:{size:8},boxWidth:8}},
        tooltip:{callbacks:{label:(ctx)=>{const p=ctx.raw;if(!p.op)return ctx.dataset.label;return["OP "+p.op,"Precio: "+fmt(p.x)+" | Costo: "+fmt(p.y),"Gap: "+fmt(p.gap)+"/pda · "+p.qty+" prendas",(p.impacto<0?"Pérdida":"Ganancia")+": "+fmtK(p.impacto)]}}}},
      scales:{x:{title:{display:true,text:"Precio cliente ($/prenda)",color:TICK,font:{size:9}},grid:{color:GRID},ticks:{color:TICK,font:{size:9}}},
              y:{title:{display:true,text:"Costo cotizador ($/prenda)",color:TICK,font:{size:9}},grid:{color:GRID},ticks:{color:TICK,font:{size:9}}}}}
  });

  // bar losses
  const top15=d.top15;
  charts.barLoss=new Chart(document.getElementById("barLossChart"),{
    type:"bar",
    data:{labels:top15.map(r=>"OP "+r.op),datasets:[{label:"Impacto $",data:top15.map(r=>r.impacto),backgroundColor:top15.map(r=>r.impacto<0?"#ef444460":"#22c55e60"),borderColor:top15.map(r=>r.impacto<0?"#ef4444":"#22c55e"),borderWidth:1,borderRadius:3}]},
    options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:(ctx)=>{const r=top15[ctx.dataIndex];return"OP "+r.op+" ("+r.marca+") · "+r.qty+" prendas · "+fmtK(r.impacto)}}}},
      scales:{x:{grid:{color:GRID},ticks:{color:TICK,font:{size:8}}},y:{grid:{color:GRID},ticks:{color:TICK,font:{size:8}}}}}
  });

  // bar marca
  const mb=d.marcaBar;
  charts.barMarca=new Chart(document.getElementById("barMarcaChart"),{
    type:"bar",
    data:{labels:mb.map(r=>r.marca),datasets:[
      {label:"Total",data:mb.map(r=>r.total),backgroundColor:"#3b82f650",borderColor:"#3b82f6",borderWidth:1,borderRadius:3},
      {label:"Sin cotiz.",data:mb.map(r=>r.sinCot),backgroundColor:"#f59e0b50",borderColor:"#f59e0b",borderWidth:1,borderRadius:3}
    ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:TICK,font:{size:8},boxWidth:8}}},
      scales:{x:{grid:{color:GRID},ticks:{color:TICK,font:{size:8}}},y:{grid:{color:GRID},ticks:{color:TICK,font:{size:8}}}}}
  });
}

function renderTable(st, filter=""){
  const ops = st==="ALL"?z0raw:z0raw.filter(d=>d.status===st);
  const q=filter.toLowerCase().trim();
  allRows = q ? ops.filter(d=>d.op.includes(q)||(d.marca||"").toLowerCase().includes(q)||(d.estilo||"").toLowerCase().includes(q)) : ops;
  document.getElementById("tableCount").textContent=allRows.length+" OPs";
  const now=new Date();
  const rows=allRows.slice(0,100);
  const tbody=document.getElementById("tbody");
  tbody.innerHTML=rows.map((d,i)=>{
    const costo=getCosto(d.cot);
    const av=getAvance(d.cot);
    const gap=costo&&d.precio?+(d.precio-costo).toFixed(2):null;
    const impacto=gap!=null?+(gap*(+d.qty||0)).toFixed(0):null;
    const venc=d.entrega&&new Date(d.entrega)<now;
    const entStr=d.entrega?new Date(d.entrega).toLocaleDateString("es-PE",{day:"2-digit",month:"short"}):"—";
    return \`<tr class="\${selectedOp===d.op?"sel":""}" data-op="\${d.op}" onclick="selectOp(this,'\${d.op}')">
      <td><b>\${d.op}</b></td>
      <td><span class="bs-\${d.status}">\${d.status}</span></td>
      <td>\${d.marca}</td>
      <td style="color:#64748b">\${d.estilo}</td>
      <td>\${(+d.qty).toLocaleString()}</td>
      <td><div class="bar-wrap">\${av}%<div class="bar-bg"><div class="bar-fill" style="width:\${av}%"></div></div></div></td>
      <td>\${costo!=null?fmt(costo):'<span class="neutral">—</span>'}</td>
      <td>\${d.precio!=null?fmt(d.precio):'<span class="neutral">—</span>'}</td>
      <td>\${impacto!=null?'<span class="'+(impacto<0?"loss":"gain")+'">'+(impacto<0?"▼ ":"▲ ")+fmtK(impacto)+'</span>':'<span class="neutral">—</span>'}</td>
      <td style="color:\${venc?"#f87171":"#94a3b8"}">\${entStr}\${venc?" !":""}</td>
    </tr>\`;
  }).join("")+(allRows.length>100?\`<tr><td colspan="10" style="text-align:center;color:#475569;padding:8px">… \${allRows.length-100} más …</td></tr>\`:"");
}

function selectOp(tr, opId){
  selectedOp=opId;
  document.querySelectorAll("tbody tr").forEach(r=>r.classList.remove("sel"));
  tr.classList.add("sel");
  const d=z0raw.find(r=>r.op===opId);
  if(!d){return;}
  renderPanel(d);
}

function renderPanel(d){
  const panel=document.getElementById("panel");
  const cot=d.cot;
  if(!cot){
    panel.innerHTML=\`<div class="ptitle">OP \${d.op} — \${d.marca}</div><div class="psub">\${d.estilo} · \${(+d.qty).toLocaleString()} prendas · Estado: \${d.status}</div><div class="no-sel" style="height:120px"><span style="color:#f59e0b">⚠</span>Sin cotizador</div>\`;
    return;
  }
  const ra=cot.rangos[cot.rango_actual]?cot.rango_actual:"promedio";
  const r=cot.rangos[ra];
  const g=r?.gastos||{};
  const wips_op=cot.wips_op||[];
  const completedSet=new Set(cot.completed_wips||[]);
  const realWips=cot.real_wips||{};
  const hasReal=Object.keys(realWips).length>0;

  // WIP rows
  const availRangos=Object.keys(cot.rangos).filter(k=>cot.rangos[k]);
  const rangoHeader=availRangos.map(k=>\`<th \${k===ra?'class="rng"':''}>\${k.charAt(0).toUpperCase()+k.slice(1)}</th>\`).join("");
  const wipRows=wips_op.map(w=>{
    const isComp=completedSet.has(w);
    const isReal=hasReal&&realWips[w]&&isComp;
    const src=isReal?'<span class="breal">Real</span>':'<span class="bcot">Cotizado</span>';
    return "<tr>"+
      \`<td>\${w}</td>\`+
      \`<td>\${src}</td>\`+
      availRangos.map(k=>{
        const rk=cot.rangos[k];
        const val=isReal?(realWips[w].textil+realWips[w].manuf):((rk?.wips?.[w])?((rk.wips[w].textil||0)+(rk.wips[w].manuf||0)):0);
        return \`<td \${k===ra?'style="color:#f1f5f9;font-weight:600"':''}>\${isReal?'<span style="color:#34d399">':""}$\${val.toFixed(4)}\${isReal?"</span>":""}</td>\`;
      }).join("")+
    "</tr>";
  }).join("");

  // WIP subtotals
  const wipSubs=availRangos.map(k=>{
    const rk=cot.rangos[k];let tot=0;
    for(const w of wips_op){const isReal=hasReal&&realWips[w]&&completedSet.has(w);tot+=isReal?(realWips[w].textil+realWips[w].manuf):((rk?.wips?.[w])?((rk.wips[w].textil||0)+(rk.wips[w].manuf||0)):0);}
    return \`<td \${k===ra?'style="color:#f1f5f9;font-weight:700"':''}><b>$\${tot.toFixed(4)}</b></td>\`;
  }).join("");

  // Gastos rows
  const gRow=(lbl,key)=>availRangos.map(k=>{const rk=cot.rangos[k];const v=(rk?.gastos?.[key])||0;return\`<td \${k===ra?'style="color:#f1f5f9"':''}>\${v>0?'$'+v.toFixed(4):'—'}</td>\`;}).join("");
  const gSub=availRangos.map(k=>{const rk=cot.rangos[k];const g2=rk?.gastos||{};const t=(g2.cif||0)+(g2.ga||0)+(g2.gv||0)+(g2.avios||0)+(g2.mp||0);return\`<td \${k===ra?'style="color:#f1f5f9;font-weight:700"':''}><b>\${t>0?'$'+t.toFixed(4):'—'}</b></td>\`;}).join("");

  // Total
  const totalRows=availRangos.map(k=>{
    const rk=cot.rangos[k];const g2=rk?.gastos||{};let base=rk?.costo_base||0;
    if(hasReal&&cot.completed_wips?.length>0){const ds=new Set(cot.completed_wips);let rt=0,et=0;for(const w of wips_op){const rw=realWips[w];if(rw&&ds.has(w))rt+=rw.textil+rw.manuf;else if(rk?.wips?.[w])et+=rk.wips[w].textil+rk.wips[w].manuf;}base=rt+et;}
    const t=base+(g2.cif||0)+(g2.ga||0)+(g2.gv||0)+(g2.avios||0)+(g2.mp||0);
    return\`<td \${k===ra?'style="color:#fbbf24;font-weight:700;font-size:.85rem"':''}><b>$\${t.toFixed(2)}</b></td>\`;
  }).join("");

  const metodo=cot.metodo||"—";
  const nReal=Object.keys(realWips).length;
  const prendas=(+d.qty).toLocaleString();

  const costo=getCosto(cot);
  const precio=d.precio;
  const gap=costo&&precio?+(precio-costo).toFixed(2):null;
  const impacto=gap!=null?+(gap*(+d.qty||0)).toFixed(0):null;

  panel.innerHTML=\`
    <div class="ptitle">OP \${d.op} — \${d.marca}</div>
    <div class="psub">\${d.estilo} · \${prendas} prendas · Rango: <b>\${ra}</b> · \${metodo}\${hasReal?' · <span style="color:#34d399">Híbrido (\${nReal} WIPs reales)</span>':''}</div>
    <div class="psec">
      <h4>WIPs de Proceso</h4>
      <div style="overflow-x:auto">
      <table class="ct">
        <tr><th>ID</th><th>Fuente</th>\${rangoHeader}</tr>
        \${wipRows}
        <tr class="total-r"><td colspan="2">Subtotal WIPs</td>\${wipSubs}</tr>
      </table>
      </div>
      <h4>Gastos</h4>
      <div style="overflow-x:auto">
      <table class="ct">
        <tr><th>Concepto</th><th>Fuente</th>\${rangoHeader}</tr>
        <tr><td>Materia Prima</td><td><span class="bcot">Cotizado</span></td>\${gRow("MP","mp")}</tr>
        <tr><td>Avíos</td><td><span class="bcot">Cotizado</span></td>\${gRow("Avíos","avios")}</tr>
        <tr><td>CIF</td><td><span class="bcot">Cotizado</span></td>\${gRow("CIF","cif")}</tr>
        <tr><td>GA</td><td><span class="bcot">Cotizado</span></td>\${gRow("GA","ga")}</tr>
        <tr><td>GV</td><td><span class="bcot">Cotizado</span></td>\${gRow("GV","gv")}</tr>
        <tr class="total-r"><td colspan="2">Subtotal Gastos</td>\${gSub}</tr>
      </table>
      </div>
      <h4>Costo Total</h4>
      <table class="ct">
        <tr class="total-r"><td>COSTO TOTAL</td><td></td>\${totalRows}</tr>
      </table>
      <div class="price-box">
        <div><div class="l">Precio cliente</div><div class="v" style="color:\${precio?'#fbbf24':'#475569'}">\${precio?fmt(precio):'Sin precio'}</div></div>
        <div style="text-align:right"><div class="l">Impacto</div><div class="v" style="color:\${impacto==null?'#475569':impacto<0?'#f87171':'#4ade80'}">\${impacto==null?"—":fmtK(impacto)}</div></div>
      </div>
    </div>\`;
}

// ── INIT ──────────────────────────────────────────────────────────────────
function switchTab(st){
  activeSt=st;
  document.querySelectorAll(".tab").forEach(t=>{t.classList.toggle("active",t.dataset.st===st)});
  renderCharts(st);
  renderTable(st, document.getElementById("search").value);
  selectedOp=null;
  document.getElementById("panel").innerHTML='<div class="no-sel"><span style="font-size:1.5rem">👆</span>Selecciona una OP para ver el cotizador</div>';
}

document.querySelectorAll(".tab").forEach(t=>t.addEventListener("click",()=>switchTab(t.dataset.st)));

document.getElementById("anToggle").addEventListener("click",()=>{
  const an=document.getElementById("analytics");
  const tog=document.getElementById("anToggle");
  an.classList.toggle("open");
  tog.classList.toggle("open");
});

document.getElementById("search").addEventListener("input", e=>{
  renderTable(activeSt, e.target.value);
});

switchTab("IN");
</script>
</body>
</html>`;

writeFileSync("public/dashboard_preview.html", html);
console.log("Generado: public/dashboard_preview.html");
