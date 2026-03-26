import { readFileSync, writeFileSync } from "fs";

const rows = JSON.parse(readFileSync("public/data/viz_scatter.json", "utf8"));

const perdidas = rows.filter(r => r.impacto < 0);
const ganancias = rows.filter(r => r.impacto >= 0);
const totalPerdida = perdidas.reduce((a, b) => a + b.impacto, 0);
const totalGanancia = ganancias.reduce((a, b) => a + b.impacto, 0);
const totalNeto = totalPerdida + totalGanancia;

// Top 15 mayores pérdidas
const top15 = [...rows].sort((a, b) => a.impacto - b.impacto).slice(0, 15);

// Bubble data: x=precio, y=costo, r=sqrt(|impacto|)/20
const marcaColorsMap = { LULU: "#6366f1", GREY: "#10b981", OTHERS: "#f59e0b", PATA: "#ef4444", LACO: "#3b82f6" };
const maxAbs = Math.max(...rows.map(r => Math.abs(r.impacto)));

// Separate datasets: perdida vs ganancia, por marca
const byMarca = {};
rows.forEach(r => {
  const key = r.marca + (r.perdida ? "_perdida" : "_ganancia");
  if (!byMarca[key]) byMarca[key] = { marca: r.marca, perdida: r.perdida, pts: [] };
  byMarca[key].pts.push({
    x: r.precio,
    y: r.costo,
    r: Math.max(4, Math.sqrt(Math.abs(r.impacto)) / 8),
    op: r.op,
    impacto: r.impacto,
    qty: r.qty,
    gap: r.gap_prenda
  });
});

const bubbleDatasets = Object.values(byMarca).map(d => {
  const base = marcaColorsMap[d.marca] || "#94a3b8";
  const color = d.perdida ? "#ef4444" : "#22c55e";
  return {
    label: d.marca + (d.perdida ? " ↓" : " ↑"),
    data: d.pts,
    backgroundColor: color + "55",
    borderColor: color,
    borderWidth: 1
  };
});

// Break-even line
const maxVal = Math.max(...rows.map(r => Math.max(r.costo, r.precio))) * 1.15;
bubbleDatasets.push({
  label: "Break-even",
  data: [{ x: 0, y: 0, r: 0 }, { x: maxVal, y: maxVal, r: 0 }],
  type: "line",
  borderColor: "#f87171",
  borderDash: [6, 3],
  borderWidth: 1.5,
  pointRadius: 0,
  fill: false
});

// Bar top 15 pérdidas
const barLabels = JSON.stringify(top15.map(r => `OP ${r.op}`));
const barData = JSON.stringify(top15.map(r => r.impacto));
const barColors = JSON.stringify(top15.map(r => r.perdida ? "#ef444480" : "#22c55e80"));
const barBorders = JSON.stringify(top15.map(r => r.perdida ? "#ef4444" : "#22c55e"));
const barTooltips = JSON.stringify(top15.map(r =>
  `OP ${r.op} (${r.marca}) · ${r.qty} prendas · $${r.gap_prenda}/pda · Total: $${r.impacto.toLocaleString()}`
));

const bDS = JSON.stringify(bubbleDatasets);

