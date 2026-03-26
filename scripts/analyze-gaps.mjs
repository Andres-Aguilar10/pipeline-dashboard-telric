import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('public/data/z0.json', 'utf8'));
const inOps = data.filter(d => d.status === 'IN');
const conCot = inOps.filter(d => d.cotizador);

console.log(`=== GAPS SUBSANABLES - IN (${inOps.length} OPs, ${conCot.length} con cotizador) ===\n`);

// ---- PROBLEMA A: WIPs completados SIN costo real ----
// completed_wips tiene WIPs, pero real_wips no los tiene => WIP terminado pero sin dato en costo_wip_op
let casosA = 0, totalWipsSinCosto = 0;
const ejemplosA = [];
conCot.forEach(d => {
  const done = new Set(d.cotizador.completed_wips || []);
  const real = new Set(Object.keys(d.cotizador.real_wips || {}));
  const faltantes = [...done].filter(w => !real.has(w));
  if (faltantes.length > 0) {
    casosA++;
    totalWipsSinCosto += faltantes.length;
    if (ejemplosA.length < 5)
      ejemplosA.push(`  OP ${d.order_id} (${d.po_customer_name_grp}) - WIPs terminados sin costo: ${faltantes.join(', ')}`);
  }
});
console.log(`A. WIPs TERMINADOS SIN COSTO REAL:`);
console.log(`   OPs afectadas: ${casosA} | WIPs sin costo: ${totalWipsSinCosto}`);
console.log(`   => end_ts en wip_real pero NO en costo_wip_op (FLUIDA)`);
console.log(`   Ejemplos:`);
ejemplosA.forEach(e => console.log(e));

// ---- PROBLEMA B: Real WIPs con costo = 0 ----
let casosB = 0, wipsCeroB = 0;
const ejemplosB = [];
conCot.forEach(d => {
  const rw = d.cotizador.real_wips || {};
  Object.entries(rw).forEach(([w, c]) => {
    if (c.textil === 0 && c.manuf === 0) {
      wipsCeroB++;
      if (wipsCeroB <= 3)
        ejemplosB.push(`  OP ${d.order_id} WIP ${w}: textil=0 manuf=0`);
    }
  });
  if (Object.values(rw).some(c => c.textil === 0 && c.manuf === 0)) casosB++;
});
console.log(`\nB. WIPs CON COSTO REAL = 0:`);
console.log(`   OPs afectadas: ${casosB} | WIPs con costo 0: ${wipsCeroB}`);
console.log(`   => están en costo_wip_op pero sin valores`);
ejemplosB.forEach(e => console.log(e));

// ---- PROBLEMA C: OPs sin wips_op (no se pudo calcular qué WIPs tiene) ----
const sinWipsOp = conCot.filter(d => !d.cotizador.wips_op || d.cotizador.wips_op.length === 0);
console.log(`\nC. OPs SIN WIPS SELECCIONADOS (wips_op vacío):`);
console.log(`   OPs afectadas: ${sinWipsOp.length}`);
if (sinWipsOp.length > 0) {
  const m = {};
  sinWipsOp.forEach(d => { const k = d.po_customer_name_grp||'NULL'; m[k]=(m[k]||0)+1; });
  Object.entries(m).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`   ${k}: ${v}`));
}

// ---- PROBLEMA D: Rangos - rango_actual sin data pero promedio también vacío ----
const sinNingunRango = conCot.filter(d => {
  const rangos = d.cotizador.rangos || {};
  return !Object.values(rangos).some(r => r !== null && r !== undefined);
});
console.log(`\nD. SIN NINGUN RANGO CON DATA (ni promedio):`);
console.log(`   OPs afectadas: ${sinNingunRango.length}`);
if (sinNingunRango.length > 0) {
  sinNingunRango.slice(0,5).forEach(d =>
    console.log(`  OP ${d.order_id} (${d.po_customer_name_grp}) rangos: ${JSON.stringify(Object.keys(d.cotizador.rangos))}`)
  );
}

