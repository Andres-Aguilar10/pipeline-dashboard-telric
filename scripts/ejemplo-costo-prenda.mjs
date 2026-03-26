import { readFileSync } from 'fs';
import pg from 'pg';
const { Client } = pg;

const client = new Client({
  host: '18.118.59.50', port: 5433, database: 'tdv', user: 'andres',
  ssl: { rejectUnauthorized: false,
    cert: readFileSync('C:/Users/usuario/.ssl/tdv/andres.crt'),
    key:  readFileSync('C:/Users/usuario/.ssl/tdv/andres.pk8'),
    ca:   readFileSync('C:/Users/usuario/.ssl/tdv/root.crt') }
});
await client.connect();

// OP 86768 - LULU con varios WIPs reales
const opId = '86768';
const maxFecha = (await client.query(`SELECT MAX(fecha_corrida) as f FROM silver.costo_wip_op WHERE version_calculo='FLUIDA'`)).rows[0].f;

const res = await client.query(`
  SELECT wip_id,
    SUM(COALESCE(costo_textil,0))          as textil_total,
    SUM(COALESCE(costo_manufactura,0))     as manuf_total,
    SUM(COALESCE(costo_materia_prima,0))   as mp_total,
    SUM(COALESCE(costo_avios,0))           as avios_total,
    SUM(COALESCE(costo_tela,0))            as tela_total,
    MAX(prendas_requeridas::numeric)       as prendas_req
  FROM silver.costo_wip_op
  WHERE TRIM(pr_id) = $1
    AND version_calculo = 'FLUIDA'
    AND fecha_corrida = $2
  GROUP BY wip_id
  ORDER BY wip_id
`, [opId, maxFecha]);

const prendas = Number(res.rows[0]?.prendas_req) || 1;
console.log(`OP ${opId} — prendas_requeridas: ${prendas}\n`);
console.log('WIP  | Textil/p | Manuf/p  | MP/p     | Avíos/p  | Tela/p');
console.log('-----|----------|----------|----------|----------|--------');

let totTextil=0, totManuf=0, totMP=0, totAvios=0, totTela=0;

res.rows.forEach(r => {
  const t = Number(r.textil_total)/prendas;
  const m = Number(r.manuf_total)/prendas;
  const mp = Number(r.mp_total)/prendas;
  const av = Number(r.avios_total)/prendas;
  const tl = Number(r.tela_total)/prendas;
  totTextil+=t; totManuf+=m; totMP+=mp; totAvios+=av; totTela+=tl;
  console.log(`${r.wip_id.padEnd(5)}| ${t.toFixed(4).padStart(8)} | ${m.toFixed(4).padStart(8)} | ${mp.toFixed(4).padStart(8)} | ${av.toFixed(4).padStart(8)} | ${tl.toFixed(4).padStart(6)}`);
});

console.log('-----|----------|----------|----------|----------|--------');
console.log(`TOTAL| ${totTextil.toFixed(4).padStart(8)} | ${totManuf.toFixed(4).padStart(8)} | ${totMP.toFixed(4).padStart(8)} | ${totAvios.toFixed(4).padStart(8)} | ${totTela.toFixed(4).padStart(6)}`);

const costoReal = totTextil + totManuf + totMP + totAvios + totTela;
console.log(`\nCOSTO REAL (sin CIF/GA/GV): $${costoReal.toFixed(4)}/prenda`);
console.log(`  = Textil $${totTextil.toFixed(4)} + Manuf $${totManuf.toFixed(4)} + MP $${totMP.toFixed(4)} + Avíos $${totAvios.toFixed(4)} + Tela $${totTela.toFixed(4)}`);

// Comparar con lo que tenemos en el cotizador actual (solo textil + manuf)
console.log(`\nLo que usamos HOY en cotizador hibrido (solo textil+manuf): $${(totTextil+totManuf).toFixed(4)}/prenda`);
console.log(`Diferencia si incluimos MP y Avíos: +$${(totMP+totAvios).toFixed(4)}/prenda`);

await client.end();