const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Análisis Precio vs Costo — EN PRODUCCIÓN</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}
h1{font-size:1.2rem;font-weight:700;color:#f1f5f9;margin-bottom:4px}
.sub{font-size:.8rem;color:#64748b;margin-bottom:20px}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:20px}
.kpi{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px}
.kpi .val{font-size:1.6rem;font-weight:700}
.kpi .lbl{font-size:.72rem;color:#94a3b8;margin-top:4px}
.kpi.red{border-color:#ef4444aa}.kpi.red .val{color:#f87171}
.kpi.green{border-color:#22c55eaa}.kpi.green .val{color:#4ade80}
.kpi.blue .val{color:#60a5fa}
.kpi.amber .val{color:#fbbf24}
.kpi.white .val{color:#f1f5f9}
.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:18px;margin-bottom:14px}
.card h2{font-size:.78rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:14px}
.cw{position:relative;height:380px}
.note{font-size:.7rem;color:#64748b;margin-top:8px;text-align:center}
.legend-row{display:flex;gap:16px;font-size:.75rem;color:#94a3b8;margin-bottom:10px;flex-wrap:wrap}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:4px}
</style>
</head>
<body>
<h1>Análisis Precio vs Costo — EN PRODUCCIÓN</h1>
<div class="sub">${rows.length} OPs con precio cliente · Cotizador híbrido (real + estimado)</div>

<div class="kpis">
  <div class="kpi red">
    <div class="val">${perdidas.length} OPs</div>
    <div class="lbl">En pérdida (${(perdidas.length / rows.length * 100).toFixed(0)}% del total)</div>
  </div>
  <div class="kpi red">
    <div class="val">$${Math.abs(totalPerdida).toLocaleString("en-US", { maximumFractionDigits: 0 })}</div>
    <div class="lbl">Pérdida total estimada</div>
  </div>
  <div class="kpi green">
    <div class="val">$${totalGanancia.toLocaleString("en-US", { maximumFractionDigits: 0 })}</div>
    <div class="lbl">Ganancia total estimada</div>
  </div>
  <div class="kpi ${totalNeto >= 0 ? "green" : "red"}">
    <div class="val">$${Math.abs(totalNeto).toLocaleString("en-US", { maximumFractionDigits: 0 })}</div>
    <div class="lbl">Neto ${totalNeto >= 0 ? "ganancia" : "pérdida"} (${rows.length} OPs)</div>
  </div>
  <div class="kpi amber">
    <div class="val">${ganancias.length} OPs</div>
    <div class="lbl">Con margen positivo</div>
  </div>
</div>

<div class="card">
  <h2>Bubble chart — Precio vs Costo · tamaño = impacto total en $</h2>
  <div class="legend-row">
    <span><span class="dot" style="background:#ef4444"></span>Pérdida (costo > precio)</span>
    <span><span class="dot" style="background:#22c55e"></span>Ganancia (precio > costo)</span>
    <span style="color:#64748b">Burbuja más grande = mayor impacto en $</span>
  </div>
  <div class="cw"><canvas id="bubbleChart"></canvas></div>
  <p class="note">Eje X = Precio cliente ($/prenda) · Eje Y = Costo cotizador ($/prenda) · Por encima de la diagonal = pérdida</p>
</div>

<div class="card">
  <h2>Top 15 OPs por mayor pérdida / ganancia estimada ($)</h2>
  <div class="cw"><canvas id="barChart"></canvas></div>
  <p class="note">Impacto = gap (precio − costo) × cantidad de prendas</p>
</div>

<script>
const gridColor = "#334155", tickColor = "#94a3b8";
const tooltipData = ${barTooltips};

new Chart(document.getElementById("bubbleChart"), {
  type: "bubble",
  data: { datasets: ${bDS} },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: "right", labels: { color: tickColor, font: { size: 10 }, boxWidth: 10 } },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const d = ctx.raw;
            if (!d.op) return ctx.dataset.label;
            const sign = d.impacto < 0 ? "Pérdida" : "Ganancia";
            return [
              "OP " + d.op,
              "Precio: $" + d.x.toFixed(2) + " | Costo: $" + d.y.toFixed(2),
              "Gap: $" + d.gap.toFixed(2) + "/prenda · " + d.qty + " prendas",
              sign + ": $" + Math.abs(d.impacto).toLocaleString()
            ];
          }
        }
      }
    },
    scales: {
      x: { title: { display: true, text: "Precio cliente ($/prenda)", color: tickColor }, grid: { color: gridColor }, ticks: { color: tickColor } },
      y: { title: { display: true, text: "Costo cotizador ($/prenda)", color: tickColor }, grid: { color: gridColor }, ticks: { color: tickColor } }
    }
  }
});

new Chart(document.getElementById("barChart"), {
  type: "bar",
  data: {
    labels: ${barLabels},
    datasets: [{
      label: "Impacto ($)",
      data: ${barData},
      backgroundColor: ${barColors},
      borderColor: ${barBorders},
      borderWidth: 1,
      borderRadius: 4
    }]
  },
  options: {
    indexAxis: "y",
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => tooltipData[ctx.dataIndex]
        }
      }
    },
    scales: {
      x: {
        grid: { color: gridColor }, ticks: { color: tickColor },
        title: { display: true, text: "Impacto total ($)", color: tickColor }
      },
      y: { grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 11 } } }
    }
  }
});
</script>
</body>
</html>`;

writeFileSync("public/scatter_preview.html", html);
console.log("Generado: public/scatter_preview.html");
console.log(`Pérdida total: $${Math.abs(totalPerdida).toLocaleString()}`);
console.log(`Ganancia total: $${totalGanancia.toLocaleString()}`);
console.log(`Neto: $${totalNeto.toLocaleString()}`);
