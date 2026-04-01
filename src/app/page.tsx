"use client";

import { useState, useEffect, useMemo, useCallback, memo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Cell, ScatterChart, Scatter, ZAxis,
  CartesianGrid,
} from "recharts";

/* ───── Types ───── */
interface WipRangoData { textil: number; manuf: number; ops: number; prendas: number }
interface GastosData { cif: number; ga: number; gv: number; avios: number; mp: number; ops_con_gastos: number; ops_con_avios: number; ops_con_mp: number }
interface RangoData { name: string; ops: number; textil: number; manuf: number; costo_base: number; gastos?: GastosData; wips: Record<string, WipRangoData> }
interface RealWipData { textil: number; manuf: number }
interface RealMaterials { mp: number; avios: number }
interface Cotizador { rango_actual: string; total_ops_hist: number; wips_op: string[]; metodo?: string; rangos: Record<string, RangoData | null>; real_wips?: Record<string, RealWipData>; completed_wips?: string[]; real_materials?: RealMaterials }

interface Z0Row {
  order_id: string;
  status: string;
  po_customer_name: string;
  pol_garment_class_description: string;
  pol_garment_class_group_description: string;
  pol_customer_style_id: string;
  pols_factory_style_id: string;
  style_type: string;
  pol_unit_price: number;
  pol_amount_usd: number;
  pol_requested_q: number;
  due_date: string;
  po_published_t: string;
  po_shipment_type: string;
  pol_destination: string;
  po_season_year: string;
  po_season_id: string;
  cotizador?: Cotizador | null;
}

interface Z1Row {
  order_id: string;
  process_id: string;
  status: string;
  start_ts: string;
  end_ts: string;
  start_is_real: number;
  end_is_real: number;
  po_customer_name: string;
  pol_garment_class_description: string;
  pol_customer_style_id: string;
  pols_factory_style_id: string;
  style_type: string;
  pol_unit_price: number;
  pol_requested_q: number;
}

interface Z2Row {
  order_id: string;
  sku_category_id: string;
  sku_catalog_id: string;
  sku_id: string;
  des_sku_id: string;
  requirement_q: number;
  bom_ts: string;
}

/* ───── Constants ───── */
const PAGE_SIZE = 50;

const PROCESS_NAMES: Record<string, string> = {
  "10c": "Abast. Hilo", "14": "Teñido Hilado", "16": "Tejido Tela",
  "19a": "Teñido", "19c": "Despacho", "24": "Estampado Tela",
  "34": "Corte", "36": "Estampado Pieza", "37": "Bordado Pieza", "40": "Costura",
  "43": "Bordado Prenda", "44": "Estampado Prenda", "45": "Lavado Prenda",
  "49": "Acabado", "50": "Mov. Logístico",
};

const SKU_CAT: Record<string, { label: string; color: string }> = {
  A: { label: "Avíos", color: "bg-violet-50 text-violet-700 ring-violet-200" },
  H: { label: "Hilos", color: "bg-sky-50 text-sky-700 ring-sky-200" },
  T: { label: "Telas", color: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  M: { label: "Mat. Prima", color: "bg-amber-50 text-amber-700 ring-amber-200" },
};

const FACTORES_MARCA: Record<string, number> = {
  "LACOSTE": 1.05,
  "GREYSON": 1.05,
  "GREYSON CLOTHIERS": 1.10,
  "LULULEMON": 0.95,
  "PATAGONIA": 0.95,
};
const FACTOR_MARCA_DEFAULT = 1.10;
const MARGEN_BASE = 0.15;
const FACTOR_ESFUERZO = 1.0; // TODO: usar esfuerzo real cuando esté disponible

function getFactorMarca(cliente: string): number {
  const c = (cliente || "").toUpperCase().trim();
  for (const [marca, factor] of Object.entries(FACTORES_MARCA)) {
    if (c.includes(marca) || marca.includes(c)) return factor;
  }
  return FACTOR_MARCA_DEFAULT;
}

const STATUS_COLORS: Record<string, { bg: string; ring: string; text: string }> = {
  NI: { bg: "bg-amber-500", ring: "ring-amber-300", text: "text-white" },
  IN: { bg: "bg-emerald-500", ring: "ring-emerald-300", text: "text-white" },
  PO: { bg: "bg-[#821417]", ring: "ring-red-300", text: "text-white" },
};

/* ───── Helpers ───── */
function fmtDate(d: string | null) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("es-PE", { day: "2-digit", month: "short", year: "2-digit" });
}
function fmtNum(n: number | null) {
  if (n == null) return "";
  return Number(n).toLocaleString("es-PE");
}
function fmtUSD(n: number | null) {
  if (n == null || n === 0) return "";
  return `$${Number(n).toLocaleString("es-PE", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function fmtPrice(n: number | null) {
  if (n == null || n === 0) return "";
  return `$${Number(n).toFixed(2)}`;
}

/* ───── Micro-components ───── */
const StatusBadge = memo(({ status }: { status: string }) => {
  const s = STATUS_COLORS[status] || { bg: "bg-gray-400", ring: "ring-gray-200", text: "text-white" };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold tracking-wide ${s.bg} ${s.text} ring-1 ${s.ring}`}>{status}</span>;
});
StatusBadge.displayName = "StatusBadge";

const StyleBadge = memo(({ type }: { type: string }) => (
  <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ring-1 ${
    type === "recurrente" ? "bg-blue-50 text-blue-700 ring-blue-200" : "bg-orange-50 text-orange-700 ring-orange-200"
  }`}>{type}</span>
));
StyleBadge.displayName = "StyleBadge";

const CatBadge = memo(({ cat }: { cat: string }) => {
  const c = SKU_CAT[cat] || { label: cat, color: "bg-gray-50 text-gray-700 ring-gray-200" };
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ring-1 ${c.color}`}>{c.label}</span>;
});
CatBadge.displayName = "CatBadge";

function RealPlanDot({ isReal }: { isReal: number }) {
  return isReal
    ? <span className="inline-flex items-center gap-1 text-emerald-600 text-xs font-medium"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Real</span>
    : <span className="inline-flex items-center gap-1 text-gray-400 text-xs"><span className="w-1.5 h-1.5 rounded-full bg-gray-300" />Plan</span>;
}

