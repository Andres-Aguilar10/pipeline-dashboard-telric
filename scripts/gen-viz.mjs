import { readFileSync, writeFileSync } from "fs";

const raw = JSON.parse(readFileSync("public/data/viz_preview.json", "utf8"));
const { kpis, scatter, marcas, dist } = raw;

const topMarcas = Object.entries(marcas).sort((a, b) => b[1].total - a[1].total).slice(0, 8);
const marcaLabels = JSON.stringify(topMarcas.map(([k]) => k));
const marcaTotals = JSON.stringify(topMarcas.map(([, v]) => v.total));
const marcaVenc = JSON.stringify(topMarcas.map(([, v]) => v.vencidas));
const marcaSinCot = JSON.stringify(topMarcas.map(([, v]) => v.sinCot));

const marcaColorsMap = { LULU: "#6366f1", GREY: "#10b981", OTHERS: "#f59e0b", PATA: "#ef4444", LACO: "#3b82f6" };
const donutColors = JSON.stringify(topMarcas.map(([k], i) => marcaColorsMap[k] || ["#8b5cf6","#f472b6","#14b8a6"][i-5] || "#94a3b8"));

// Scatter por marca
const scatterByMarca = {};
scatter.forEach(s => {
  if (!scatterByMarca[s.marca]) scatterByMarca[s.marca] = [];
  scatterByMarca[s.marca].push({ x: s.costo, y: s.precio });
});
const scatterDatasets = Object.entries(scatterByMarca).map(([m, pts]) => ({
  label: m,
  data: pts,
  backgroundColor: (marcaColorsMap[m] || "#94a3b8") + "99",
  borderColor: marcaColorsMap[m] || "#94a3b8",
  borderWidth: 1,
  pointRadius: 4,
}));
const maxVal = Math.max(...scatter.map(s => Math.max(s.costo, s.precio))) * 1.1;
scatterDatasets.push({
  label: "Break-even",
  data: [{ x: 0, y: 0 }, { x: maxVal, y: maxVal }],
  type: "line",
  borderColor: "#f87171",
  borderDash: [6, 3],
  borderWidth: 1.5,
  pointRadius: 0,
  fill: false,
});

const distLabels = JSON.stringify(Object.keys(dist));
const distVals = JSON.stringify(Object.values(dist));
const distColors = JSON.stringify(["#475569", "#3b82f6", "#6366f1", "#a855f7", "#ec4899", "#34d399"]);
const scatterDS = JSON.stringify(scatterDatasets);

