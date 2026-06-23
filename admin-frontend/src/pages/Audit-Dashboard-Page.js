import React, { useState, useEffect, useContext, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import DateRangePicker from "../components/DateRangePicker-Component";
import AdminNavigation from "../components/AdminNavigation-Component";
import AuthContext from "../context/AuthContext";

const API = process.env.REACT_APP_API_URL || "";

// ── presentation helpers ─────────────────────────────────────────────────────
const SEVERITY_BADGE = {
  info: "bg-gray-100 text-gray-700",
  notice: "bg-blue-100 text-blue-800",
  warning: "bg-amber-100 text-amber-800",
  critical: "bg-red-100 text-red-800",
};
const CATEGORY_BADGE = {
  chat: "bg-indigo-100 text-indigo-800",
  access: "bg-teal-100 text-teal-800",
  auth: "bg-sky-100 text-sky-800",
  admin: "bg-purple-100 text-purple-800",
  security: "bg-red-100 text-red-800",
};
const OUTCOME_BADGE = {
  success: "bg-green-100 text-green-800",
  failure: "bg-red-100 text-red-800",
  blocked: "bg-orange-100 text-orange-800",
};

const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const fmtTime = (ts) => {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
};
const actorLabel = (a) => {
  if (!a) return "—";
  const who = a.email || a.id || "";
  return who ? `${a.type} · ${who}` : a.type;
};
const targetLabel = (t) => {
  if (!t || (!t.type && !t.guestId && !t.id)) return "—";
  const base = t.type || "";
  const ref = t.guestId || t.id;
  return ref ? `${base} · ${ref}` : base;
};
const detailsLabel = (ev) => {
  const bits = [];
  if (ev.context?.country) bits.push(`country=${ev.context.country}`);
  if (ev.context?.ip) bits.push(`ip=${ev.context.ip}`);
  if (ev.meta && typeof ev.meta === "object") {
    Object.entries(ev.meta).slice(0, 6).forEach(([k, v]) => {
      bits.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
    });
  }
  return bits.join("  ·  ");
};

function AuditDashboard() {
  const { userRole, handleLogout } = useContext(AuthContext);
  const isSuper = userRole === "superadmin";

  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d;
  });
  const [endDate, setEndDate] = useState(new Date());

  const [meta, setMeta] = useState(null);
  const [filters, setFilters] = useState({ category: "", severity: "", outcome: "", branchEmail: "", q: "" });
  const [qInput, setQInput] = useState("");

  const [summary, setSummary] = useState(null);
  const [events, setEvents] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal] = useState(null);
  const [truncated, setTruncated] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(null);

  const getHeaders = () => {
    const token =
      sessionStorage.getItem("superAdminToken") ||
      sessionStorage.getItem("branchAdminToken");
    return {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    };
  };

  const buildParams = useCallback((extra = {}) => {
    const p = new URLSearchParams();
    p.set("startDate", startDate.toISOString().split("T")[0]);
    p.set("endDate", endDate.toISOString().split("T")[0]);
    if (filters.category) p.set("category", filters.category);
    if (filters.severity) p.set("severity", filters.severity);
    if (filters.outcome) p.set("outcome", filters.outcome);
    if (filters.q) p.set("q", filters.q);
    if (isSuper && filters.branchEmail) p.set("branchEmail", filters.branchEmail.trim().toLowerCase());
    Object.entries(extra).forEach(([k, v]) => {
      if (v != null && v !== "") p.set(k, v);
    });
    return p.toString();
  }, [startDate, endDate, filters, isSuper]);

  // one-time: filter dropdown metadata + caller scope
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/api/audit/meta`, { headers: getHeaders() });
        if (res.ok) setMeta(await res.json());
      } catch (e) {
        console.warn("[AUDIT] meta fetch failed:", e.message);
      }
    })();
  }, []);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/audit/summary?${buildParams()}`, { headers: getHeaders() });
      if (res.ok) setSummary(await res.json());
      else setSummary(null);
    } catch (e) {
      console.warn("[AUDIT] summary fetch failed:", e.message);
      setSummary(null);
    }
  }, [buildParams]);

  const fetchEvents = useCallback(async (reset = true) => {
    reset ? setLoading(true) : setLoadingMore(true);
    if (reset) setError(null);
    try {
      const extra = { limit: 100 };
      if (!reset && nextCursor) extra.before = nextCursor;
      const res = await fetch(`${API}/api/audit/events?${buildParams(extra)}`, { headers: getHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEvents((prev) => (reset ? data.events : [...prev, ...data.events]));
      setNextCursor(data.nextCursor || null);
      setTotal(data.total);
      setTruncated(!!data.truncated);
    } catch (e) {
      console.error("[AUDIT] events fetch failed:", e.message);
      if (reset) { setEvents([]); setError("Failed to load audit events."); }
    } finally {
      reset ? setLoading(false) : setLoadingMore(false);
    }
  }, [buildParams, nextCursor]);

  // refetch on date / filter changes
  useEffect(() => {
    fetchSummary();
    fetchEvents(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate, filters]);

  const applySearch = () => setFilters((f) => ({ ...f, q: qInput.trim() }));
  const onSearchKey = (e) => { if (e.key === "Enter") applySearch(); };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await fetch(`${API}/api/audit/export.csv?${buildParams()}`, { headers: getHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-export-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError("Export failed.");
    } finally {
      setExporting(false);
    }
  };

  const categoryOptions = meta?.categories || ["chat", "access", "auth", "admin", "security"];
  const severityOptions = meta?.severities || ["info", "notice", "warning", "critical"];
  const outcomeOptions = meta?.outcomes || ["success", "failure", "blocked"];

  const sev = summary?.bySeverity || {};
  const cat = summary?.byCategory || {};

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="w-full bg-gray-800 text-white p-4 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold">Audit &amp; Compliance</h1>
          <AdminNavigation currentPage="/admin/audit" />
        </div>
        <button onClick={handleLogout} className="btn btn-primary">Logout</button>
      </div>

      <div className="flex flex-row flex-grow bg-gray-100">
        <div className="w-full p-6 overflow-y-auto">
          {/* Scope banner */}
          <div className="mb-4 text-sm text-gray-600">
            {isSuper ? (
              <span>Viewing <strong>all branches</strong> across every event category.</span>
            ) : (
              <span>
                Viewing the audit trail for <strong>{meta?.scope?.branchEmail || "your branch"}</strong>
                {" "}(chat &amp; data-access events only).
              </span>
            )}
            {meta?.retentionDays && (
              <span className="ml-2 text-gray-400">· Retained {meta.retentionDays} days</span>
            )}
          </div>

          {/* Date range */}
          <div className="mb-4">
            <DateRangePicker
              startDate={startDate}
              endDate={endDate}
              onStartDateChange={setStartDate}
              onEndDateChange={setEndDate}
              presets={["week", "month", "quarter"]}
            />
          </div>

          {/* Filters */}
          <div className="admin-card mb-6">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex flex-col">
                <label className="text-xs font-medium text-gray-600 mb-1">Category</label>
                <select className="form-input" style={{ width: "auto" }}
                  value={filters.category}
                  onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}>
                  <option value="">All</option>
                  {categoryOptions.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
                </select>
              </div>
              <div className="flex flex-col">
                <label className="text-xs font-medium text-gray-600 mb-1">Severity</label>
                <select className="form-input" style={{ width: "auto" }}
                  value={filters.severity}
                  onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))}>
                  <option value="">All</option>
                  {severityOptions.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
                </select>
              </div>
              <div className="flex flex-col">
                <label className="text-xs font-medium text-gray-600 mb-1">Outcome</label>
                <select className="form-input" style={{ width: "auto" }}
                  value={filters.outcome}
                  onChange={(e) => setFilters((f) => ({ ...f, outcome: e.target.value }))}>
                  <option value="">All</option>
                  {outcomeOptions.map((o) => <option key={o} value={o}>{titleCase(o)}</option>)}
                </select>
              </div>
              {isSuper && (
                <div className="flex flex-col">
                  <label className="text-xs font-medium text-gray-600 mb-1">Branch email</label>
                  <input className="form-input" style={{ width: "auto" }} placeholder="any branch"
                    value={filters.branchEmail}
                    onChange={(e) => setFilters((f) => ({ ...f, branchEmail: e.target.value }))} />
                </div>
              )}
              <div className="flex flex-col flex-grow" style={{ minWidth: 180 }}>
                <label className="text-xs font-medium text-gray-600 mb-1">Search</label>
                <div className="flex gap-2">
                  <input className="form-input flex-grow" placeholder="action, actor, guestId, country…"
                    value={qInput}
                    onChange={(e) => setQInput(e.target.value)}
                    onKeyDown={onSearchKey} />
                  <button className="btn btn-primary" onClick={applySearch}>Search</button>
                </div>
              </div>
              <button className="btn btn-primary" onClick={handleExport} disabled={exporting}>
                {exporting ? "Exporting…" : "Export CSV"}
              </button>
            </div>
          </div>

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">{error}</div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="admin-card">
              <p className="text-sm font-medium text-gray-600">Total events</p>
              <p className="text-3xl font-bold text-gray-900">{summary?.matched ?? "—"}</p>
              <p className="text-xs text-gray-500 mt-2">
                {total != null ? `${total} in window` : ""}{truncated ? " · capped" : ""}
              </p>
            </div>
            <div className="admin-card">
              <p className="text-sm font-medium text-gray-600">Critical</p>
              <p className="text-3xl font-bold text-red-600">{sev.critical || 0}</p>
              <p className="text-xs text-gray-500 mt-2">{sev.warning || 0} warnings</p>
            </div>
            <div className="admin-card">
              <p className="text-sm font-medium text-gray-600">Chat events</p>
              <p className="text-3xl font-bold text-gray-900">{cat.chat || 0}</p>
              <p className="text-xs text-gray-500 mt-2">{cat.access || 0} data-access</p>
            </div>
            <div className="admin-card">
              <p className="text-sm font-medium text-gray-600">{isSuper ? "Security / Auth" : "Data access"}</p>
              <p className="text-3xl font-bold text-gray-900">
                {isSuper ? (cat.security || 0) + (cat.auth || 0) : (cat.access || 0)}
              </p>
              <p className="text-xs text-gray-500 mt-2">{isSuper ? `${cat.admin || 0} admin actions` : ""}</p>
            </div>
          </div>

          {/* Trend chart */}
          <div className="admin-card mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Event volume over time</h3>
            <p className="text-sm text-gray-600 mb-4">Daily audit events in the selected window</p>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={summary?.series || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" stroke="#6b7280" fontSize={12} />
                <YAxis stroke="#6b7280" fontSize={12} allowDecimals={false} />
                <Tooltip contentStyle={{ backgroundColor: "#fff", border: "1px solid #e5e7eb", borderRadius: 8 }} />
                <Line type="monotone" dataKey="count" stroke="#6366f1" strokeWidth={2} name="Events" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Events table */}
          <div className="admin-card mb-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Audit events</h3>
              <span className="text-sm text-gray-500">{events.length} shown</span>
            </div>

            {loading ? (
              <div className="text-center text-gray-500 py-8">Loading audit events…</div>
            ) : events.length === 0 ? (
              <div className="text-center text-gray-500 py-8">No events match the current filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="analytics-table w-full">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Category</th>
                      <th>Action</th>
                      <th>Severity</th>
                      <th>Outcome</th>
                      <th>Actor</th>
                      {isSuper && <th>Branch</th>}
                      <th>Target</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((ev) => (
                      <tr key={ev.id}>
                        <td className="whitespace-nowrap text-sm">{fmtTime(ev.ts)}</td>
                        <td>
                          <span className={`px-2 py-1 text-xs font-semibold rounded ${CATEGORY_BADGE[ev.category] || "bg-gray-100 text-gray-700"}`}>
                            {ev.category}
                          </span>
                        </td>
                        <td className="text-sm font-mono">{ev.action}</td>
                        <td>
                          <span className={`px-2 py-1 text-xs font-semibold rounded ${SEVERITY_BADGE[ev.severity] || "bg-gray-100 text-gray-700"}`}>
                            {ev.severity}
                          </span>
                        </td>
                        <td>
                          <span className={`px-2 py-1 text-xs font-semibold rounded ${OUTCOME_BADGE[ev.outcome] || "bg-gray-100 text-gray-700"}`}>
                            {ev.outcome}
                          </span>
                        </td>
                        <td className="text-sm">{actorLabel(ev.actor)}</td>
                        {isSuper && <td className="text-sm">{ev.branchEmail || "—"}</td>}
                        <td className="text-sm">{targetLabel(ev.target)}</td>
                        <td className="text-xs text-gray-600 max-w-md truncate" title={detailsLabel(ev)}>
                          {detailsLabel(ev)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {nextCursor && (
                  <div className="flex justify-center mt-4">
                    <button className="btn btn-primary" onClick={() => fetchEvents(false)} disabled={loadingMore}>
                      {loadingMore ? "Loading…" : "Load older events"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default AuditDashboard;
