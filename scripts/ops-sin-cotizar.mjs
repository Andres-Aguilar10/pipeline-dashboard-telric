import { readFileSync } from "fs";

const d = JSON.parse(readFileSync("public/data/z0.json", "utf-8"));
const total = d.length;
const conCotiz = d.filter(o => o.cotizador !== null && o.cotizador !== undefined).length;
const sinCotiz = total - conCotiz;

// De los que tienen cotizador, cuántos tienen costo_base > 0
let conCosto = 0, sinCosto = 0;
for (const o of d) {
  if (o.cotizador === null || o.cotizador === undefined) { sinCosto++; continue; }
  const rango = o.cotizador.rango_actual;
  const rangos = o.cotizador.rangos;
  if (rango && rangos && rangos[rango] && rangos[rango].costo_base > 0) conCosto++;
  else sinCosto++;
}

console.log(`Total OPs NI/PO: ${total}`);
console.log(`Con cotizador: ${conCotiz}`);
console.log(`Sin cotizador: ${sinCotiz}`);
console.log(`Con costo_base > 0 en su rango: ${conCosto}`);
console.log(`Sin costo (sin cotizador o costo_base=0): ${sinCosto}`);

// Por marca
const byBrand = {};
for (const o of d) {
  const b = (o.po_customer_name_grp || "(null)").trim();
  if (byBrand[b] === undefined) byBrand[b] = { total: 0, conCotiz: 0, sinCotiz: 0 };
  byBrand[b].total++;
  if (o.cotizador !== null && o.cotizador !== undefined) byBrand[b].conCotiz++;
  else byBrand[b].sinCotiz++;
}
console.log(`\n=== Por marca ===`);
console.log(`${"Marca".padEnd(15)} ${"Total".padStart(6)} ${"ConCotiz".padStart(9)} ${"SinCotiz".padStart(9)}`);
for (const [b, v] of Object.entries(byBrand).sort((a, b) => b[1].total - a[1].total)) {
  console.log(`${b.padEnd(15)} ${String(v.total).padStart(6)} ${String(v.conCotiz).padStart(9)} ${String(v.sinCotiz).padStart(9)}`);
}

// Por tipo estilo
const byTipo = {};
for (const o of d) {
  const t = o.style_type || "(null)";
  if (byTipo[t] === undefined) byTipo[t] = { total: 0, conCotiz: 0, sinCotiz: 0 };
  byTipo[t].total++;
  if (o.cotizador !== null && o.cotizador !== undefined) byTipo[t].conCotiz++;
  else byTipo[t].sinCotiz++;
}
console.log(`\n=== Por tipo estilo ===`);
for (const [t, v] of Object.entries(byTipo)) {
  console.log(`${t}: total=${v.total} conCotiz=${v.conCotiz} sinCotiz=${v.sinCotiz}`);
}

// Metodo del cotizador
const byMetodo = {};
for (const o of d) {
  if (o.cotizador === null || o.cotizador === undefined) continue;
  const m = o.cotizador.metodo || "(sin metodo)";
  if (byMetodo[m] === undefined) byMetodo[m] = 0;
  byMetodo[m]++;
}
console.log(`\n=== Método cotizador ===`);
for (const [m, n] of Object.entries(byMetodo)) {
  console.log(`${m}: ${n}`);
}
