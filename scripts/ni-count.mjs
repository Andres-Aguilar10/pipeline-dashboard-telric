import { readFileSync } from "fs";
const d = JSON.parse(readFileSync("public/data/z0.json", "utf-8"));
const ni = d.filter(o => o.status === "NI");
const po = d.filter(o => o.status === "PO");
console.log(`Total: ${d.length} | NI: ${ni.length} | PO: ${po.length}`);

const niConCotiz = ni.filter(o => o.cotizador != null).length;
const niSinCotiz = ni.length - niConCotiz;
console.log(`\nNI con cotizador: ${niConCotiz}`);
console.log(`NI sin cotizador: ${niSinCotiz}`);

// Por marca solo NI
const byBrand = {};
for (const o of ni) {
  const b = (o.po_customer_name_grp || "(null)").trim();
  if (byBrand[b] == null) byBrand[b] = { total: 0, con: 0, sin: 0 };
  byBrand[b].total++;
  if (o.cotizador != null) byBrand[b].con++;
  else byBrand[b].sin++;
}
console.log(`\n=== NI por marca ===`);
console.log(`${"Marca".padEnd(15)} ${"Total".padStart(6)} ${"ConCotiz".padStart(9)} ${"SinCotiz".padStart(9)}`);
for (const [b, v] of Object.entries(byBrand).sort((a, b) => b[1].total - a[1].total)) {
  console.log(`${b.padEnd(15)} ${String(v.total).padStart(6)} ${String(v.con).padStart(9)} ${String(v.sin).padStart(9)}`);
}