/* ───── Pagination ───── */
function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  const pages: number[] = [];
  for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) pages.push(i);
  return (
    <div className="flex items-center gap-1 justify-center py-3">
      <button onClick={() => onPage(1)} disabled={page === 1} className="px-2 py-1 text-xs rounded hover:bg-gray-100 disabled:opacity-30">&laquo;</button>
      <button onClick={() => onPage(page - 1)} disabled={page === 1} className="px-2 py-1 text-xs rounded hover:bg-gray-100 disabled:opacity-30">&lsaquo;</button>
      {pages[0] > 1 && <span className="text-xs text-gray-400">...</span>}
      {pages.map((p) => (
        <button key={p} onClick={() => onPage(p)}
          className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${p === page ? "bg-[#821417] text-white" : "hover:bg-gray-100 text-gray-600"}`}
        >{p}</button>
      ))}
      {pages[pages.length - 1] < totalPages && <span className="text-xs text-gray-400">...</span>}
      <button onClick={() => onPage(page + 1)} disabled={page === totalPages} className="px-2 py-1 text-xs rounded hover:bg-gray-100 disabled:opacity-30">&rsaquo;</button>
      <button onClick={() => onPage(totalPages)} disabled={page === totalPages} className="px-2 py-1 text-xs rounded hover:bg-gray-100 disabled:opacity-30">&raquo;</button>
    </div>
  );
}

/* ───── Main ───── */
export default function Home() {
  const [z0Data, setZ0Data] = useState<Z0Row[]>([]);
  const [z1Data, setZ1Data] = useState<Z1Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);

  // Detail
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [z2Data, setZ2Data] = useState<Z2Row[]>([]);
  const [z2Loading, setZ2Loading] = useState(false);

  // Filters
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [customerFilter, setCustomerFilter] = useState("ALL");
  const [styleTypeFilter, setStyleTypeFilter] = useState("ALL");
  const [searchTerm, setSearchTerm] = useState("");
  const [marginFilter, setMarginFilter] = useState<"ALL" | "saludable" | "atencion" | "critico">("ALL");

  // Sorting
  const [sortCol, setSortCol] = useState<string>("order_id");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  useEffect(() => {
    Promise.all([
      fetch(`/data/z0.json?v=${Date.now()}`).then((r) => r.json()),
      fetch(`/data/z1.json?v=${Date.now()}`).then((r) => r.json()),
    ])
      .then(([z0, z1]) => { setZ0Data(z0); setZ1Data(z1); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const loadMaterials = useCallback((orderId: string) => {
    if (selectedOrder === orderId) { setSelectedOrder(null); return; }
    setSelectedOrder(orderId);
    setZ2Loading(true);
    fetch(`/api/z2?order_id=${orderId}`)
      .then((r) => r.json())
      .then((data) => { if (data.error) throw new Error(data.error); setZ2Data(data); })
      .catch(() => setZ2Data([]))
      .finally(() => setZ2Loading(false));
  }, [selectedOrder]);

  const statuses = useMemo(() => [...new Set(z0Data.map((r) => r.status))].filter(s => s === "NI" || s === "IN" || s === "PO").sort(), [z0Data]);
  const customers = useMemo(() => [...new Set(z0Data.map((r) => r.po_customer_name?.trim()).filter(Boolean))].sort(), [z0Data]);

  const toggleSort = useCallback((col: string) => {
    setSortCol(prev => { if (prev === col) { setSortDir(d => d === "asc" ? "desc" : "asc"); return prev; } setSortDir("asc"); return col; });
    if (sortCol !== col) setSortCol(col);
  }, [sortCol]);

  // Helper: classify margin
  const getMarginClass = useCallback((r: Z0Row): "saludable" | "atencion" | "critico" | "sin_dato" => {
    const costo = getCostoCotiz(r.cotizador);
    if (costo == null || !r.pol_unit_price || r.pol_unit_price <= 0) return "sin_dato";
    const margen = (r.pol_unit_price - costo) / r.pol_unit_price * 100;
    if (margen >= 10) return "saludable";
    if (margen >= 0) return "atencion";
    return "critico";
  }, []);

  const filtered = useMemo(() => {
    const f = z0Data.filter((r) => {
      if (statusFilter === "ALL") { if (r.status !== "NI" && r.status !== "IN" && r.status !== "PO") return false; }
      else if (r.status !== statusFilter) return false;
      if (customerFilter !== "ALL" && r.po_customer_name?.trim() !== customerFilter) return false;
      if (styleTypeFilter !== "ALL" && r.style_type !== styleTypeFilter) return false;
      if (marginFilter !== "ALL" && getMarginClass(r) !== marginFilter) return false;
      if (searchTerm) {
        const s = searchTerm.toLowerCase();
        const hay = [r.order_id, r.po_customer_name, r.pol_customer_style_id, r.pols_factory_style_id].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
    // Sort
    const col = sortCol;
    const dir = sortDir === "asc" ? 1 : -1;
    f.sort((a, b) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let va: any = (a as any)[col], vb: any = (b as any)[col];
      if (col === "costo_cotiz") { va = getCostoCotiz(a.cotizador) ?? -1; vb = getCostoCotiz(b.cotizador) ?? -1; }
      if (col === "precio_cotiz") { va = getPrecioCotiz(a.cotizador, a.po_customer_name) ?? -1; vb = getPrecioCotiz(b.cotizador, b.po_customer_name) ?? -1; }
      if (col === "costo_total") { const ca = getCostoCotiz(a.cotizador); const cb = getCostoCotiz(b.cotizador); va = ca != null ? ca * Number(a.pol_requested_q) : -1; vb = cb != null ? cb * Number(b.pol_requested_q) : -1; }
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va ?? "").localeCompare(String(vb ?? ""), "es", { numeric: true }) * dir;
    });
    return f;
  }, [z0Data, statusFilter, customerFilter, styleTypeFilter, marginFilter, searchTerm, sortCol, sortDir, getMarginClass]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

  // Reset page + selection on filter change
  useEffect(() => { setPage(1); setSelectedOrder(null); }, [statusFilter, customerFilter, styleTypeFilter, marginFilter, searchTerm]);

  const z1ForOrder = useMemo(() => {
    if (!selectedOrder) return [];
    return z1Data.filter((r) => r.order_id === selectedOrder)
      .sort((a, b) => a.process_id.localeCompare(b.process_id, undefined, { numeric: true }));
  }, [z1Data, selectedOrder]);

  // Last active WIP per IN order (from z1)
  const lastWipByOrder = useMemo(() => {
    const m: Record<string, string> = {};
    const sorted = [...z1Data].sort((a, b) => a.process_id.localeCompare(b.process_id, undefined, { numeric: true }));
    for (const r of sorted) {
      if (r.start_ts && r.start_is_real) m[r.order_id] = r.process_id;
    }
    return m;
  }, [z1Data]);

  // Margin counts — based on pre-margin-filtered data so counts stay stable
  const marginCounts = useMemo(() => {
    const base = z0Data.filter((r) => {
      if (statusFilter === "ALL") { if (r.status !== "NI" && r.status !== "IN" && r.status !== "PO") return false; }
      else if (r.status !== statusFilter) return false;
      if (customerFilter !== "ALL" && r.po_customer_name?.trim() !== customerFilter) return false;
      if (styleTypeFilter !== "ALL" && r.style_type !== styleTypeFilter) return false;
      if (searchTerm) {
        const s = searchTerm.toLowerCase();
        const hay = [r.order_id, r.po_customer_name, r.pol_customer_style_id, r.pols_factory_style_id].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
    let saludable = 0, atencion = 0, critico = 0;
    for (const r of base) {
      const cls = getMarginClass(r);
      if (cls === "saludable") saludable++;
      else if (cls === "atencion") atencion++;
      else if (cls === "critico") critico++;
    }
    return { saludable, atencion, critico };
  }, [z0Data, statusFilter, customerFilter, styleTypeFilter, searchTerm, getMarginClass]);

  const summary = useMemo(() => {
    const ni = filtered.filter((r) => r.status === "NI").length;
    const inP = filtered.filter((r) => r.status === "IN").length;
    const po = filtered.filter((r) => r.status === "PO").length;
    const totalQty = filtered.reduce((a, r) => a + (Number(r.pol_requested_q) || 0), 0);
    const totalUSD = filtered.reduce((a, r) => a + (Number(r.pol_amount_usd) || 0), 0);
    const conCotiz = filtered.filter((r) => r.cotizador).length;
    const sinCotiz = filtered.length - conCotiz;
    const today = new Date();
    const vencidas = filtered.filter((r) => r.due_date && new Date(r.due_date) < today).length;
    const avgQty = filtered.length > 0 ? Math.round(totalQty / filtered.length) : 0;
    return { ni, inP, po, total: filtered.length, totalQty, totalUSD, conCotiz, sinCotiz, vencidas, avgQty };
  }, [filtered]);

  // suppress unused var warnings
  void statuses;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 text-white" style={{ background: "linear-gradient(135deg, #821417 0%, #a32428 60%, #bd4c42 100%)", boxShadow: "0 4px 24px rgba(130,20,23,0.25)" }}>
        <div className="max-w-[1700px] mx-auto px-6 py-3.5 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-white/10 border border-white/20 flex items-center justify-center text-[11px] font-black tracking-tight shrink-0">TDV</div>
          <div>
            <h1 className="text-base font-bold tracking-tight leading-tight">Pipeline Dashboard</h1>
            <p className="text-[11px] text-white/50 mt-0.5">Textil del Valle &middot; Seguimiento de ordenes y rentabilidad</p>
          </div>
        </div>
      </header>

      <main className="max-w-[1700px] mx-auto px-6 py-5 flex-1">
        {/* Summary Cards */}
        {(() => {
          const cards = [
            { label: "Total Ordenes", value: fmtNum(summary.total), sub: `${fmtNum(summary.conCotiz)} con cotizador`, icon: "text-slate-500" },
            { label: "Prendas", value: fmtNum(summary.totalQty), sub: `${fmtNum(summary.avgQty)} prom. por OP`, icon: "text-slate-500" },
            { label: "Monto USD (Precio x Cant.)", value: fmtUSD(summary.totalUSD), sub: summary.totalUSD > 0 ? `$${(summary.totalUSD / summary.total).toFixed(0)} prom. por OP` : "", icon: "text-slate-500" },
            { label: "Sin Costo Estimado", value: fmtNum(summary.sinCotiz), sub: summary.total > 0 ? `${(summary.sinCotiz / summary.total * 100).toFixed(0)}% del total` : "", icon: "text-amber-500" },
            { label: "Fuera de Plazo", value: fmtNum(summary.vencidas), sub: summary.total > 0 ? `${(summary.vencidas / summary.total * 100).toFixed(0)}% del total` : "", icon: "text-red-500" },
          ];
          return (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
              {cards.map((c) => (
                <div key={c.label} className="bg-white rounded-xl border border-gray-100 px-4 py-3.5 shadow-sm">
                  <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">{c.label}</p>
                  <p className={`text-3xl font-extrabold leading-none ${c.icon}`}>{c.value}</p>
                  {c.sub && <p className="text-[11px] text-gray-400 mt-2 leading-tight">{c.sub}</p>}
                </div>
              ))}
            </div>
          );
        })()}

        {/* Status Tabs */}
        <div className="flex flex-wrap gap-2 mb-3">
          {[
            { key: "ALL", label: "Todos", count: z0Data.filter(r => r.status === "NI" || r.status === "IN" || r.status === "PO").length, color: "gray" },
            { key: "NI", label: "No Iniciadas", count: z0Data.filter(r => r.status === "NI").length, color: "amber" },
            { key: "IN", label: "En Produccion", count: z0Data.filter(r => r.status === "IN").length, color: "emerald" },
            { key: "PO", label: "Solo PO", count: z0Data.filter(r => r.status === "PO").length, color: "red" },
          ].map((tab) => {
            const active = statusFilter === tab.key;
            const colorMap: Record<string, string> = {
              gray: active ? "bg-slate-700 text-white" : "bg-white text-gray-500 hover:bg-gray-50",
              amber: active ? "bg-amber-600/80 text-white" : "bg-white text-amber-700 hover:bg-amber-50",
              emerald: active ? "bg-emerald-600/80 text-white" : "bg-white text-emerald-700 hover:bg-emerald-50",
              red: active ? "bg-[#821417]/90 text-white" : "bg-white text-[#821417] hover:bg-red-50",
            };
            return (
              <button key={tab.key} onClick={() => setStatusFilter(tab.key)}
                className={`px-4 py-2 rounded-full text-sm font-medium border transition-all ${active ? "border-transparent shadow-md" : "border-gray-200"} ${colorMap[tab.color]}`}>
                {tab.label} <span className={`ml-1.5 text-xs font-bold ${active ? "opacity-80" : "opacity-60"}`}>{tab.count}</span>
              </button>
            );
          })}
        </div>

        {/* Filters — compact inline */}
        <div className="flex flex-wrap gap-2.5 items-end mb-5">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-[11px] font-medium text-gray-400 uppercase tracking-wider mb-1">Buscar</label>
            <input type="text" placeholder="Orden, cliente, estilo..."
              className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 focus:border-slate-400 transition-shadow bg-white"
              value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          <FSelect label="Cliente" value={customerFilter} options={customers} onChange={setCustomerFilter} />
          <FSelect label="Tipo" value={styleTypeFilter} options={["nuevo", "recurrente"]} onChange={setStyleTypeFilter} />
          <button onClick={() => { setStatusFilter("ALL"); setCustomerFilter("ALL"); setStyleTypeFilter("ALL"); setMarginFilter("ALL"); setSearchTerm(""); }}
            className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors">Limpiar</button>
        </div>

        {/* Margin Classification Bar */}
        {!loading && !error && (marginCounts.saludable > 0 || marginCounts.atencion > 0 || marginCounts.critico > 0) && (
          <div className="mb-5">
            <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2.5">Clasificacion por margen</p>
            <div className="grid grid-cols-3 gap-3">
              {[
                { key: "saludable" as const, count: marginCounts.saludable, label: "Saludable", sub: "Margen >= 10%", bg: marginFilter === "saludable" ? "bg-green-600" : "bg-green-500", cardBg: marginFilter === "saludable" ? "bg-green-50 border-green-300 shadow-md" : "bg-white border-gray-200 hover:border-green-300", textColor: "text-green-800" },
                { key: "atencion" as const, count: marginCounts.atencion, label: "Atencion", sub: "Margen 0% - 9.9%", bg: marginFilter === "atencion" ? "bg-amber-600" : "bg-amber-500", cardBg: marginFilter === "atencion" ? "bg-amber-50 border-amber-300 shadow-md" : "bg-white border-gray-200 hover:border-amber-300", textColor: "text-amber-800" },
                { key: "critico" as const, count: marginCounts.critico, label: "Critico", sub: "Margen negativo", bg: marginFilter === "critico" ? "bg-red-700" : "bg-red-600", cardBg: marginFilter === "critico" ? "bg-red-50 border-red-300 shadow-md" : "bg-white border-gray-200 hover:border-red-300", textColor: "text-red-800" },
              ].map(item => (
                <button key={item.key}
                  onClick={() => setMarginFilter(prev => prev === item.key ? "ALL" : item.key)}
                  className={`flex items-center gap-3 rounded-xl border px-4 py-3 transition-all cursor-pointer text-left ${item.cardBg}`}>
                  <div className={`w-10 h-10 rounded-full ${item.bg} text-white flex items-center justify-center text-base font-bold shrink-0 transition-colors`}>
                    {item.count}
                  </div>
                  <div>
                    <p className={`text-sm font-bold ${item.textColor}`}>{item.label}</p>
                    <p className="text-[11px] text-gray-500 leading-tight mt-0.5">{item.sub}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Analytics */}
        {!loading && !error && <AnalyticsSection data={filtered} onSelectOp={loadMaterials} selectedOrder={selectedOrder} />}

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="animate-spin rounded-full h-8 w-8 border-[3px] border-[#821417] border-t-transparent" />
            <span className="ml-3 text-gray-400 text-sm">Cargando...</span>
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-100 rounded-xl p-8 text-center">
            <p className="text-[#821417] font-semibold">Error al cargar datos</p>
            <p className="text-sm text-gray-500 mt-1">{error}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2.5 px-0.5">
              <p className="text-xs font-bold text-gray-700 uppercase tracking-wider">Ordenes de Produccion</p>
              <p className="text-[11px] text-gray-400">
                {fmtNum(filtered.length)} registros
              </p>
            </div>
            <TableCard count={filtered.length} page={page} totalPages={totalPages} onPage={setPage}>
              <Z0Table rows={paged as Z0Row[]} selectedOrder={selectedOrder} onSelect={loadMaterials} sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} lastWipByOrder={lastWipByOrder} />
            </TableCard>
            {selectedOrder && (() => {
              const opSel = z0Data.find(r => r.order_id === selectedOrder);
              const costo = opSel ? getCostoCotiz(opSel.cotizador) : null;
              const precio = opSel ? getPrecioCotiz(opSel.cotizador, opSel.po_customer_name) : null;
              const gap = precio != null && opSel?.pol_unit_price ? opSel.pol_unit_price - costo! : null;
              const ganancia = gap != null && opSel?.pol_requested_q ? gap * opSel.pol_requested_q : null;
              const isLoss = ganancia != null && ganancia < 0;
              return (
                <div className={`mt-3 rounded-xl border shadow-sm overflow-hidden ${isLoss ? "border-red-200 bg-red-50/40" : "border-emerald-200 bg-emerald-50/40"}`}>
                  <div className="flex items-stretch gap-0 divide-x divide-gray-200/70">
                    <div className={`w-1.5 shrink-0 ${isLoss ? "bg-red-400" : "bg-emerald-400"}`} />
                    <div className="flex-1 px-5 py-4">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">OP seleccionada</span>
                        <button onClick={() => setSelectedOrder(null)} className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors ml-auto">&times; Cerrar</button>
                      </div>
                      <p className="text-sm font-bold text-gray-900">{selectedOrder} <span className="font-normal text-gray-500">&middot; {opSel?.po_customer_name?.trim()}</span></p>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        {Number(opSel?.pol_requested_q).toLocaleString()} prendas
                        {opSel?.pol_unit_price ? <> &middot; Precio <b className="text-gray-700">${Number(opSel.pol_unit_price).toFixed(2)}</b></> : " · Sin precio"}
                        {costo != null ? <> &middot; Costo <b className="text-gray-700">${costo.toFixed(2)}</b></> : " · Sin cotizador"}
                        <span className="ml-2 text-[11px] font-medium text-gray-400">{opSel?.pol_garment_class_description?.trim()} &middot; {opSel?.status}</span>
                      </p>
                    </div>
                    {gap != null && (
                      <div className="px-5 py-4 text-center min-w-[130px]">
                        <p className="text-[11px] text-gray-400 uppercase tracking-wider mb-1">Gap / prenda</p>
                        <p className={`text-xl font-bold ${isLoss ? "text-red-600" : "text-emerald-600"}`}>{gap > 0 ? "+" : ""}{gap.toFixed(2)}</p>
                      </div>
                    )}
                    {ganancia != null && (
                      <div className="px-5 py-4 text-center min-w-[160px]">
                        <p className="text-[11px] text-gray-400 uppercase tracking-wider mb-1">{isLoss ? "Perdida total" : "Ganancia total"}</p>
                        <p className={`text-xl font-bold ${isLoss ? "text-red-600" : "text-emerald-600"}`}>{ganancia > 0 ? "+" : ""}${Math.abs(ganancia).toLocaleString("es-PE", { maximumFractionDigits: 0 })}</p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
            {selectedOrder && <DetailPanel orderId={selectedOrder} z1={z1ForOrder} z2={z2Data} z2Loading={z2Loading} opData={z0Data.find(r => r.order_id === selectedOrder)} />}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white">
        <div className="max-w-[1700px] mx-auto px-6 py-3 text-center">
          <p className="text-[11px] text-gray-400">TDV Textil del Valle &middot; Pipeline Dashboard &middot; Datos actualizados al {new Date().toLocaleDateString("es-PE", { day: "2-digit", month: "long", year: "numeric" })}</p>
        </div>
      </footer>
    </div>
  );
}

/* ───── Analytics Section ───── */
const MARCA_COLORS_A = ["#821417", "#10b981", "#f59e0b", "#3b82f6", "#8b5cf6", "#f472b6", "#14b8a6"];
const AVANCE_COLORS_A = ["#e5e7eb", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#10b981"];

type ScatterPoint = { x: number; y: number; z: number; impacto: number; op: string; marca: string; qty: number; gap: number; status: string };

function AnalyticsSection({ data, onSelectOp, selectedOrder }: { data: Z0Row[]; onSelectOp: (id: string) => void; selectedOrder: string | null }) {
  const [chartSelected, setChartSelected] = useState<ScatterPoint | null>(null);

  const analytics = useMemo(() => {
    const avanceDist = [
      { name: "0%", count: 0 }, { name: "1-25%", count: 0 }, { name: "26-50%", count: 0 },
      { name: "51-75%", count: 0 }, { name: "76-99%", count: 0 }, { name: "100%", count: 0 },
    ];
    const marcaMap: Record<string, number> = {};
    const scatterData: ScatterPoint[] = [];

    for (const d of data) {
      const wips = d.cotizador?.wips_op || [];
      const done = (d.cotizador?.completed_wips || []).filter(w => wips.includes(w));
      const pct = wips.length > 0 ? Math.round(done.length / wips.length * 100) : 0;
      if (pct === 0) avanceDist[0].count++;
      else if (pct <= 25) avanceDist[1].count++;
      else if (pct <= 50) avanceDist[2].count++;
      else if (pct <= 75) avanceDist[3].count++;
      else if (pct < 100) avanceDist[4].count++;
      else avanceDist[5].count++;

      const m = d.po_customer_name?.trim() || "N/A";
      marcaMap[m] = (marcaMap[m] || 0) + 1;

      if (d.pol_unit_price > 0 && d.cotizador) {
        const costo = getCostoCotiz(d.cotizador);
        if (costo != null) {
          const precio = +Number(d.pol_unit_price).toFixed(2);
          const qty = +d.pol_requested_q || 0;
          const gap = +(precio - costo).toFixed(2);
          const impacto = +(gap * qty).toFixed(0);
          scatterData.push({ x: precio, y: costo, z: Math.max(30, Math.sqrt(Math.abs(impacto)) * 2), impacto, op: d.order_id.trim(), marca: m, qty, gap, status: d.status });
        }
      }
    }

    const topMarcas = Object.entries(marcaMap).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([name, value]) => ({ name, value }));
    const scatterNI = scatterData.filter(s => s.status === "NI");
    const scatterIN = scatterData.filter(s => s.status === "IN");
    const scatterOther = scatterData.filter(s => s.status !== "NI" && s.status !== "IN");
    const marcaBarData = topMarcas.map(m => ({
      name: m.name.length > 10 ? m.name.slice(0, 10) + "\u2026" : m.name,
      total: m.value,
      sinCot: data.filter(d => (d.po_customer_name?.trim() || "N/A") === m.name && !d.cotizador).length,
    }));

    // Convert pie to horizontal bar for OPs por cliente
    const marcaHBarData = topMarcas.map(m => ({
      name: m.name.length > 12 ? m.name.slice(0, 12) + "\u2026" : m.name,
      ops: m.value,
    }));

    // Rentabilidad neta por cliente
    const rentMap: Record<string, { ganancia: number; perdida: number; ops: number }> = {};
    for (const s of scatterData) {
      if (!rentMap[s.marca]) rentMap[s.marca] = { ganancia: 0, perdida: 0, ops: 0 };
      rentMap[s.marca].ops++;
      if (s.impacto >= 0) rentMap[s.marca].ganancia += s.impacto;
      else rentMap[s.marca].perdida += s.impacto;
    }
    const rentByCliente = Object.entries(rentMap)
      .map(([name, v]) => ({ name: name.length > 16 ? name.slice(0, 16) + "\u2026" : name, neto: Math.round(v.ganancia + v.perdida), ganancia: Math.round(v.ganancia), perdida: Math.round(v.perdida), ops: v.ops }))
      .sort((a, b) => a.neto - b.neto);

    // Diagonal y=x para scatter
    const diagLine: ScatterPoint[] = scatterData.length > 0 ? (() => {
      const allVals = scatterData.flatMap(s => [s.x, s.y]);
      const mn = Math.min(...allVals) * 0.9;
      const mx = Math.max(...allVals) * 1.05;
      return [
        { x: mn, y: mn, z: 1, impacto: 0, op: "", marca: "", qty: 0, gap: 0, status: "" },
        { x: mx, y: mx, z: 1, impacto: 0, op: "", marca: "", qty: 0, gap: 0, status: "" },
      ];
    })() : [];

    return { avanceDist, topMarcas, marcaBarData, marcaHBarData, scatterNI, scatterIN, scatterOther, rentByCliente, diagLine, conPrecio: scatterData.length };
  }, [data]);

  const cardBase = "rounded-xl border px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)]";

  // Derived context for selected OP — used to highlight other charts
  const selectedCtx = useMemo(() => {
    if (!chartSelected) return null;
    const d = data.find(r => r.order_id.trim() === chartSelected.op);
    const wips = d?.cotizador?.wips_op || [];
    const done = (d?.cotizador?.completed_wips || []).filter(w => wips.includes(w));
    const pct = wips.length > 0 ? Math.round(done.length / wips.length * 100) : 0;
    let bucket = "0%";
    if (pct > 0 && pct <= 25) bucket = "1-25%";
    else if (pct > 25 && pct <= 50) bucket = "26-50%";
    else if (pct > 50 && pct <= 75) bucket = "51-75%";
    else if (pct > 75 && pct < 100) bucket = "76-99%";
    else if (pct === 100) bucket = "100%";
    return { bucket, marca: chartSelected.marca };
  }, [chartSelected, data]);

  // Sync chartSelected with table selection
  useEffect(() => {
    if (!selectedOrder) { setChartSelected(null); return; }
    const id = selectedOrder.trim();
    const allScatter = [...analytics.scatterNI, ...analytics.scatterIN, ...analytics.scatterOther];
    const pt = allScatter.find(p => p.op === id);
    if (pt) { setChartSelected(pt); }
    else setChartSelected(null);
  }, [selectedOrder, analytics.scatterNI, analytics.scatterIN, analytics.scatterOther]);

  function handleScatterClick(pt: ScatterPoint) {
    setChartSelected(pt);
    onSelectOp(pt.op);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scatterTooltip = ({ payload }: any) => {
    if (!payload?.length) return null;
    const d = payload[0].payload as ScatterPoint;
    if (!d.op) return null;
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-2.5 shadow-lg text-[11px]">
        <p className="font-semibold text-gray-800 mb-1">OP {d.op} &middot; {d.marca}</p>
        <p className="text-gray-500">Precio: <b>${Number(d.x).toFixed(2)}</b> &middot; Costo: <b>${Number(d.y).toFixed(2)}</b></p>
        <p className="text-gray-500">Gap: <b className={d.impacto < 0 ? "text-red-600" : "text-emerald-600"}>{d.gap > 0 ? "+" : ""}{Number(d.gap).toFixed(2)}/pda</b> &middot; {Number(d.qty).toLocaleString()} prendas</p>
        <p className={`font-semibold mt-1 ${d.impacto < 0 ? "text-red-600" : "text-emerald-600"}`}>{d.impacto < 0 ? "Perdida" : "Ganancia"}: ${Math.abs(Number(d.impacto)).toLocaleString()}</p>
      </div>
    );
  };

  return (
    <div className="mb-5">
      <p className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-3">Analisis de Rentabilidad</p>

      {/* Row 1: Rentabilidad por cliente + Scatter */}
      {analytics.conPrecio > 0 && (
        <div className="grid grid-cols-2 gap-4 mb-4">
          {/* Rentabilidad neta por cliente */}
          <div className={`${cardBase} bg-white border-gray-100`}>
            <p className="text-[11px] font-bold text-gray-900 uppercase tracking-wider">Rentabilidad neta por cliente</p>
            <p className="text-[11px] text-gray-400 mb-3 mt-0.5"><span className="text-emerald-600 font-medium">Verde = neto positivo</span> &middot; <span className="text-red-500 font-medium">Rojo = perdida neta</span></p>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={analytics.rentByCliente} layout="vertical" barSize={14} margin={{ top: 0, right: 64, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
                <XAxis type="number" tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 9, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 9, fill: "#6b7280" }} axisLine={false} tickLine={false} width={72} />
                <Tooltip
                  contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e5e7eb" }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(v: any, _: any, p: any) => [`$${Math.abs(Number(v)).toLocaleString()}`, p.payload.neto < 0 ? "Perdida neta" : "Ganancia neta"]}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  labelFormatter={(l: any) => `${l} \u00b7 ${analytics.rentByCliente.find(r => r.name === l)?.ops ?? 0} OPs`}
                />
                <Bar dataKey="neto" radius={[0, 3, 3, 0]}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  label={{ position: "right", formatter: (v: any) => `$${(Math.abs(v) / 1000).toFixed(1)}K`, fontSize: 9, fill: "#9ca3af" }}>
                  {analytics.rentByCliente.map((d, i) => (
                    <Cell key={i} fill={d.neto >= 0 ? "#10b981" : "#ef4444"} fillOpacity={0.78} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* Scatter Precio vs Costo */}
          <div className={`${cardBase} bg-white border-gray-100`}>
            <div className="flex items-start justify-between mb-2">
              <div>
                <p className="text-[11px] font-bold text-gray-900 uppercase tracking-wider">Precio vs Costo</p>
                <p className="text-[11px] text-gray-400 mt-0.5">Sobre diagonal = perdida &middot; Tamano = impacto total</p>
              </div>
              <div className="flex gap-2 text-[11px] text-gray-500 shrink-0">
                {analytics.scatterNI.length > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> NI ({analytics.scatterNI.length})</span>}
                {analytics.scatterIN.length > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> IN ({analytics.scatterIN.length})</span>}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <ScatterChart margin={{ top: 10, right: 20, bottom: 24, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis type="number" dataKey="x" name="Precio" tickFormatter={v => `$${v}`} tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} label={{ value: "Precio cliente ($/pda)", position: "insideBottom", offset: -14, fontSize: 11, fill: "#9ca3af" }} />
                <YAxis type="number" dataKey="y" name="Costo" tickFormatter={v => `$${v}`} tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} label={{ value: "Costo cotizador", angle: -90, position: "insideLeft", offset: 10, fontSize: 11, fill: "#9ca3af" }} />
                <ZAxis type="number" dataKey="z" range={[20, 400]} />
                <Tooltip content={scatterTooltip} />
                {analytics.diagLine.length > 0 && (
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  <Scatter name="_diag" data={analytics.diagLine} line={{ stroke: "#94a3b8", strokeDasharray: "5 3", strokeWidth: 1.5 } as any} shape={() => <g />} legendType="none" fill="transparent" />
                )}
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {analytics.scatterNI.length > 0 && <Scatter name="NI" data={analytics.scatterNI} fill="#f59e0b44" stroke="#f59e0b" strokeWidth={1.5} cursor="pointer" onClick={(d: any) => handleScatterClick(d as ScatterPoint)} />}
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {analytics.scatterIN.length > 0 && <Scatter name="IN" data={analytics.scatterIN} fill="#10b98144" stroke="#10b981" strokeWidth={1.5} cursor="pointer" onClick={(d: any) => handleScatterClick(d as ScatterPoint)} />}
                {analytics.scatterOther.length > 0 && (
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  <Scatter name="PO/Otros" data={analytics.scatterOther} fill="#94a3b844" stroke="#94a3b8" strokeWidth={1} cursor="pointer" onClick={(d: any) => handleScatterClick(d as ScatterPoint)} />
                )}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Row 2: Cobertura + OPs por cliente (bar) + Avance WIPs */}
      <div className="grid grid-cols-3 gap-4">
        {/* Cobertura de cotizador por marca */}
        <div className={`${cardBase} bg-white border-gray-100`}>
          <p className="text-[11px] font-bold text-gray-900 uppercase tracking-wider">Cobertura de cotizador por marca</p>
          <p className="text-[11px] text-gray-400 mb-3 mt-0.5"><span className="text-[#821417] font-medium">Total OPs</span> vs <span className="text-amber-500 font-medium">sin cotizador</span></p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={analytics.marcaBarData} barSize={10} margin={{ top: 0, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 9, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e5e7eb" }} />
              <Bar dataKey="total" name="Total OPs" fill="#821417" radius={[3, 3, 0, 0]}>
                {analytics.marcaBarData.map((entry, i) => (
                  <Cell key={i} fill="#821417"
                    fillOpacity={selectedCtx ? (entry.name.replace("\u2026","").trim() === selectedCtx.marca.slice(0,10).trim() || selectedCtx.marca.startsWith(entry.name.replace("\u2026","")) ? 1 : 0.2) : 0.75}
                    stroke={selectedCtx?.marca.startsWith(entry.name.replace("\u2026","")) ? "#821417" : "none"}
                    strokeWidth={2}
                  />
                ))}
              </Bar>
              <Bar dataKey="sinCot" name="Sin cotiz." fill="#f59e0b" radius={[3, 3, 0, 0]}>
                {analytics.marcaBarData.map((entry, i) => (
                  <Cell key={i} fill="#f59e0b"
                    fillOpacity={selectedCtx ? (selectedCtx.marca.startsWith(entry.name.replace("\u2026","")) ? 1 : 0.2) : 0.75}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        {/* OPs por cliente — horizontal bar (converted from pie) */}
        <div className={`${cardBase} bg-white border-gray-100`}>
          <p className="text-[11px] font-bold text-gray-900 uppercase tracking-wider">OPs por cliente</p>
          <p className="text-[11px] text-gray-400 mb-3 mt-0.5">Distribucion del portafolio activo</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={analytics.marcaHBarData} layout="vertical" barSize={14} margin={{ top: 0, right: 32, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 9, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 9, fill: "#6b7280" }} axisLine={false} tickLine={false} width={72} />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e5e7eb" }} formatter={(v) => [v + " OPs", "Cantidad"]} />
              <Bar dataKey="ops" name="OPs" radius={[0, 3, 3, 0]}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                label={{ position: "right", formatter: (v: any) => v, fontSize: 9, fill: "#9ca3af" }}>
                {analytics.marcaHBarData.map((entry, i) => (
                  <Cell key={i} fill={MARCA_COLORS_A[i % MARCA_COLORS_A.length]}
                    fillOpacity={selectedCtx ? (selectedCtx.marca.startsWith(entry.name.replace("\u2026","")) ? 1 : 0.2) : 0.85}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        {/* Avance de WIPs */}
        <div className={`${cardBase} bg-white border-gray-100`}>
          <p className="text-[11px] font-bold text-gray-900 uppercase tracking-wider">Avance de WIPs por OP</p>
          <p className="text-[11px] text-gray-400 mb-3 mt-0.5">% de procesos completados del total de WIPs por orden</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={analytics.avanceDist} barSize={28} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e5e7eb", boxShadow: "0 4px 6px -1px rgba(0,0,0,.06)" }} formatter={(v) => [v + " OPs", "Cantidad"]} />
              <Bar dataKey="count" name="OPs" radius={[4, 4, 0, 0]}>
                {analytics.avanceDist.map((entry, i) => (
                  <Cell key={i} fill={AVANCE_COLORS_A[i]}
                    fillOpacity={selectedCtx ? (entry.name === selectedCtx.bucket ? 1 : 0.2) : 1}
                    stroke={selectedCtx?.bucket === entry.name ? "#821417" : "none"}
                    strokeWidth={2}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

/* ───── Table Card wrapper ───── */
function TableCard({ children, count, page, totalPages, onPage }: { children: React.ReactNode; count: number; page: number; totalPages: number; onPage: (p: number) => void }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden">
      <div className="overflow-x-auto">{children}</div>
      <div className="border-t border-gray-100 px-4 flex items-center justify-between">
        <span className="text-[11px] text-gray-400">{fmtNum(count)} registros &middot; Pag {page}/{totalPages}</span>
        <Pagination page={page} totalPages={totalPages} onPage={onPage} />
      </div>
    </div>
  );
}

/* ───── Filter Select ───── */
function FSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div className="min-w-[130px]">
      <label className="block text-[11px] font-medium text-gray-400 uppercase tracking-wider mb-1">{label}</label>
      <select className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-300 focus:border-slate-400 transition-shadow"
        value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="ALL">Todos</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

/* ───── Cotizador helpers ───── */
function getCostoCotiz(cot: Cotizador | null | undefined): number | null {
  if (!cot) return null;
  const r = cot.rangos[cot.rango_actual] ?? cot.rangos["promedio"];
  if (!r) return null;
  const g = r.gastos;
  let costoBase = r.costo_base;

  // Hybrid: replace estimated WIP costs with real costs for completed WIPs
  if (cot.real_wips && cot.completed_wips && cot.completed_wips.length > 0) {
    const wipsOPSet = new Set(cot.wips_op);
    const completedSet = new Set(cot.completed_wips);
    let realTotal = 0;
    let estTotal = 0;
    for (const w of wipsOPSet) {
      const realW = cot.real_wips[w];
      if (completedSet.has(w) && realW) {
        realTotal += realW.textil + realW.manuf;
      } else if (r.wips[w]) {
        estTotal += r.wips[w].textil + r.wips[w].manuf;
      }
    }
    costoBase = realTotal + estTotal;
  }

  const mp    = (cot.real_materials?.mp    !== undefined && cot.real_materials.mp    > 0) ? cot.real_materials.mp    : (g?.mp    ?? 0);
  const avios = (cot.real_materials?.avios !== undefined && cot.real_materials.avios > 0) ? cot.real_materials.avios : (g?.avios ?? 0);
  return costoBase + (g ? g.cif + g.ga + g.gv : 0) + mp + avios;
}

function getPrecioCotiz(cot: Cotizador | null | undefined, cliente: string): number | null {
  const costo = getCostoCotiz(cot);
  if (costo == null) return null;
  const fm = getFactorMarca(cliente);
  const vectorTotal = FACTOR_ESFUERZO * fm;
  return costo * (1 + MARGEN_BASE * vectorTotal);
}

/* ───── Table styles ───── */
const th = "px-3 py-2.5 text-left text-[11px] font-bold text-gray-500 uppercase tracking-widest bg-red-50/50 border-b border-gray-200 whitespace-nowrap sticky top-0";
const td = "px-3 py-2.5 text-[13px] border-b border-gray-100 whitespace-nowrap";

/* ───── Sortable Header ───── */
function SortTh({ col, label, sortCol, sortDir, onSort, right }: { col: string; label: string; sortCol: string; sortDir: string; onSort: (c: string) => void; right?: boolean }) {
  const active = sortCol === col;
  return (
    <th className={`${th} ${right ? "text-right" : ""} cursor-pointer select-none group hover:bg-slate-200/60 transition-colors`}
      onClick={(e) => { e.stopPropagation(); onSort(col); }}>
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-[9px] transition-opacity ${active ? "opacity-100" : "opacity-0 group-hover:opacity-40"}`}>
          {active ? (sortDir === "asc" ? "\u25B2" : "\u25BC") : "\u25B2"}
        </span>
      </span>
    </th>
  );
}

/* ───── Z0 Table ───── */
const Z0Table = memo(({ rows, selectedOrder, onSelect, sortCol, sortDir, onSort, lastWipByOrder }: { rows: Z0Row[]; selectedOrder: string | null; onSelect: (id: string) => void; sortCol: string; sortDir: string; onSort: (c: string) => void; lastWipByOrder: Record<string, string> }) => (
  <table className="w-full">
    <thead><tr>
      <th className={th} style={{width:28}}></th>
      <SortTh col="status" label="Status" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
      <SortTh col="order_id" label="OP" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
      <SortTh col="po_customer_name" label="Cliente" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
      <SortTh col="pol_garment_class_description" label="Prenda" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
      <SortTh col="pol_customer_style_id" label="Est. Cliente" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
      <SortTh col="style_type" label="Tipo" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
      <th className={th}>WIP Actual</th>
      <SortTh col="pol_unit_price" label="Precio" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
      <SortTh col="pol_requested_q" label="Cant." sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
      <SortTh col="pol_amount_usd" label="Monto USD" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
      <SortTh col="costo_cotiz" label="Costo Cotiz." sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
      <SortTh col="precio_cotiz" label="Precio Cotiz." sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
      <SortTh col="costo_total" label="Costo Total" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
      <SortTh col="due_date" label="Due Date" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
    </tr></thead>
    <tbody>
      {rows.map((r, idx) => {
        const sel = selectedOrder === r.order_id;
        const isOverdue = r.due_date && new Date(r.due_date) < new Date();
        const lastWip = lastWipByOrder[r.order_id];
        return (
          <tr key={r.order_id} onClick={() => onSelect(r.order_id)}
            className={`cursor-pointer transition-colors ${sel ? "bg-red-50/60" : idx % 2 === 0 ? "hover:bg-gray-50/80 bg-white" : "hover:bg-gray-100/60 bg-gray-50/50"}`}>
            <td className={td}>
              <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-[11px] transition-colors ${sel ? "bg-[#821417] text-white" : "text-gray-400"}`}>
                {sel ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg> : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>}
              </span>
            </td>
            <td className={td}><StatusBadge status={r.status} /></td>
            <td className={`${td} font-mono text-xs font-bold text-[#821417]`}>{r.order_id}</td>
            <td className={`${td} max-w-[180px] truncate`}>{r.po_customer_name?.trim()}</td>
            <td className={`${td} max-w-[140px] truncate`}>{r.pol_garment_class_description?.trim()}</td>
            <td className={`${td} font-mono text-xs`}>{r.pol_customer_style_id?.trim()}</td>
            <td className={td}><StyleBadge type={r.style_type} /></td>
            <td className={td}>
              {r.status === "IN" && lastWip ? (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium ring-1 bg-emerald-50 text-emerald-700 ring-emerald-200">
                  {lastWip} {PROCESS_NAMES[lastWip] ? `- ${PROCESS_NAMES[lastWip]}` : ""}
                </span>
              ) : <span className="text-gray-300">&mdash;</span>}
            </td>
            <td className={`${td} text-right tabular-nums`}>{fmtPrice(r.pol_unit_price)}</td>
            <td className={`${td} text-right tabular-nums font-medium`}>{fmtNum(r.pol_requested_q)}</td>
            <td className={`${td} text-right tabular-nums`}>{fmtUSD(r.pol_amount_usd)}</td>
            <td className={`${td} text-right tabular-nums`}>
              {(() => { const c = getCostoCotiz(r.cotizador); return c != null ? <span className="text-[#821417] font-medium">${c.toFixed(2)}</span> : <span className="text-gray-300">&mdash;</span>; })()}
            </td>
            <td className={`${td} text-right tabular-nums`}>
              {(() => { const p = getPrecioCotiz(r.cotizador, r.po_customer_name); return p != null ? <span className="text-emerald-700 font-medium">${p.toFixed(2)}</span> : <span className="text-gray-300">&mdash;</span>; })()}
            </td>
            <td className={`${td} text-right tabular-nums`}>
              {(() => { const c = getCostoCotiz(r.cotizador); const q = Number(r.pol_requested_q); return c != null ? <span className="text-[#821417] font-medium">{fmtUSD(c * q)}</span> : <span className="text-gray-300">&mdash;</span>; })()}
            </td>
            <td className={`${td} ${isOverdue ? "text-red-500 font-medium" : "text-gray-500"}`}>{fmtDate(r.due_date)}{isOverdue ? " !" : ""}</td>
          </tr>
        );
      })}
    </tbody>
  </table>
));
Z0Table.displayName = "Z0Table";

/* ───── Detail Panel ───── */
const RANGO_ORDER = ["promedio", "pequeno", "mediano", "grande", "masivo"] as const;
const TEXTIL_WIPS = new Set(["10c", "14", "16", "19a", "19c", "24"]);

function DetailPanel({ orderId, z1, z2, z2Loading, opData }: { orderId: string; z1: Z1Row[]; z2: Z2Row[]; z2Loading: boolean; opData?: Z0Row }) {
  const [dtab, setDtab] = useState<"proc" | "mat" | "cotiz">(opData?.cotizador ? "cotiz" : "proc");
  const z2Cats = useMemo(() => {
    const m: Record<string, number> = {};
    z2.forEach((r) => { m[r.sku_category_id] = (m[r.sku_category_id] || 0) + 1; });
    return m;
  }, [z2]);

  const cot = opData?.cotizador;
  const hasCotiz = !!cot;
  const tabs: ["proc" | "mat" | "cotiz", string][] = [
    ...(hasCotiz ? [["cotiz", `Cotizador (${cot!.total_ops_hist} OPs hist.)`] as ["cotiz", string]] : []),
    ["proc", `Procesos (${z1.length})`],
    ["mat", `Materiales (${z2.length})`],
  ];

  return (
    <div className="mt-3 bg-white rounded-xl border border-slate-200 shadow-[0_2px_8px_rgba(0,0,0,0.06)] overflow-hidden animate-[fadeIn_0.2s_ease]">
      <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-[#821417]">OP {orderId}</span>
          <div className="flex gap-0.5 bg-white rounded-lg p-0.5 border border-gray-200">
            {tabs.map(([k, lbl]) => (
              <button key={k} onClick={() => setDtab(k)}
                className={`px-3 py-1 rounded-md text-[11px] font-medium transition-all ${dtab === k ? "bg-[#821417] text-white" : "text-gray-500 hover:bg-gray-50"}`}>{lbl}</button>
            ))}
          </div>
        </div>
        {dtab === "mat" && !z2Loading && z2.length > 0 && (
          <div className="flex gap-3">
            {Object.entries(z2Cats).sort().map(([cat, n]) => (
              <span key={cat} className="text-[11px] text-gray-500">{SKU_CAT[cat]?.label || cat}: <b>{n}</b></span>
            ))}
          </div>
        )}
      </div>
      <div className={`overflow-x-auto ${dtab === "cotiz" ? "" : "max-h-[450px] overflow-y-auto"}`}>
        {dtab === "proc" ? (
          z1.length === 0 ? <Empty msg="Sin procesos" /> : (
            <table className="w-full">
              <thead className="sticky top-0 z-10"><tr>
                <th className={th}>Proc.</th><th className={th}>Nombre</th><th className={th}>Status</th>
                <th className={th}>Inicio</th><th className={th}>Fin</th><th className={th}>Ini.</th><th className={th}>Fin</th>
              </tr></thead>
              <tbody>
                {z1.map((r, i) => (
                  <tr key={i} className={`hover:bg-gray-50/60 ${i % 2 === 0 ? "bg-white" : "bg-gray-50/50"}`}>
                    <td className={`${td} font-mono text-xs font-bold`}>{r.process_id}</td>
                    <td className={td}>{PROCESS_NAMES[r.process_id] || r.process_id}</td>
                    <td className={td}><StatusBadge status={r.status} /></td>
                    <td className={`${td} text-gray-500`}>{fmtDate(r.start_ts)}</td>
                    <td className={`${td} text-gray-500`}>{fmtDate(r.end_ts)}</td>
                    <td className={td}><RealPlanDot isReal={r.start_is_real} /></td>
                    <td className={td}><RealPlanDot isReal={r.end_is_real} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : dtab === "mat" ? (
          z2Loading ? (
            <div className="flex items-center justify-center py-10">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-[#821417] border-t-transparent" /><span className="ml-3 text-sm text-gray-400">Cargando...</span>
            </div>
          ) : z2.length === 0 ? <Empty msg="Sin materiales" /> : (
            <table className="w-full">
              <thead className="sticky top-0 z-10"><tr>
                <th className={th}>Categoria</th><th className={th}>Catalogo</th><th className={th}>SKU</th>
                <th className={th}>Descripcion</th><th className={`${th} text-right`}>Cantidad</th><th className={th}>BOM</th>
              </tr></thead>
              <tbody>
                {z2.map((r, i) => (
                  <tr key={i} className={`hover:bg-gray-50/60 ${i % 2 === 0 ? "bg-white" : "bg-gray-50/50"}`}>
                    <td className={td}><CatBadge cat={r.sku_category_id} /></td>
                    <td className={`${td} font-mono text-xs`}>{r.sku_catalog_id}</td>
                    <td className={`${td} font-mono text-xs font-bold`}>{r.sku_id}</td>
                    <td className={`${td} max-w-[300px] truncate`}>{r.des_sku_id?.trim()}</td>
                    <td className={`${td} text-right tabular-nums font-medium`}>{fmtNum(r.requirement_q)}</td>
                    <td className={`${td} text-gray-400`}>{fmtDate(r.bom_ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : cot ? (
          <CotizadorPanel cot={cot} cliente={opData?.po_customer_name || ""} />
        ) : <Empty msg="Sin datos de cotizador" />}
      </div>
    </div>
  );
}

/* ───── Cotizador Panel ───── */
function CotizadorPanel({ cot, cliente }: { cot: Cotizador; cliente: string }) {
  const [showAllWips, setShowAllWips] = useState(false);
  const rangoActual = cot.rangos[cot.rango_actual] ? cot.rango_actual : "promedio";
  const factorMarca = getFactorMarca(cliente);
  const vectorTotal = FACTOR_ESFUERZO * factorMarca;
  const margenPct = MARGEN_BASE * vectorTotal * 100;
  const wipsOPSet = useMemo(() => new Set(cot.wips_op), [cot.wips_op]);
  const hasRealData = !!(cot.real_wips && cot.completed_wips && cot.completed_wips.length > 0);
  const completedSet = useMemo(() => new Set(cot.completed_wips || []), [cot.completed_wips]);

  // All WIPs sorted: textil first, then manufactura
  const allWips = useMemo(() => {
    const wipSet = new Set<string>();
    for (const rid of Object.keys(cot.rangos)) {
      const r = cot.rangos[rid];
      if (r) for (const w of Object.keys(r.wips)) wipSet.add(w);
    }
    return [...wipSet].sort((a, b) => {
      const aIsT = TEXTIL_WIPS.has(a);
      const bIsT = TEXTIL_WIPS.has(b);
      if (aIsT !== bIsT) return aIsT ? -1 : 1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  }, [cot.rangos]);

  const isChecked = (w: string) => wipsOPSet.has(w);
  const checkedCount = allWips.filter(isChecked).length;
  const displayWips = showAllWips ? allWips : allWips.filter(isChecked);

  // Available rangos (con datos)
  const availRangos = RANGO_ORDER.filter(rid => cot.rangos[rid] != null);

  // Helper: get total for a rango (hybrid-aware)
  const getTotal = (r: RangoData) => {
    const gs = r.gastos;
    let base = r.costo_base;
    if (hasRealData) {
      base = 0;
      for (const w of wipsOPSet) {
        const realW = cot.real_wips?.[w];
        if (completedSet.has(w) && realW) {
          base += realW.textil + realW.manuf;
        } else if (r.wips[w]) {
          base += r.wips[w].textil + r.wips[w].manuf;
        }
      }
    }
    const mp    = (cot.real_materials?.mp    !== undefined && cot.real_materials.mp    > 0) ? cot.real_materials.mp    : (gs?.mp    ?? 0);
    const avios = (cot.real_materials?.avios !== undefined && cot.real_materials.avios > 0) ? cot.real_materials.avios : (gs?.avios ?? 0);
    return base + (gs ? gs.cif + gs.ga + gs.gv : 0) + mp + avios;
  };

  // Column highlight class
  const colCls = (rid: string) => rid === rangoActual ? "bg-[#821417]/5" : "";
  const colClsGreen = (rid: string) => rid === rangoActual ? "bg-emerald-100/60" : "";

  return (
    <div className="p-4">
      {/* Header: method + meta info */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {cot.metodo && (() => {
            const cfg = {
              recurrente:  { color: "bg-blue-50 text-blue-700 ring-blue-200",   label: "Recurrente",         msg: "Referencia: OPs historicas del mismo estilo de cliente" },
              nuevo:       { color: "bg-orange-50 text-orange-700 ring-orange-200", label: "Nuevo",           msg: "Referencia: OPs historicas del mismo cliente y tipo de prenda" },
              nuevo_tipo:  { color: "bg-amber-50 text-amber-600 ring-amber-200",  label: "Nuevo (Aprox.)",   msg: "Cliente sin historial propio — referencia: toda TdV para este tipo de prenda" },
            }[cot.metodo] ?? { color: "bg-gray-50 text-gray-500 ring-gray-200", label: cot.metodo, msg: "" };
            return (
              <div className="flex flex-col gap-0.5">
                <span className={`self-start px-2.5 py-0.5 rounded-full text-[11px] font-medium ring-1 ${cfg.color}`}>{cfg.label}</span>
                {cfg.msg && <span className="text-[11px] text-gray-400 pl-0.5">{cfg.msg}</span>}
              </div>
            );
          })()}
          {hasRealData && (
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium ring-1 bg-emerald-50 text-emerald-700 ring-emerald-200">
              Hibrido ({completedSet.size} WIPs reales)
            </span>
          )}
          <span className="text-[11px] text-gray-400">{cot.total_ops_hist} OPs hist. &middot; {checkedCount}/{allWips.length} WIPs en OP</span>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-gray-400">
          <span>Marca: <b className="text-gray-600">{factorMarca.toFixed(2)}</b></span>
          <span className="text-gray-300 mx-1">|</span>
          <span>Esfuerzo: <b className="text-gray-600">{FACTOR_ESFUERZO.toFixed(2)}</b></span>
          <span className="text-gray-300 mx-1">|</span>
          <span>Margen: <b className="text-emerald-600">+{margenPct.toFixed(1)}%</b></span>
        </div>
      </div>

      {/* Single unified table */}
      <div className="rounded-lg border border-gray-200 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className={th} style={{ width: 28 }}></th>
              <th className={th} style={{ minWidth: 50 }}>ID</th>
              <th className={th} style={{ minWidth: 130 }}>Concepto</th>
              <th className={th}>Tipo</th>
              <th className={th}>Fuente</th>
              {availRangos.map(rid => {
                const r = cot.rangos[rid]!;
                const isActual = rid === rangoActual;
                return (
                  <th key={rid} className={`${th} text-right ${colCls(rid)}`}>
                    <span className={isActual ? "text-[#821417] font-bold" : ""}>{r.name}</span>
                    {isActual && <span className="ml-1 text-[9px] text-[#821417]">*</span>}
                    <div className="text-[11px] font-normal text-gray-400">{r.ops} OPs</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {/* ── SECTION: WIPs ── */}
            <tr className="bg-gray-50">
              <td colSpan={5 + availRangos.length} className="px-3 py-1.5 text-[11px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <span>WIPs de Proceso</span>
                  <button onClick={() => setShowAllWips(v => !v)} className="text-[11px] font-medium text-[#821417] hover:underline">
                    {showAllWips ? `Mostrar solo OP (${checkedCount})` : `Mostrar todos (${allWips.length})`}
                  </button>
                </div>
              </td>
            </tr>
            {displayWips.map(w => {
              const checked = isChecked(w);
              const isTextil = TEXTIL_WIPS.has(w);
              const isReal = hasRealData && completedSet.has(w) && cot.real_wips?.[w];
              return (
                <tr key={w} className={`${checked ? "" : "opacity-35"} hover:bg-gray-50/60 even:bg-gray-50/30`}>
                  <td className={`${td} text-center`}>
                    {checked
                      ? <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-emerald-100 text-emerald-600 text-[11px] font-bold">&#10003;</span>
                      : <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-gray-100 text-gray-400 text-[11px]">&#8212;</span>}
                  </td>
                  <td className={`${td} font-mono text-xs font-bold`}>{w}</td>
                  <td className={`${td} text-xs`}>{PROCESS_NAMES[w] || w}</td>
                  <td className={td}>
                    <span className={`px-1.5 py-0.5 rounded-full text-[11px] font-medium ring-1 ${
                      isTextil ? "bg-blue-50 text-blue-600 ring-blue-200" : "bg-amber-50 text-amber-600 ring-amber-200"
                    }`}>{isTextil ? "Textil" : "Manuf."}</span>
                  </td>
                  <td className={td}>
                    {checked && (
                      <span className={`px-1.5 py-0.5 rounded-full text-[11px] font-medium ring-1 ${
                        isReal ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-gray-50 text-gray-500 ring-gray-200"
                      }`}>{isReal ? "Real" : "Cotizado"}</span>
                    )}
                  </td>
                  {availRangos.map(rid => {
                    const r = cot.rangos[rid]!;
                    const isActual = rid === rangoActual;
                    const realW = cot.real_wips?.[w];
                    // For real WIPs: show real cost (same across all ranges)
                    // For estimated WIPs: show range-specific estimated cost
                    const cost = isReal && realW
                      ? realW.textil + realW.manuf
                      : (r.wips[w] ? r.wips[w].textil + r.wips[w].manuf : 0);
                    const hasData = isReal ? !!realW : !!r.wips[w];
                    return (
                      <td key={rid} className={`${td} text-right tabular-nums ${colCls(rid)} ${isActual && checked ? "font-semibold" : ""}`}>
                        {!hasData ? <span className="text-gray-300">---</span>
                          : cost === 0 ? <span className="text-gray-300">$0.00</span>
                          : <span className={isActual ? (isReal ? "text-emerald-700" : "text-[#821417]") : ""}>${cost.toFixed(2)}</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {/* Subtotal WIPs */}
            <tr className="border-t-2 border-gray-200 bg-gray-50/80 font-semibold">
              <td className={td}></td>
              <td className={td}></td>
              <td className={`${td} text-xs`}>Subtotal WIPs</td>
              <td className={td}></td>
              <td className={td}></td>
              {availRangos.map(rid => {
                const r = cot.rangos[rid]!;
                const isActual = rid === rangoActual;
                // Hybrid: sum real + estimated for wips_op
                let subtotal = r.costo_base;
                if (hasRealData) {
                  subtotal = 0;
                  for (const w of wipsOPSet) {
                    const realW = cot.real_wips?.[w];
                    if (completedSet.has(w) && realW) {
                      subtotal += realW.textil + realW.manuf;
                    } else if (r.wips[w]) {
                      subtotal += r.wips[w].textil + r.wips[w].manuf;
                    }
                  }
                }
                return (
                  <td key={rid} className={`${td} text-right tabular-nums ${colCls(rid)}`}>
                    <span className={isActual ? "text-[#821417] font-bold" : ""}>${subtotal.toFixed(2)}</span>
                  </td>
                );
              })}
            </tr>

            {/* ── SECTION: Materiales ── */}
            <tr className="bg-gray-50">
              <td colSpan={5 + availRangos.length} className="px-3 py-1.5 text-[11px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-200 border-t border-t-gray-200">
                Materiales
              </td>
            </tr>
            {[
              { key: "mp" as const, label: "Materia Prima", icon: "bg-orange-50 text-orange-600 ring-orange-200", tipo: "Material" },
              { key: "avios" as const, label: "Avios", icon: "bg-violet-50 text-violet-600 ring-violet-200", tipo: "Material" },
            ].map(row => {
              const realVal = cot.real_materials?.[row.key];
              const isRealMat = realVal !== undefined && realVal > 0;
              return (
                <tr key={row.key} className="hover:bg-gray-50/60 even:bg-gray-50/30">
                  <td className={td}></td>
                  <td className={td}></td>
                  <td className={`${td} text-xs`}>{row.label}</td>
                  <td className={td}>
                    <span className={`px-1.5 py-0.5 rounded-full text-[11px] font-medium ring-1 ${row.icon}`}>{row.tipo}</span>
                  </td>
                  <td className={td}>
                    <span className={`px-1.5 py-0.5 rounded-full text-[11px] font-medium ring-1 ${isRealMat ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-gray-50 text-gray-500 ring-gray-200"}`}>
                      {isRealMat ? "Real" : "Cotizado"}
                    </span>
                  </td>
                  {availRangos.map(rid => {
                    const r = cot.rangos[rid]!;
                    const isActual = rid === rangoActual;
                    const val = isRealMat ? realVal : (r.gastos?.[row.key] ?? 0);
                    return (
                      <td key={rid} className={`${td} text-right tabular-nums ${colCls(rid)}`}>
                        {val > 0
                          ? <span className={isActual ? (isRealMat ? "text-emerald-700 font-semibold" : "text-[#821417] font-semibold") : ""}>${val.toFixed(2)}</span>
                          : <span className="text-gray-300">---</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            {/* Subtotal Materiales */}
            <tr className="border-t-2 border-gray-200 bg-gray-50/80 font-semibold">
              <td className={td}></td>
              <td className={td}></td>
              <td className={`${td} text-xs`}>Subtotal Materiales</td>
              <td className={td}></td>
              <td className={td}></td>
              {availRangos.map(rid => {
                const r = cot.rangos[rid]!;
                const isActual = rid === rangoActual;
                const realMp    = cot.real_materials?.mp    !== undefined && cot.real_materials.mp    > 0 ? cot.real_materials.mp    : (r.gastos?.mp    ?? 0);
                const realAvios = cot.real_materials?.avios !== undefined && cot.real_materials.avios > 0 ? cot.real_materials.avios : (r.gastos?.avios ?? 0);
                const val = realMp + realAvios;
                return (
                  <td key={rid} className={`${td} text-right tabular-nums ${colCls(rid)}`}>
                    <span className={isActual ? "text-[#821417] font-bold" : ""}>{val > 0 ? `$${val.toFixed(2)}` : "---"}</span>
                  </td>
                );
              })}
            </tr>

            {/* ── SECTION: Gastos ── */}
            <tr className="bg-gray-50">
              <td colSpan={5 + availRangos.length} className="px-3 py-1.5 text-[11px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-200 border-t border-t-gray-200">
                Gastos Indirectos
              </td>
            </tr>
            {[
              { key: "cif" as const, label: "Costos Indirectos Fijos", icon: "bg-purple-50 text-purple-600 ring-purple-200", tipo: "CIF" },
              { key: "ga" as const, label: "Gastos de Administracion", icon: "bg-teal-50 text-teal-600 ring-teal-200", tipo: "GA" },
              { key: "gv" as const, label: "Gastos de Ventas", icon: "bg-rose-50 text-rose-600 ring-rose-200", tipo: "GV" },
            ].map(row => (
              <tr key={row.key} className="hover:bg-gray-50/60 even:bg-gray-50/30">
                <td className={td}></td>
                <td className={td}></td>
                <td className={`${td} text-xs`}>{row.label}</td>
                <td className={td}>
                  <span className={`px-1.5 py-0.5 rounded-full text-[11px] font-medium ring-1 ${row.icon}`}>{row.tipo}</span>
                </td>
                <td className={td}>
                  <span className="px-1.5 py-0.5 rounded-full text-[11px] font-medium ring-1 bg-gray-50 text-gray-500 ring-gray-200">Cotizado</span>
                </td>
                {availRangos.map(rid => {
                  const r = cot.rangos[rid]!;
                  const isActual = rid === rangoActual;
                  const val = r.gastos?.[row.key] ?? 0;
                  return (
                    <td key={rid} className={`${td} text-right tabular-nums ${colCls(rid)}`}>
                      {val > 0 ? <span className={isActual ? "text-[#821417] font-semibold" : ""}>${val.toFixed(2)}</span> : <span className="text-gray-300">---</span>}
                    </td>
                  );
                })}
              </tr>
            ))}

            {/* Subtotal Indirectos */}
            <tr className="border-t-2 border-gray-200 bg-gray-50/80 font-semibold">
              <td className={td}></td>
              <td className={td}></td>
              <td className={`${td} text-xs`}>Subtotal Indirectos</td>
              <td className={td}></td>
              <td className={td}></td>
              {availRangos.map(rid => {
                const r = cot.rangos[rid]!;
                const isActual = rid === rangoActual;
                const val = (r.gastos?.cif ?? 0) + (r.gastos?.ga ?? 0) + (r.gastos?.gv ?? 0);
                return (
                  <td key={rid} className={`${td} text-right tabular-nums ${colCls(rid)}`}>
                    <span className={isActual ? "text-[#821417] font-bold" : ""}>{val > 0 ? `$${val.toFixed(2)}` : "---"}</span>
                  </td>
                );
              })}
            </tr>

            {/* ── TOTALS ── */}
            <tr className="bg-gray-100 font-bold border-t-2 border-gray-300">
              <td className={td}></td>
              <td className={td}></td>
              <td className={`${td} text-xs`}>COSTO TOTAL</td>
              <td className={td}></td>
              <td className={td}></td>
              {availRangos.map(rid => {
                const r = cot.rangos[rid]!;
                const isActual = rid === rangoActual;
                const t = getTotal(r);
                return (
                  <td key={rid} className={`${td} text-right tabular-nums ${colCls(rid)}`}>
                    <span className={`font-bold ${isActual ? "text-[#821417]" : ""}`}>${t.toFixed(2)}</span>
                  </td>
                );
              })}
            </tr>
            <tr className="bg-emerald-50 font-bold border-t-2 border-emerald-200">
              <td className={td}></td>
              <td className={td}></td>
              <td className={`${td} text-xs`}>
                PRECIO COTIZADOR
                <span className="ml-1.5 font-normal text-[11px] text-gray-400">(+{margenPct.toFixed(1)}%)</span>
              </td>
              <td className={td}>
                <span className="px-1.5 py-0.5 rounded-full text-[11px] font-medium ring-1 bg-emerald-50 text-emerald-600 ring-emerald-200">Precio</span>
              </td>
              <td className={td}></td>
              {availRangos.map(rid => {
                const r = cot.rangos[rid]!;
                const isActual = rid === rangoActual;
                const p = getTotal(r) * (1 + MARGEN_BASE * vectorTotal);
                return (
                  <td key={rid} className={`${td} text-right tabular-nums ${colClsGreen(rid)}`}>
                    <span className={`font-bold ${isActual ? "text-emerald-700" : "text-emerald-600"}`}>${p.toFixed(2)}</span>
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <p className="p-8 text-center text-sm text-gray-400">{msg}</p>;
}
