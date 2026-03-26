import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('public/data/z0.json', 'utf8'));
const inOps = data.filter(d => d.status === 'IN');
console.log(`=== ANALISIS IN (En Produccion): ${inOps.length} OPs ===\n`);

// 1. Sin cotizador
const sinCot = inOps.filter(d => !d.cotizador);
console.log(`1. SIN COTIZADOR: ${sinCot.length} (${(sinCot.length/inOps.length*100).toFixed(1)}%)`);
const sinCotM = {};
sinCot.forEach(d => { const k = d.po_customer_name_grp||'NULL'; sinCotM[k]=(sinCotM[k]||0)+1; });
Object.entries(sinCotM).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`   ${k}: ${v}`));

// 2. Sin precio
const sinP = inOps.filter(d => !d.pol_unit_price || d.pol_unit_price === 0);
console.log(`\n2. SIN PRECIO: ${sinP.length} (${(sinP.length/inOps.length*100).toFixed(1)}%)`);
const sinPM = {};
sinP.forEach(d => { const k = d.po_customer_name_grp||'NULL'; sinPM[k]=(sinPM[k]||0)+1; });
Object.entries(sinPM).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`   ${k}: ${v}`));

// 3. Con cotizador
const conCot = inOps.filter(d => d.cotizador);
console.log(`\n3. CON COTIZADOR: ${conCot.length} (${(conCot.length/inOps.length*100).toFixed(1)}%)`);

// 3a. Sin datos en rango actual (fallback a promedio)
const sinRango = conCot.filter(d => {
  const ra = d.cotizador.rango_actual;
  return !ra || !d.cotizador.rangos[ra];
});
console.log(`   Fallback a promedio (sin data en rango): ${sinRango.length} (${(sinRango.length/conCot.length*100).toFixed(1)}%)`);

// 4. Hibrido: real vs estimado
const conReal = conCot.filter(d => d.cotizador.real_wips && Object.keys(d.cotizador.real_wips).length > 0);
const sinReal = conCot.filter(d => !d.cotizador.real_wips || Object.keys(d.cotizador.real_wips).length === 0);
console.log(`\n4. DATOS HIBRIDOS:`);
console.log(`   Con WIPs reales:    ${conReal.length} (${(conReal.length/conCot.length*100).toFixed(1)}%)`);
console.log(`   Solo estimado:      ${sinReal.length} (${(sinReal.length/conCot.length*100).toFixed(1)}%)`);

// Distribucion WIPs completados
const dist = {'0% (ninguno)':0,'1-49%':0,'50-99%':0,'100% (todos)':0};
let totalW=0, totalC=0, totalPend=0;
conCot.forEach(d => {
  const wips = d.cotizador.wips_op || [];
  const done = new Set(d.cotizador.completed_wips || []);
  totalW += wips.length;
  wips.forEach(w => { if (done.has(w)) totalC++; else totalPend++; });
  const pct = wips.length > 0 ? done.size/wips.length*100 : 0;
  if (pct === 0) dist['0% (ninguno)']++;
  else if (pct < 50) dist['1-49%']++;
  else if (pct < 100) dist['50-99%']++;
  else dist['100% (todos)']++;
});
console.log(`\n   Total WIPs: ${totalW} | Completados: ${totalC} (${(totalC/totalW*100).toFixed(1)}%) | Pendientes: ${totalPend} (${(totalPend/totalW*100).toFixed(1)}%)`);
console.log(`   Dist. % WIPs completados por OP:`);
Object.entries(dist).forEach(([k,v]) => console.log(`     ${k}: ${v} OPs`));

// 5. Poca historia
const pocaH = conCot.filter(d => d.cotizador.total_ops_hist < 10);
console.log(`\n5. POCA HISTORIA (<10 OPs hist): ${pocaH.length} (${(pocaH.length/conCot.length*100).toFixed(1)}%)`);

// 6. Costo > Precio (perdida)
let perdida = 0, conPrecio = 0;
inOps.forEach(d => {
  if (!d.pol_unit_price || d.pol_unit_price === 0) return;
  conPrecio++;
  if (!d.cotizador) return;
  const ra = d.cotizador.rango_actual;
  const r = d.cotizador.rangos[ra] || d.cotizador.rangos['promedio'];
  if (r && r.costo_base > d.pol_unit_price) perdida++;
});
console.log(`\n6. COSTO > PRECIO (perdida): ${perdida} de ${conPrecio} con precio (${conPrecio>0?(perdida/conPrecio*100).toFixed(1):0}%)`);

// 7. Metodo
const byM = {};
conCot.forEach(d => { const k = d.cotizador.metodo||'NULL'; byM[k]=(byM[k]||0)+1; });
console.log(`\n7. METODO COTIZADOR:`);
Object.entries(byM).forEach(([k,v]) => console.log(`   ${k}: ${v} (${(v/conCot.length*100).toFixed(1)}%)`));

// 8. Tabla por marca
console.log(`\n8. RESUMEN POR MARCA:`);
console.log(`   Marca              | Total | SinCotiz | SinPrecio | FallbackP | SinReal`);
console.log(`   -------------------|-------|----------|-----------|-----------|--------`);
const marcas = {};
inOps.forEach(d => {
  const m = d.po_customer_name_grp||'NULL';
  if (!marcas[m]) marcas[m]={total:0,sinCot:0,sinP:0,sinR:0,sinReal:0};
  marcas[m].total++;
  if (!d.cotizador) { marcas[m].sinCot++; }
  if (!d.pol_unit_price || d.pol_unit_price===0) marcas[m].sinP++;
  if (d.cotizador) {
    const ra = d.cotizador.rango_actual;
    if (!ra || !d.cotizador.rangos[ra]) marcas[m].sinR++;
    if (!d.cotizador.real_wips || Object.keys(d.cotizador.real_wips).length===0) marcas[m].sinReal++;
  }
});
Object.entries(marcas).sort((a,b)=>b[1].total-a[1].total).forEach(([k,v]) => {
  const pSC = (v.sinCot/v.total*100).toFixed(0);
  const pSP = (v.sinP/v.total*100).toFixed(0);
  const pSR = v.total-v.sinCot>0 ? (v.sinR/(v.total-v.sinCot)*100).toFixed(0) : '-';
  const pReal = v.total-v.sinCot>0 ? (v.sinReal/(v.total-v.sinCot)*100).toFixed(0) : '-';
  console.log(`   ${k.padEnd(19)}| ${String(v.total).padStart(5)} | ${String(v.sinCot).padStart(3)} (${pSC.padStart(2)}%) | ${String(v.sinP).padStart(4)} (${pSP.padStart(2)}%) | ${String(v.sinR).padStart(4)} (${pSR.padStart(2)}%) | ${String(v.sinReal).padStart(4)} (${pReal.padStart(2)}%)`);
});
