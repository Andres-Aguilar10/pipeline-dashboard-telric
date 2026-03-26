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

// 1. Muestra de datos con todas las columnas de costo para OP IN
const data = JSON.parse(readFileSync('public/data/z0.json', 'utf8'));
const sampleOp = data.find(d => d.status === 'IN' && d.cotizador?.real_wips && Object.keys(d.cotizador.real_wips).length > 2);
const opId = sampleOp?.order_id?.trim();
console.log(`OP ${opId} (${sampleOp?.po_customer_name_grp}), ${sampleOp?.pol_requested_q} prendas:\n`);

const res = await client.query(`
  SELECT wip_id, prod_q, prendas_requeridas,
    costo_textil, costo_manufactura,
    costo_materia_prima, costo_avios, costo_tela,
    costo_indirecto_fijo, gasto_administracion, gasto_ventas
  FROM silver.costo_wip_op
  WHERE TRIM(pr_id) = $1
    AND version_calculo = 'FLUIDA'
    AND fecha_corrida = (SELECT MAX(fecha_corrida) FROM silver.costo_wip_op WHERE version_calculo='FLUIDA')
  ORDER BY wip_id
`, [opId]);

const qty = Number(sampleOp?.pol_requested_q) || 1;
console.log('Valores por prenda (total / prendas_requeridas):');
console.log('wip  | textil  | manuf   | tela    | MP      | avios   | CIF     | GA      | GV      | prod_q | prendasReq');
console.log('-----|---------|---------|---------|---------|---------|---------|---------|---------|--------|----------');
res.rows.forEach(r => {
  const q = Number(r.prendas_requeridas) || 1;
  const fmt = v => (Number(v||0)/q).toFixed(3).padStart(7);
  console.log(`${r.wip_id.padEnd(5)}| ${fmt(r.costo_textil)} | ${fmt(r.costo_manufactura)} | ${fmt(r.costo_tela)} | ${fmt(r.costo_materia_prima)} | ${fmt(r.costo_avios)} | ${fmt(r.costo_indirecto_fijo)} | ${fmt(r.gasto_administracion)} | ${fmt(r.gasto_ventas)} | ${String(r.prod_q||'').padStart(6)} | ${r.prendas_requeridas}`);
});

// 2. Cobertura de MP, avios, tela en costo_wip_op vs IN OPs
const inPrIds = data.filter(d => d.status === 'IN').map(d => d.order_id.trim());
const res2 = await client.query(`
  SELECT
    COUNT(DISTINCT pr_id) as ops_total,
    COUNT(DISTINCT pr_id) FILTER (WHERE costo_materia_prima > 0) as ops_con_mp,
    COUNT(DISTINCT pr_id) FILTER (WHERE costo_avios > 0) as ops_con_avios,
    COUNT(DISTINCT pr_id) FILTER (WHERE costo_tela > 0) as ops_con_tela,
    COUNT(DISTINCT pr_id) FILTER (WHERE costo_indirecto_fijo > 0) as ops_con_cif,
    COUNT(DISTINCT pr_id) FILTER (WHERE gasto_administracion > 0) as ops_con_ga,
    COUNT(DISTINCT pr_id) FILTER (WHERE gasto_ventas > 0) as ops_con_gv
  FROM silver.costo_wip_op
  WHERE version_calculo = 'FLUIDA'
    AND fecha_corrida = (SELECT MAX(fecha_corrida) FROM silver.costo_wip_op WHERE version_calculo='FLUIDA')
    AND TRIM(pr_id) = ANY($1)
`, [inPrIds]);
const r2 = res2.rows[0];
console.log(`\nCobertura en OPs IN (${inPrIds.length} total):`);
console.log(`  Con algún registro:  ${r2.ops_total} (${(r2.ops_total/inPrIds.length*100).toFixed(1)}%)`);
console.log(`  Con MP > 0:          ${r2.ops_con_mp} (${(r2.ops_con_mp/inPrIds.length*100).toFixed(1)}%)`);
console.log(`  Con Avíos > 0:       ${r2.ops_con_avios} (${(r2.ops_con_avios/inPrIds.length*100).toFixed(1)}%)`);
console.log(`  Con Tela > 0:        ${r2.ops_con_tela} (${(r2.ops_con_tela/inPrIds.length*100).toFixed(1)}%)`);
console.log(`  Con CIF > 0:         ${r2.ops_con_cif} (${(r2.ops_con_cif/inPrIds.length*100).toFixed(1)}%)`);
console.log(`  Con GA > 0:          ${r2.ops_con_ga} (${(r2.ops_con_ga/inPrIds.length*100).toFixed(1)}%)`);
console.log(`  Con GV > 0:          ${r2.ops_con_gv} (${(r2.ops_con_gv/inPrIds.length*100).toFixed(1)}%)`);

// 3. costo_textil vs costo_tela - son lo mismo o distintos?
const res3 = await client.query(`
  SELECT
    COUNT(*) FILTER (WHERE costo_tela > 0 AND costo_textil = 0) as solo_tela,
    COUNT(*) FILTER (WHERE costo_textil > 0 AND costo_tela = 0) as solo_textil,
    COUNT(*) FILTER (WHERE costo_textil > 0 AND costo_tela > 0) as ambos,
    COUNT(*) FILTER (WHERE ABS(COALESCE(costo_textil,0) - COALESCE(costo_tela,0)) < 0.01 AND costo_textil > 0) as iguales
  FROM silver.costo_wip_op
  WHERE version_calculo = 'FLUIDA'
    AND fecha_corrida = (SELECT MAX(fecha_corrida) FROM silver.costo_wip_op WHERE version_calculo='FLUIDA')
    AND TRIM(pr_id) = ANY($1)
`, [inPrIds]);
const r3 = res3.rows[0];
console.log(`\ncosto_textil vs costo_tela (filas de IN OPs):`);
console.log(`  Solo textil (tela=0): ${r3.solo_textil}`);
console.log(`  Solo tela (textil=0): ${r3.solo_tela}`);
console.log(`  Ambos con valor:      ${r3.ambos}`);
console.log(`  Son iguales:          ${r3.iguales}`);

await client.end();
