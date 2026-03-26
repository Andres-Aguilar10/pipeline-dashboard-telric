import { readFileSync } from "fs";
const d = JSON.parse(readFileSync("public/data/z0.json", "utf-8"));
const ni = d.filter(o => o.status === "NI");

// Caso 1: Sin cotizador (null) - no hay historial del estilo
const sinCotiz = ni.filter(o => o.cotizador == null);

// Caso 2: Con cotizador pero rango actual es null Y promedio también es null
const conCotizSinRango = ni.filter(o => {
  if (o.cotizador == null) return false;
  const r = o.cotizador.rangos[o.cotizador.rango_actual];
  const prom = o.cotizador.rangos["promedio"];
  return r == null && prom == null;
});

// Caso 3: Con cotizador, rango actual null, pero promedio SÍ tiene datos (el fallback funciona)
const fallbackOk = ni.filter(o => {
  if (o.cotizador == null) return false;
  const r = o.cotizador.rangos[o.cotizador.rango_actual];
  const prom = o.cotizador.rangos["promedio"];
  return r == null && prom != null;
});

// Caso 4: Con cotizador, tiene rango, costo_base > 0 (OK)
const ok = ni.filter(o => {
  if (o.cotizador == null) return false;
  const r = o.cotizador.rangos[o.cotizador.rango_actual];
  return r != null && r.costo_base > 0;
});

// Caso 5: Con cotizador, tiene rango, pero costo_base = 0
const costoBaseCero = ni.filter(o => {
  if (o.cotizador == null) return false;
  const r = o.cotizador.rangos[o.cotizador.rango_actual];
  return r != null && r.costo_base === 0;
});

console.log(`=== RESUMEN OPs NI: ${ni.length} ===`);
console.log(`OK (rango con costo): ${ok.length}`);
console.log(`Fallback a promedio (rango null pero promedio OK): ${fallbackOk.length}`);
console.log(`Costo base = 0 en su rango: ${costoBaseCero.length}`);
console.log(`Sin cotizador (estilo sin historial): ${sinCotiz.length}`);
console.log(`Con cotizador pero sin datos en ningún rango: ${conCotizSinRango.length}`);

// Detalle de los sin cotizador
console.log(`\n=== Sin cotizador (${sinCotiz.length}) ===`);
for (const o of sinCotiz) {
  console.log(`  OP:${o.order_id} cliente:${(o.po_customer_name_grp||"").trim()} estilo:${(o.pol_customer_style_id||"").trim()} prendas:${o.pol_requested_q} tipo:${o.style_type}`);
}

// Detalle de los con cotizador pero sin datos en ningún rango
if (conCotizSinRango.length > 0) {
  console.log(`\n=== Con cotizador pero sin datos en ningún rango (${conCotizSinRango.length}) ===`);
  for (const o of conCotizSinRango) {
    console.log(`  OP:${o.order_id} cliente:${(o.po_customer_name_grp||"").trim()} estilo:${(o.pol_customer_style_id||"").trim()} prendas:${o.pol_requested_q} ops_hist:${o.cotizador.total_ops_hist}`);
  }
}

// Detalle fallback
if (fallbackOk.length > 0) {
  console.log(`\n=== Fallback a promedio (${fallbackOk.length}) ===`);
  for (const o of fallbackOk) {
    const prom = o.cotizador.rangos["promedio"];
    const g = prom.gastos;
    const total = prom.costo_base + (g ? g.cif + g.ga + g.gv + g.avios + g.mp : 0);
    console.log(`  OP:${o.order_id} cliente:${(o.po_customer_name_grp||"").trim()} rango:${o.cotizador.rango_actual} ops_hist:${o.cotizador.total_ops_hist} costo_promedio:${total.toFixed(2)}`);
  }
}

// Los que tienen costo_base = 0
if (costoBaseCero.length > 0) {
  console.log(`\n=== Costo base = 0 (${costoBaseCero.length}) ===`);
  for (const o of costoBaseCero) {
    console.log(`  OP:${o.order_id} cliente:${(o.po_customer_name_grp||"").trim()} rango:${o.cotizador.rango_actual} ops_hist:${o.cotizador.total_ops_hist}`);
  }
}

// Ahora analizar: de los sin cotizador, cuántos tienen prendas < 200 (el mínimo del rango)
const sub200 = sinCotiz.filter(o => parseInt(o.pol_requested_q) < 200);
console.log(`\n=== De los sin cotizador, prendas < 200: ${sub200.length} ===`);
for (const o of sub200) {
  console.log(`  OP:${o.order_id} prendas:${o.pol_requested_q} cliente:${(o.po_customer_name_grp||"").trim()}`);
}
