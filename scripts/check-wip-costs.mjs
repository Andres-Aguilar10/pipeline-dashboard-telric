// Check WIPs terminados sin costo en costo_wip_op
import { readFileSync } from 'fs';
import pg from 'pg';
const { Client } = pg;

const client = new Client({
  host: '18.118.59.50',
  port: 5433,
  database: 'tdv',
  user: 'andres',
  ssl: {
    rejectUnauthorized: false,
    cert: readFileSync('C:/Users/usuario/.ssl/tdv/andres.crt'),
    key:  readFileSync('C:/Users/usuario/.ssl/tdv/andres.pk8'),
    ca:   readFileSync('C:/Users/usuario/.ssl/tdv/root.crt'),
  }
});

await client.connect();
console.log('Conectado a TDV1\n');

const data = JSON.parse(readFileSync('public/data/z0.json', 'utf8'));
const inOps = data.filter(d => d.status === 'IN' && d.cotizador);

// A) WIPs terminados sin costo - qué WIP IDs son los que faltan
const missingByWip = {};
inOps.forEach(d => {
  const done = new Set(d.cotizador.completed_wips || []);
  const real = new Set(Object.keys(d.cotizador.real_wips || {}));
  done.forEach(w => {
    if (!real.has(w)) missingByWip[w] = (missingByWip[w]||0)+1;
  });
});
console.log('A. WIPs terminados sin costo - distribucion por WIP ID:');
Object.entries(missingByWip).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`   WIP ${k}: ${v} OPs`));

// B) Verificar en BD: ¿esos WIPs existen en costo_wip_op con alguna version?
const topMissing = Object.keys(missingByWip).slice(0,10);
console.log(`\nB. Verificando en costo_wip_op para WIPs: ${topMissing.join(', ')}`);
const resVersion = await client.query(`
  SELECT wip_id, version_calculo, COUNT(*) as cnt, MAX(fecha_corrida) as max_fecha
  FROM silver.costo_wip_op
  WHERE wip_id = ANY($1)
  GROUP BY wip_id, version_calculo
  ORDER BY wip_id, version_calculo
`, [topMissing]);
console.log('   wip_id | version | OPs | max_fecha');
resVersion.rows.forEach(r => console.log(`   ${r.wip_id.padEnd(6)} | ${r.version_calculo.padEnd(7)} | ${r.cnt.padStart(4)} | ${r.max_fecha?.toISOString()?.substring(0,10)}`));

// C) Versiones disponibles en costo_wip_op
const resVer = await client.query(`
  SELECT version_calculo, COUNT(DISTINCT wip_id) as wips, COUNT(DISTINCT pr_id) as ops, MAX(fecha_corrida) as max_fecha
  FROM silver.costo_wip_op
  GROUP BY version_calculo
  ORDER BY max_fecha DESC
`);
console.log('\nC. Versiones en costo_wip_op:');
console.log('   version          | WIPs | OPs | max_fecha');
resVer.rows.forEach(r => console.log(`   ${(r.version_calculo||'NULL').padEnd(17)} | ${r.wips.padStart(4)} | ${r.ops.padStart(4)} | ${r.max_fecha?.toISOString()?.substring(0,10)}`));

// D) Para las IN OPs con wips completos sin costo, ¿están en costo_wip_op con otra version o fecha?
// Tomar muestra de pr_ids afectados
const inPrIds = inOps.filter(d => {
  const done = new Set(d.cotizador.completed_wips || []);
  const real = new Set(Object.keys(d.cotizador.real_wips || {}));
  return [...done].some(w => !real.has(w));
}).map(d => d.order_id.trim()).slice(0, 20);

console.log(`\nD. Muestra de 20 OPs afectadas en costo_wip_op (todas versiones):`);
const resSample = await client.query(`
  SELECT pr_id, wip_id, version_calculo, fecha_corrida,
    SUM(COALESCE(costo_textil,0)) as t, SUM(COALESCE(costo_manufactura,0)) as m
  FROM silver.costo_wip_op
  WHERE pr_id = ANY($1)
  GROUP BY pr_id, wip_id, version_calculo, fecha_corrida
  ORDER BY pr_id, wip_id, fecha_corrida DESC
`, [inPrIds]);
const byPr = {};
resSample.rows.forEach(r => {
  if (!byPr[r.pr_id]) byPr[r.pr_id] = [];
  byPr[r.pr_id].push(r);
});
// Mostrar solo OPs donde hay WIPs en wip_real pero no en costo_wip_op FLUIDA
Object.entries(byPr).slice(0, 5).forEach(([pr, rows]) => {
  console.log(`   OP ${pr}:`);
  rows.forEach(r => console.log(`     WIP ${r.wip_id} | ${r.version_calculo} | ${r.fecha_corrida?.toISOString()?.substring(0,10)} | t=${parseFloat(r.t).toFixed(2)} m=${parseFloat(r.m).toFixed(2)}`));
});

// E) WIPs disponibles en wip_real pero no en costo_wip_op - cantidad total en BD
const resGap = await client.query(`
  SELECT wr.wip_id, COUNT(*) as cnt_wip_real,
    COUNT(cwo.pr_id) as cnt_con_costo
  FROM silver.wip_real wr
  LEFT JOIN silver.costo_wip_op cwo
    ON wr.pr_id = cwo.pr_id AND wr.wip_id = cwo.wip_id
    AND cwo.version_calculo = 'FLUIDA'
  WHERE wr.end_ts IS NOT NULL
  GROUP BY wr.wip_id
  ORDER BY cnt_wip_real DESC
  LIMIT 20
`);
console.log('\nE. WIPs terminados (wip_real end_ts NOT NULL) vs con costo FLUIDA:');
console.log('   wip_id | con_end_ts | con_costo_FLUIDA | % cobertura');
resGap.rows.forEach(r => {
  const pct = r.cnt_wip_real > 0 ? (r.cnt_con_costo/r.cnt_wip_real*100).toFixed(0) : 0;
  console.log(`   ${r.wip_id.padEnd(6)} | ${String(r.cnt_wip_real).padStart(10)} | ${String(r.cnt_con_costo).padStart(16)} | ${pct}%`);
});

await client.end();
console.log('\nDone.');
