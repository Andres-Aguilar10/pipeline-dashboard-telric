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

const data = JSON.parse(readFileSync('public/data/z0.json', 'utf8'));
const inOps = data.filter(d => d.status === 'IN');
const inPrIds = inOps.map(d => d.order_id.trim());

// 1. ¿Cuántas IN OPs están en costo_op_detalle?
const res1 = await client.query(`
  SELECT COUNT(DISTINCT cod_ordpro) as total,
    COUNT(DISTINCT CASE WHEN version_calculo='FLUIDA' THEN cod_ordpro END) as fluida,
    MAX(fecha_corrida) as max_fecha
  FROM silver.costo_op_detalle
  WHERE TRIM(cod_ordpro) = ANY($1)
`, [inPrIds]);
console.log('1. IN OPs en costo_op_detalle:');
console.log('   Total (cualquier version):', res1.rows[0].total);
console.log('   Con version FLUIDA:        ', res1.rows[0].fluida);
console.log('   Max fecha_corrida:         ', res1.rows[0].max_fecha?.toISOString()?.substring(0,10));

// 2. Muestra de datos reales para 5 OPs IN
const maxFecha = res1.rows[0].max_fecha;
const res2 = await client.query(`
  SELECT TRIM(cod_ordpro) as op, prendas_requeridas,
    COALESCE(costo_indirecto_fijo::numeric,0) as cif,
    COALESCE(gasto_administracion::numeric,0) as ga,
    COALESCE(gasto_ventas::numeric,0) as gv,
    COALESCE(costo_avios::numeric,0) as avios,
    COALESCE(costo_materia_prima::numeric,0) as mp,
    fecha_corrida
  FROM silver.costo_op_detalle
  WHERE TRIM(cod_ordpro) = ANY($1)
    AND version_calculo = 'FLUIDA'
    AND fecha_corrida = $2
  LIMIT 8
`, [inPrIds, maxFecha]);
console.log('\n2. Muestra de costos reales IN OPs (FLUIDA, max fecha):');
console.log('   OP     | Prendas | CIF    | GA     | GV     | Avíos  | MP     ');
console.log('   -------|---------|--------|--------|--------|--------|--------');
res2.rows.forEach(r => {
  const qty = Number(r.prendas_requeridas)||1;
  console.log(`   ${r.op.padEnd(6)} | ${String(r.prendas_requeridas).padStart(7)} | ${(Number(r.cif)/qty).toFixed(2).padStart(6)} | ${(Number(r.ga)/qty).toFixed(2).padStart(6)} | ${(Number(r.gv)/qty).toFixed(2).padStart(6)} | ${(Number(r.avios)/qty).toFixed(2).padStart(6)} | ${(Number(r.mp)/qty).toFixed(2).padStart(6)}`);
});

// 3. ¿Qué % de IN OPs tienen data real vs cotizador?
const res3 = await client.query(`
  SELECT COUNT(DISTINCT TRIM(cod_ordpro)) as con_data
  FROM silver.costo_op_detalle
  WHERE TRIM(cod_ordpro) = ANY($1)
    AND version_calculo = 'FLUIDA'
    AND fecha_corrida = $2
`, [inPrIds, maxFecha]);
const conData = Number(res3.rows[0].con_data);
console.log(`\n3. Cobertura de IN OPs en costo_op_detalle (FLUIDA, max fecha):`);
console.log(`   Con data real: ${conData} de ${inPrIds.length} (${(conData/inPrIds.length*100).toFixed(1)}%)`);
console.log(`   Sin data real: ${inPrIds.length - conData} (${((inPrIds.length-conData)/inPrIds.length*100).toFixed(1)}%)`);

await client.end();
