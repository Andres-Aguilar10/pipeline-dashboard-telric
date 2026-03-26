import { readFileSync } from "fs";
const d = JSON.parse(readFileSync("public/data/z0.json", "utf-8"));
const op = d.find(o => o.order_id === "88922");
if (op) {
  console.log("OP 88922:");
  console.log("  status:", op.status);
  console.log("  cliente:", op.po_customer_name_grp);
  console.log("  estilo:", op.pol_customer_style_id);
  console.log("  prendas:", op.pol_requested_q);
  console.log("  style_type:", op.style_type);
  console.log("  tiene cotizador:", op.cotizador != null);
  if (op.cotizador) {
    console.log("  rango_actual:", op.cotizador.rango_actual);
    console.log("  metodo:", op.cotizador.metodo);
    console.log("  total_ops_hist:", op.cotizador.total_ops_hist);
    const rango = op.cotizador.rango_actual;
    if (rango && op.cotizador.rangos && op.cotizador.rangos[rango]) {
      const r = op.cotizador.rangos[rango];
      console.log("  costo_base:", r.costo_base);
      console.log("  ops en rango:", r.ops);
    } else {
      console.log("  NO tiene datos para rango:", rango);
      console.log("  rangos disponibles:", Object.keys(op.cotizador.rangos || {}));
      for (const [k, v] of Object.entries(op.cotizador.rangos || {})) {
        console.log(`    ${k}: ops=${v.ops} costo_base=${v.costo_base}`);
      }
    }
  }
} else {
  console.log("OP 88922 no encontrada en z0.json");
}
