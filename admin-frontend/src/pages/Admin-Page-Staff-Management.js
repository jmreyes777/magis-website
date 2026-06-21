// magis-project/admin-frontend/src/pages/Admin-Page-Staff-Management.js
//
// Super-admin UI to provision & manage branch chat-dashboard STAFF accounts
// (password + emailed-OTP identities). Talks to the backend /api/admin/staff
// routes with the super-admin Bearer token; the branch dropdown is read from
// Firestore (same source as the Branches list).

import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../firebase-config";

const api = axios.create({
  baseURL: process.env.REACT_APP_API_URL || "",
  withCredentials: true,
});

const authHeaders = () => ({
  Authorization: `Bearer ${sessionStorage.getItem("superAdminToken") || ""}`,
});

function StaffManagement() {
  const navigate = useNavigate();

  const [staff, setStaff] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState(null);

  // Create form
  const [form, setForm] = useState({ email: "", branchId: "", displayName: "", twoFactorEnabled: true });
  const [creating, setCreating] = useState(false);

  // One-time credential reveal modal
  const [reveal, setReveal] = useState(null); // { email, tempPassword, emailed, emailError, isReset }
  const [copied, setCopied] = useState(false);

  const loadStaff = useCallback(async () => {
    try {
      const res = await api.get("/api/admin/staff", { headers: authHeaders() });
      setStaff(res.data.staff || []);
    } catch (err) {
      if (err.response?.status === 401) {
        setError("Your session expired. Please sign in again.");
      } else {
        setError(err.response?.data?.error || "Failed to load staff.");
      }
    }
  }, []);

  const loadBranches = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, "branches"));
      setBranches(
        snap.docs
          .map((d) => ({ id: d.id, name: d.data().name, email: d.data().email }))
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      );
    } catch (err) {
      console.error("[STAFF-MGMT] Failed to load branches:", err);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadStaff(), loadBranches()]);
      setLoading(false);
    })();
  }, [loadStaff, loadBranches]);

  const flash = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(""), 4000);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setError("");
    const email = form.email.trim().toLowerCase();
    const branch = branches.find((b) => b.id === form.branchId);
    if (!email) return setError("Email is required.");
    if (!branch) return setError("Please select a branch.");

    setCreating(true);
    try {
      const res = await api.post(
        "/api/admin/staff",
        {
          email,
          branchId: branch.id,
          branchName: branch.name,
          branchEmail: branch.email,
          displayName: form.displayName.trim() || null,
          twoFactorEnabled: form.twoFactorEnabled,
        },
        { headers: authHeaders() }
      );
      setReveal({
        email,
        tempPassword: res.data.tempPassword,
        emailed: res.data.emailed,
        emailError: res.data.emailError,
        isReset: false,
      });
      setForm({ email: "", branchId: "", displayName: "", twoFactorEnabled: true });
      await loadStaff();
    } catch (err) {
      setError(err.response?.data?.error || "Could not create staff account.");
    } finally {
      setCreating(false);
    }
  };

  const withBusy = async (id, fn) => {
    setBusyId(id);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err.response?.data?.error || "Action failed.");
    } finally {
      setBusyId(null);
    }
  };

  const handleResetPassword = (s) =>
    withBusy(s.id, async () => {
      const res = await api.post(`/api/admin/staff/${s.id}/reset-password`, {}, { headers: authHeaders() });
      setReveal({
        email: s.email,
        tempPassword: res.data.tempPassword,
        emailed: res.data.emailed,
        emailError: res.data.emailError,
        isReset: true,
      });
    });

  const handleToggle2FA = (s) =>
    withBusy(s.id, async () => {
      await api.post(`/api/admin/staff/${s.id}/2fa`, { enabled: !s.twoFactorEnabled }, { headers: authHeaders() });
      flash(`2FA ${!s.twoFactorEnabled ? "enabled" : "disabled"} for ${s.email}.`);
      await loadStaff();
    });

  const handleToggleStatus = (s) =>
    withBusy(s.id, async () => {
      const action = s.status === "disabled" ? "enable" : "disable";
      await api.post(`/api/admin/staff/${s.id}/${action}`, {}, { headers: authHeaders() });
      flash(`Account ${action}d for ${s.email}.`);
      await loadStaff();
    });

  const handleRevokeDevices = (s) =>
    withBusy(s.id, async () => {
      const res = await api.post(`/api/admin/staff/${s.id}/revoke-devices`, {}, { headers: authHeaders() });
      flash(`Revoked ${res.data.revoked || 0} trusted device(s) for ${s.email}.`);
    });

  const handleDelete = (s) =>
    withBusy(s.id, async () => {
      if (!window.confirm(`Delete staff account ${s.email}? This cannot be undone.`)) return;
      await api.delete(`/api/admin/staff/${s.id}`, { headers: authHeaders() });
      flash(`Deleted ${s.email}.`);
      await loadStaff();
    });

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(reveal.tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  };

  const statusBadge = (s) => {
    const map = {
      active: "bg-green-100 text-green-700",
      disabled: "bg-red-100 text-red-700",
    };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${map[s.status] || "bg-gray-100 text-gray-600"}`}>
        {s.status || "active"}
      </span>
    );
  };

  // One staff account per branch → only offer branches that don't have one yet.
  const takenBranchIds = new Set(staff.map((s) => s.branchId).filter(Boolean));
  const availableBranches = branches.filter((b) => !takenBranchIds.has(b.id));
  const allBranchesTaken = branches.length > 0 && availableBranches.length === 0;

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Staff Access</h1>
            <p className="text-sm text-gray-500">Manage branch chat-dashboard staff (password + emailed code).</p>
          </div>
          <button onClick={() => navigate("/admin/branches")} className="text-blue-600 hover:text-blue-800 text-sm font-medium">
            ← Back to Branches
          </button>
        </div>

        {error && <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}
        {notice && <div className="mb-4 p-3 rounded-lg bg-blue-50 text-blue-700 text-sm">{notice}</div>}

        {/* Create form */}
        <div className="bg-white rounded-xl shadow-sm p-5 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Add staff member</h2>
          <p className="text-xs text-gray-500 mb-4">
            One staff account per branch.{allBranchesTaken ? " Every branch already has a staff member." : ""}
          </p>
          <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Email</span>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="staff@example.com"
                required
                className="mt-1 w-full px-3 py-2 border rounded-lg text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Branch</span>
              <select
                value={form.branchId}
                onChange={(e) => setForm({ ...form, branchId: e.target.value })}
                required
                className="mt-1 w-full px-3 py-2 border rounded-lg text-sm bg-white"
              >
                <option value="">Select a branch…</option>
                {availableBranches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Display name (optional)</span>
              <input
                type="text"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="e.g. Front desk"
                className="mt-1 w-full px-3 py-2 border rounded-lg text-sm"
              />
            </label>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={form.twoFactorEnabled}
                  onChange={(e) => setForm({ ...form, twoFactorEnabled: e.target.checked })}
                />
                2FA
              </label>
              <button
                type="submit"
                disabled={creating || allBranchesTaken}
                className={`flex-1 px-4 py-2 rounded-lg text-white text-sm font-semibold ${creating || allBranchesTaken ? "bg-gray-400" : "bg-blue-600 hover:bg-blue-700"}`}
              >
                {creating ? "Creating…" : "Create & email"}
              </button>
            </div>
          </form>
        </div>

        {/* Staff table */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          {loading ? (
            <p className="p-6 text-gray-500">Loading…</p>
          ) : staff.length === 0 ? (
            <p className="p-6 text-gray-500">No staff accounts yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600 text-left">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Email</th>
                    <th className="px-4 py-3 font-semibold">Branch</th>
                    <th className="px-4 py-3 font-semibold">2FA</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Last login</th>
                    <th className="px-4 py-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {staff.map((s) => (
                    <tr key={s.id} className={busyId === s.id ? "opacity-50" : ""}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{s.email}</div>
                        {s.displayName && <div className="text-xs text-gray-400">{s.displayName}</div>}
                      </td>
                      <td className="px-4 py-3 text-gray-700">{s.branchName || "—"}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${s.twoFactorEnabled ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                          {s.twoFactorEnabled ? "On" : "Off"}
                        </span>
                      </td>
                      <td className="px-4 py-3">{statusBadge(s)}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString() : "Never"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5 justify-end">
                          <button onClick={() => handleResetPassword(s)} disabled={busyId === s.id} className="px-2.5 py-1 rounded-md bg-amber-100 text-amber-800 hover:bg-amber-200 text-xs font-medium">Reset PW</button>
                          <button onClick={() => handleToggle2FA(s)} disabled={busyId === s.id} className="px-2.5 py-1 rounded-md bg-indigo-100 text-indigo-700 hover:bg-indigo-200 text-xs font-medium">{s.twoFactorEnabled ? "Disable 2FA" : "Enable 2FA"}</button>
                          <button onClick={() => handleRevokeDevices(s)} disabled={busyId === s.id} className="px-2.5 py-1 rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 text-xs font-medium">Revoke devices</button>
                          <button onClick={() => handleToggleStatus(s)} disabled={busyId === s.id} className={`px-2.5 py-1 rounded-md text-xs font-medium ${s.status === "disabled" ? "bg-green-100 text-green-700 hover:bg-green-200" : "bg-orange-100 text-orange-700 hover:bg-orange-200"}`}>{s.status === "disabled" ? "Enable" : "Disable"}</button>
                          <button onClick={() => handleDelete(s)} disabled={busyId === s.id} className="px-2.5 py-1 rounded-md bg-red-100 text-red-700 hover:bg-red-200 text-xs font-medium">Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* One-time credential reveal modal */}
      {reveal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-1">
              {reveal.isReset ? "Password reset" : "Staff account created"}
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              {reveal.emailed
                ? `Credentials were emailed to ${reveal.email}.`
                : `Email delivery failed (${reveal.emailError || "unknown error"}). Share the password securely below.`}
            </p>
            <div className="bg-gray-50 border rounded-lg p-3 mb-2">
              <div className="text-xs text-gray-500 mb-1">Email</div>
              <div className="font-medium text-gray-900 mb-3 break-all">{reveal.email}</div>
              <div className="text-xs text-gray-500 mb-1">Temporary password (shown once)</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-2 py-1.5 bg-white border rounded font-mono text-sm break-all">{reveal.tempPassword}</code>
                <button onClick={copyPassword} className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700">
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              The staffer must set a new password on first sign-in, and a 6-digit code is emailed each login on a new device.
            </p>
            <div className="text-right">
              <button onClick={() => setReveal(null)} className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-semibold hover:bg-gray-700">
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default StaffManagement;
