/*
  db.js — Lapisan penyimpanan Supabase
  Menggantikan localStorage agar data sinkron lintas perangkat.

  Tabel yang diperlukan di Supabase (buat via SQL Editor):

  -- Settings (satu baris saja)
  create table if not exists sekre_settings (
    id text primary key default 'main',
    data jsonb not null default '{}'
  );

  -- Anggota
  create table if not exists sekre_anggota (
    id integer primary key,
    nama text not null,
    nim text default '-',
    divisi text default '-',
    nohp text default '-'
  );

  -- Jadwal piket  { tanggal: [id, id, ...] }
  create table if not exists sekre_jadwal (
    tanggal text primary key,
    ids jsonb not null default '[]'
  );

  -- Log absensi
  create table if not exists sekre_log (
    id bigserial primary key,
    tanggal text not null,
    data jsonb not null,
    created_at timestamptz default now()
  );
  create index if not exists sekre_log_tanggal_idx on sekre_log(tanggal);

  Row-Level Security: untuk kemudahan, nonaktifkan RLS pada tabel di atas
  atau tambahkan policy "allow all" sementara.
*/

(function () {
  "use strict";

  const SUPABASE_URL = "https://lddnqvakrjwyzzikinkb.supabase.co";
  const SUPABASE_KEY = "sb_publishable_CCE88thAW-zc80pRmj5YoA_T1NIZMfC";

  // Tunggu window.supabase tersedia (dimuat dari CDN)
  function getClient() {
    if (window._sbClient) return window._sbClient;
    if (!window.supabase) throw new Error("Supabase client belum dimuat.");
    window._sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return window._sbClient;
  }

  function rememberLastError(context, err) {
    const status = err?.status ?? err?.cause?.status ?? null; // FIXED: ambil status jika ada
    const message = err?.message || String(err); // FIXED
    window.__SB_LAST_ERROR = { context, status, message, at: Date.now() }; // FIXED: simpan untuk debugging lintas file
    if (status === 401) {
      console.error(
        `[Supabase 401] ${context}: request ditolak. Jika pakai key 'sb_publishable_*', pastikan domain Vercel kamu sudah di-allow di Supabase (Settings → API → Allowed Origins/URLs). Alternatif: gunakan 'anon public key' (JWT eyJ...) di db.js.`,
      ); // FIXED
    }
  }

  // ===== Settings =====

  async function getSettings() {
    try {
      const sb = getClient();
      const { data, error } = await sb
        .from("sekre_settings")
        .select("data")
        .eq("id", "main")
        .maybeSingle();
      if (error) throw error;
      return data?.data || null;
    } catch (e) {
      rememberLastError("getSettings", e); // FIXED
      console.warn("getSettings error:", e?.message || e); // FIXED
      return null;
    }
  }

  async function saveSettings(obj) {
    try {
      const sb = getClient();
      const cleaned = { ...(obj || {}) }; // FIXED: sanitasi sebelum simpan
      if ("sekre_lat" in cleaned) {
        const n = Number.parseFloat(String(cleaned.sekre_lat ?? "").replace(",", ".")); // FIXED
        cleaned.sekre_lat = Number.isFinite(n) ? n : null; // FIXED: hindari NaN tersimpan
      }
      if ("sekre_lng" in cleaned) {
        const n = Number.parseFloat(String(cleaned.sekre_lng ?? "").replace(",", ".")); // FIXED
        cleaned.sekre_lng = Number.isFinite(n) ? n : null; // FIXED
      }
      if ("radius_meter" in cleaned) {
        const n = Number.parseFloat(String(cleaned.radius_meter ?? "").replace(",", ".")); // FIXED
        cleaned.radius_meter = Number.isFinite(n) ? n : cleaned.radius_meter; // FIXED: radius boleh tetap angka lama
      }
      const { error } = await sb
        .from("sekre_settings")
        .upsert({ id: "main", data: cleaned }, { onConflict: "id" }); // FIXED
      if (error) throw error;
      return true;
    } catch (e) {
      rememberLastError("saveSettings", e); // FIXED
      console.warn("saveSettings error:", e?.message || e); // FIXED
      return false;
    }
  }

  // ===== Anggota =====

  async function getAnggota() {
    try {
      const sb = getClient();
      const { data, error } = await sb
        .from("sekre_anggota")
        .select("*")
        .order("id", { ascending: true });
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    } catch (e) {
      rememberLastError("getAnggota", e); // FIXED
      console.warn("getAnggota error:", e?.message || e); // FIXED
      return [];
    }
  }

  async function upsertAnggota(anggotaObj) {
    try {
      const sb = getClient();
      const { error } = await sb
        .from("sekre_anggota")
        .upsert(anggotaObj, { onConflict: "id" });
      if (error) throw error;
      return true;
    } catch (e) {
      console.warn("upsertAnggota error:", e);
      return false;
    }
  }

  async function deleteAnggota(id) {
    try {
      const sb = getClient();
      const { error } = await sb
        .from("sekre_anggota")
        .delete()
        .eq("id", id);
      if (error) throw error;
      return true;
    } catch (e) {
      console.warn("deleteAnggota error:", e);
      return false;
    }
  }

  async function getNextAnggotaId() {
    try {
      const sb = getClient();
      const { data, error } = await sb
        .from("sekre_anggota")
        .select("id")
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data?.id || 0) + 1;
    } catch {
      return 1;
    }
  }

  // ===== Jadwal =====

  async function getJadwal() {
    try {
      const sb = getClient();
      const { data, error } = await sb
        .from("sekre_jadwal")
        .select("tanggal, ids");
      if (error) throw error;
      const obj = {};
      (data || []).forEach((row) => { obj[row.tanggal] = row.ids; });
      return obj;
    } catch (e) {
      console.warn("getJadwal error:", e);
      return {};
    }
  }

  async function saveJadwalDate(tanggal, ids) {
    try {
      const sb = getClient();
      const { error } = await sb
        .from("sekre_jadwal")
        .upsert({ tanggal, ids }, { onConflict: "tanggal" });
      if (error) throw error;
      return true;
    } catch (e) {
      console.warn("saveJadwalDate error:", e);
      return false;
    }
  }

  // ===== Log absensi =====

  async function getLog(tanggal) {
    try {
      const sb = getClient();
      const { data, error } = await sb
        .from("sekre_log")
        .select("data")
        .eq("tanggal", tanggal)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data || []).map((r) => r.data);
    } catch (e) {
      console.warn("getLog error:", e);
      return [];
    }
  }

  async function insertLog(tanggal, entry) {
    try {
      const sb = getClient();
      const { error } = await sb
        .from("sekre_log")
        .insert({ tanggal, data: entry });
      if (error) throw error;
      return true;
    } catch (e) {
      console.warn("insertLog error:", e);
      return false;
    }
  }

  async function getAllLogDates() {
    try {
      const sb = getClient();
      const { data, error } = await sb
        .from("sekre_log")
        .select("tanggal");
      if (error) throw error;
      const dates = [...new Set((data || []).map((r) => r.tanggal))].sort();
      return dates;
    } catch {
      return [];
    }
  }

  // Cek apakah sudah absen (untuk cegah duplikat)
  async function isAlreadyCheckedIn(tanggal, idAnggota, nama) {
    try {
      const sb = getClient();
      if (idAnggota != null) {
        const { data, error } = await sb
          .from("sekre_log")
          .select("data")
          .eq("tanggal", tanggal)
          .filter("data->>id_anggota", "eq", String(idAnggota))
          .limit(1);
        if (error) throw error;
        return data && data.length > 0 ? data[0].data : null;
      } else {
        // Mode manual: cek by nama
        const log = await getLog(tanggal);
        return log.find((x) => String(x.nama).toLowerCase() === String(nama).toLowerCase()) || null;
      }
    } catch {
      return null;
    }
  }

  // ===== Export all / Import all =====

  async function exportAllData() {
    const [settings, anggota, jadwal, logDates] = await Promise.all([
      getSettings(),
      getAnggota(),
      getJadwal(),
      getAllLogDates(),
    ]);
    const logs = {};
    for (const d of logDates) {
      logs[d] = await getLog(d);
    }
    return { settings, anggota, jadwal, logs };
  }

  async function importAllData(obj) {
    const results = [];
    if (obj.settings) results.push(await saveSettings(obj.settings));
    if (Array.isArray(obj.anggota)) {
      for (const a of obj.anggota) {
        results.push(await upsertAnggota(a));
      }
    }
    if (obj.jadwal && typeof obj.jadwal === "object") {
      for (const [tanggal, ids] of Object.entries(obj.jadwal)) {
        results.push(await saveJadwalDate(tanggal, ids));
      }
    }
    if (obj.logs && typeof obj.logs === "object") {
      for (const [tanggal, entries] of Object.entries(obj.logs)) {
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            results.push(await insertLog(tanggal, entry));
          }
        }
      }
    }
    return results.every(Boolean);
  }

  // Hapus semua data
  async function wipeAllData() {
    try {
      const sb = getClient();
      await sb.from("sekre_log").delete().neq("id", 0);
      await sb.from("sekre_jadwal").delete().neq("tanggal", "__never__");
      await sb.from("sekre_anggota").delete().neq("id", 0);
      await sb.from("sekre_settings").delete().eq("id", "main");
      return true;
    } catch (e) {
      console.warn("wipeAllData error:", e);
      return false;
    }
  }

  // Expose globally
  window.DB = {
    getSettings,
    saveSettings,
    getAnggota,
    upsertAnggota,
    deleteAnggota,
    getNextAnggotaId,
    getJadwal,
    saveJadwalDate,
    getLog,
    insertLog,
    getAllLogDates,
    isAlreadyCheckedIn,
    exportAllData,
    importAllData,
    wipeAllData,
  };

  window.__SEKRE_DB_READY__ = true; // FIXED: sinyal siap untuk halaman admin/anggota
  try { window.dispatchEvent(new CustomEvent("sekre:db-ready")); } catch { /* ignore */ } // FIXED
})();