const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>EN PRODUCCIÓN — Visualización Preliminar</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}
h1{font-size:1.2rem;font-weight:700;color:#f1f5f9;margin-bottom:4px}
.sub{font-size:.8rem;color:#64748b;margin-bottom:24px}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:20px}
.kpi{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px}
.kpi .val{font-size:1.8rem;font-weight:700}
.kpi .lbl{font-size:.72rem;color:#94a3b8;margin-top:4px}
.kpi.blue .val{color:#60a5fa}
.kpi.purple .val{color:#a78bfa}
.kpi.green .val{color:#34d399}
.kpi.amber .val{color:#fbbf24}
.kpi.red .val{color:#f87171}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:18px;margin-bottom:14px}
.card h2{font-size:.78rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:14px}
.cw{position:relative;height:260px}
.cwl{position:relative;height:320px}
.note{font-size:.7rem;color:#64748b;margin-top:8px;text-align:center}
</style>
</head>
<body>
<h1>EN PRODUCCIÓN — Visualización Preliminar</h1>
<div class="sub">1,077 OPs · Datos z0 + costo_wip_op · ${new Date().toLocaleDateString("es-PE")}</div>

<div class="kpis">
  <div class="kpi blue"><div class="val">${kpis.total}</div><div class="lbl">OPs En Producción</div></div>
  <div class="kpi purple"><div class="val">${kpis.avgAvance}%</div><div class="lbl">Avance promedio WIPs</div></div>
  <div class="kpi green"><div class="val">${kpis.conReal}</div><div class="lbl">OPs con costos reales</div></div>
  <div class="kpi amber"><div class="val">${kpis.conPrecio}</div><div class="lbl">OPs con precio cliente</div></div>
  <div class="kpi red"><div class="val">${kpis.enPerdida} <span style="font-size:1rem">(${(kpis.enPerdida / kpis.conPrecio * 100).toFixed(0)}%)</span></div><div class="lbl">OPs en pérdida</div></div>
</div>

<div class="grid2">
  <div class="card">
    <h2>Distribución avance WIPs por OP</h2>
    <div class="cw"><canvas id="distChart"></canvas></div>
    <p class="note">% WIPs completados del total de WIPs por OP</p>
  </div>
  <div class="card">
    <h2>OPs por marca</h2>
    <div class="cw"><canvas id="donutChart"></canvas></div>
  </div>
</div>

<div class="card">
  <h2>Costo cotizador vs Precio cliente — ${kpis.conPrecio} OPs con precio</h2>
  <div class="cwl"><canvas id="scatterChart"></canvas></div>
  <p class="note">Por encima de la línea diagonal = OP en pérdida · Cada punto = 1 OP</p>
</div>

<div class="card">
  <h2>OPs por marca — Total / Sin cotizador / Vencidas</h2>
  <div class="cwl"><canvas id="barChart"></canvas></div>
</div>

<script>
const gridColor = "#334155", tickColor = "#94a3b8";

new Chart(document.getElementById("distChart"), {
  type: "bar",
  data: {
    labels: ${distLabels},
    datasets: [{ label: "OPs", data: ${distVals}, backgroundColor: ${distColors}, borderRadius: 6 }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: gridColor }, ticks: { color: tickColor } },
      y: { grid: { color: gridColor }, ticks: { color: tickColor } }
    }
  }
});

new Chart(document.getElementById("donutChart"), {
  type: "doughnut",
  data: {
    labels: ${marcaLabels},
    datasets: [{ data: ${marcaTotals}, backgroundColor: ${donutColors}, borderColor: "#0f172a", borderWidth: 2 }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { position: "right", labels: { color: tickColor, font: { size: 11 } } } }
  }
});

const scatterDS = ${scatterDS};
new Chart(document.getElementById("scatterChart"), {
  type: "scatter",
  data: { datasets: scatterDS },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { position: "right", labels: { color: tickColor, font: { size: 10 }, boxWidth: 10 } } },
    scales: {
      x: { title: { display: true, text: "Costo cotizador ($)", color: tickColor }, grid: { color: gridColor }, ticks: { color: tickColor } },
      y: { title: { display: true, text: "Precio cliente ($)", color: tickColor }, grid: { color: gridColor }, ticks: { color: tickColor } }
    }
  }
});

new Chart(document.getElementById("barChart"), {
  type: "bar",
  data: {
    labels: ${marcaLabels},
    datasets: [
      { label: "Total OPs", data: ${marcaTotals}, backgroundColor: "#3b82f680", borderColor: "#3b82f6", borderWidth: 1, borderRadius: 4 },
      { label: "Sin cotizador", data: ${marcaSinCot}, backgroundColor: "#f59e0b80", borderColor: "#f59e0b", borderWidth: 1, borderRadius: 4 },
      { label: "Vencidas", data: ${marcaVenc}, backgroundColor: "#ef444480", borderColor: "#ef4444", borderWidth: 1, borderRadius: 4 }
    ]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: tickColor } } },
    scales: {
      x: { grid: { color: gridColor }, ticks: { color: tickColor } },
      y: { grid: { color: gridColor }, ticks: { color: tickColor } }
    }
  }
});
</script>
</body>
</html>`;

writeFileSync("public/viz_preview.html", html);
console.log("Generado: public/viz_preview.html");