// ---- PROBLEMA E: Gastos = 0 en rangos con data ----
let casosE = 0;
const detE = {cif:0, ga:0, gv:0, mp:0, avios:0};
conCot.forEach(d => {
  const ra = d.cotizador.rango_actual;
  const r = (d.cotizador.rangos||{})[ra] || (d.cotizador.rangos||{})['promedio'];
  if (!r || !r.gastos) return;
  const g = r.gastos;
  let tieneZero = false;
  if (g.cif === 0) { detE.cif++; tieneZero = true; }
  if (g.ga === 0) { detE.ga++; tieneZero = true; }
  if (g.gv === 0) { detE.gv++; tieneZero = true; }
  if (g.mp === 0) { detE.mp++; tieneZero = true; }
  if (g.avios === 0) { detE.avios++; tieneZero = true; }
  if (tieneZero) casosE++;
});
console.log(`\nE. OPs CON ALGUN GASTO = 0 (en rango activo):`);
console.log(`   OPs afectadas: ${casosE} de ${conCot.length}`);
console.log(`   CIF=0: ${detE.cif} | GA=0: ${detE.ga} | GV=0: ${detE.gv} | MP=0: ${detE.mp} | Avíos=0: ${detE.avios}`);
console.log(`   => posiblemente ops_con_mp=0 u ops_con_avios=0 en histórico`);

// ---- PROBLEMA F: OPs IN con 100% WIPs completos pero no movidas a "PO"/"FIN" ----
const all100 = conCot.filter(d => {
  const wips = new Set(d.cotizador.wips_op || []);
  const done = new Set(d.cotizador.completed_wips || []);
  return wips.size > 0 && [...wips].every(w => done.has(w));
});
console.log(`\nF. OPs CON TODOS LOS WIPs COMPLETADOS pero siguen en IN:`);
console.log(`   OPs afectadas: ${all100.length}`);
console.log(`   => posiblemente WIP 49 no marcado o lógica de status incompleta`);
if (all100.length > 0) {
  const m = {};
  all100.forEach(d => { const k = d.po_customer_name_grp||'NULL'; m[k]=(m[k]||0)+1; });
  Object.entries(m).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`   ${k}: ${v}`));
}

// ---- PROBLEMA G: Qty = 0 ----
const sinQty = inOps.filter(d => !d.pol_qty || d.pol_qty === 0);
console.log(`\nG. SIN CANTIDAD (pol_qty = 0):`);
console.log(`   OPs afectadas: ${sinQty.length}`);

// ---- PROBLEMA H: rango_actual = 'promedio' pero con qty fuera de rangos ----
const raEqProm = conCot.filter(d => d.cotizador.rango_actual === 'promedio');
const raFueraProm = conCot.filter(d => {
  const qty = d.pol_qty || 0;
  return qty > 0 && qty < 200;
});
console.log(`\nH. RANGO ACTUAL = PROMEDIO (qty insuficiente o sin rango):`);
console.log(`   OPs con rango_actual=promedio: ${raEqProm.length}`);
console.log(`   OPs con qty < 200 (fuera de rangos): ${raFueraProm.length}`);

// ---- RESUMEN ----
console.log(`\n=== RESUMEN DE GAPS SUBSANABLES ===`);
console.log(`A. WIPs terminados sin costo real:    ${casosA} OPs, ${totalWipsSinCosto} WIPs`);
console.log(`B. WIPs con costo real = 0:           ${casosB} OPs, ${wipsCeroB} WIPs`);
console.log(`C. wips_op vacío:                     ${sinWipsOp.length} OPs`);
console.log(`D. Sin ningún rango con data:         ${sinNingunRango.length} OPs`);
console.log(`E. Algún gasto = 0:                   ${casosE} OPs`);
console.log(`F. 100% WIPs done pero siguen IN:     ${all100.length} OPs`);
console.log(`G. Sin cantidad (pol_qty=0):          ${sinQty.length} OPs`);
console.log(`H. Qty < 200 (fuera de rangos):       ${raFueraProm.length} OPs`);
