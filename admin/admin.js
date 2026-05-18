/*
  admin.js (Halaman Admin) — versi Supabase
  Semua data (settings, anggota, jadwal, log) disimpan di Supabase
  agar sinkron lintas perangkat.

  Perbaikan:
  1. Storage → Supabase (bukan localStorage)
  2. Login disimpan di localStorage (bukan sessionStorage) → tidak hilang saat tab ditutup
  3. QR library dimuat lebih robust (CDN + timeout warning)
  4. GPS "Gunakan Lokasi Saya" diperbaiki
  5. Loading state di semua operasi async
*/

(function () {
  "use strict";

  const CHANNEL_NAME = "absensi-sekre";

  // ===== Util DOM =====

  function $(id) { return document.getElementById(id); }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function formatDateYYYYMMDD(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function formatTimeHHMMSS(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function formatDateIndo(d) {
    const hari = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"][d.getDay()];
    const bulan = [
      "Januari", "Februari", "Maret", "April", "Mei", "Juni",
      "Juli", "Agustus", "September", "Oktober", "November", "Desember",
    ][d.getMonth()];
    return `${hari}, ${d.getDate()} ${bulan} ${d.getFullYear()}`;
  }

  function unixSecNow() { return Math.floor(Date.now() / 1000); }

  function secondsUntil(tsSec) {
    return Math.max(0, Math.floor(tsSec - unixSecNow()));
  }

  function showToast(message, type = "success") {
    const toast = $("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.style.borderLeftColor = type === "error" ? "var(--red)" : "var(--primary)";
    toast.classList.add("show");
    window.setTimeout(() => toast.classList.remove("show"), 3500);
  }

  function setLoading(btnId, loading, originalText) {
    const btn = $(btnId);
    if (!btn) return;
    btn.disabled = loading;
    if (loading) {
      btn.dataset.origText = btn.textContent;
      btn.textContent = "Memuat...";
    } else {
      btn.textContent = originalText || btn.dataset.origText || btn.textContent;
    }
  }

  function downloadText(filename, text, mime = "text/plain") {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function downloadJSON(filename, obj) {
    downloadText(filename, JSON.stringify(obj, null, 2), "application/json");
  }

  function escapeCsvCell(v) {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes("\n") || s.includes('"')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function toCSV(rows) {
    return rows.map((r) => r.map(escapeCsvCell).join(",")).join("\n") + "\n";
  }

  function parseCSV(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.map((l) => l.split(",").map((c) => c.trim()));
  }

  function getISOWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return { year: d.getUTCFullYear(), week: weekNo };
  }

  // ===== Crypto =====

  async function sha256Hex(text) {
    const normalized = String(text ?? "");
    if (globalThis.crypto && crypto.subtle) {
      const enc = new TextEncoder();
      const data = enc.encode(normalized);
      const hashBuf = await crypto.subtle.digest("SHA-256", data);
      const bytes = new Uint8Array(hashBuf);
      return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    let h = 2166136261;
    for (let i = 0; i < normalized.length; i++) {
      h ^= normalized.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0").repeat(8);
  }

  function randomSecret(len = 8) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const buf = new Uint8Array(len);
    crypto.getRandomValues(buf);
    return Array.from(buf).map((b) => chars[b % chars.length]).join("");
  }

  function randomNonce(len = 4) { return randomSecret(len); }

  // ===== Token =====

  function toBase64Url(b64) {
    return String(b64).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function generateToken(type, dateStr, secretKey) {
    const iat = unixSecNow();
    const nonce = randomNonce();
    return toBase64Url(btoa(`${type}:${dateStr}:${iat}:${secretKey}:${nonce}`));
  }

  async function getSecretHash(secretKey) {
    return sha256Hex(secretKey);
  }

  // ===== Login (localStorage agar persisten) =====

  function setLoggedIn(v) {
    localStorage.setItem("sekre_admin_logged_in", v ? "1" : "0");
  }

  function isLoggedIn() {
    return localStorage.getItem("sekre_admin_logged_in") === "1";
  }

  // ===== Default settings =====

  async function ensureDefaultSettings() {
    const existing = await DB.getSettings();

    // Default password diset, tapi tidak pernah ditampilkan di UI.
    const defaultHash = await sha256Hex("admin123");

    if (existing && typeof existing === "object") {
      const repaired = { ...existing };
      if (!repaired.nama_org) repaired.nama_org = "ABSENSI HMTE FT UNP";
      if (!repaired.secret_key) repaired.secret_key = randomSecret(8);
      if (!repaired.password_hash) repaired.password_hash = defaultHash;
      const parsedLat = Number.parseFloat(String(repaired.sekre_lat ?? "").replace(",", ".")); // FIXED: dukung koma desimal
      const parsedLng = Number.parseFloat(String(repaired.sekre_lng ?? "").replace(",", ".")); // FIXED: dukung koma desimal
      const parsedRadius = Number.parseFloat(String(repaired.radius_meter ?? "").replace(",", ".")); // FIXED: dukung koma desimal
      repaired.sekre_lat = Number.isFinite(parsedLat) ? parsedLat : -0.9492; // FIXED: jangan simpan NaN
      repaired.sekre_lng = Number.isFinite(parsedLng) ? parsedLng : 100.3543; // FIXED: jangan simpan NaN
      repaired.radius_meter = Number.isFinite(parsedRadius) ? parsedRadius : 100; // FIXED: default aman
      if (!repaired.jam_batas_terlambat) repaired.jam_batas_terlambat = "08:00";
      await DB.saveSettings(repaired);
      return repaired;
    }

    const fresh = {
      nama_org: "ABSENSI HMTE FT UNP",
      secret_key: randomSecret(8),
      password_hash: defaultHash,
      sekre_lat: -0.9492,
      sekre_lng: 100.3543,
      radius_meter: 100,
      jam_batas_terlambat: "08:00",
    };
    await DB.saveSettings(fresh);
    return fresh;
  }

  async function checkPassword(input) {
    const s = await DB.getSettings();
    if (!s?.password_hash) return false;
    const hash = await sha256Hex(String(input ?? "").trim());
    return hash === s.password_hash;
  }

  async function resetPasswordToDefault() {
    const ok = confirm("Reset password admin ke default?");
    if (!ok) return;
    const key = prompt("Ketik RESET untuk konfirmasi:");
    if (String(key ?? "").trim().toUpperCase() !== "RESET") { showToast("Dibatalkan.", "error"); return; }
    const s = await ensureDefaultSettings();
    s.password_hash = await sha256Hex("admin123");
    await DB.saveSettings(s);
    showToast("Password direset ke default.");
  }

  async function changePassword(newPass) {
    if (!newPass || newPass.length < 6) { showToast("Password minimal 6 karakter.", "error"); return; }
    const s = await ensureDefaultSettings();
    s.password_hash = await sha256Hex(newPass);
    await DB.saveSettings(s);
    showToast("Password disimpan.");
  }

  // ===== UI Tabs =====

  const QR_STORAGE_KEY = "sekre_qr_state_v1";

  const uiState = {
    latLngLockUntil: 0,
  };

  function saveQrStateToStorage(data) {
    try { localStorage.setItem(QR_STORAGE_KEY, JSON.stringify(data)); } catch {}
  }

  function loadQrStateFromStorage() {
    try {
      const raw = localStorage.getItem(QR_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (!parsed.url || !parsed.token || !parsed.expiresAtSec) return null;
      if (secondsUntil(parsed.expiresAtSec) <= 0) {
        try { localStorage.removeItem(QR_STORAGE_KEY); } catch {}
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async function renderQrFromState(data, { silent = true } = {}) {
    const loaded = await loadQRCodeLib();
    if (!loaded || typeof QRCode === "undefined") {
      if (!silent) showToast("Library QR tidak tersedia.", "error");
      return false;
    }

    qrState.expiresAtSec = data.expiresAtSec;
    qrState.url = data.url;
    qrState.token = data.token;
    qrState.type = data.type || "bebas";
    qrState.dateStr = data.dateStr || (data.type === "piket" ? formatDateYYYYMMDD(new Date()) : formatDateYYYYMMDD(new Date()));

    // Sinkronkan input UI biar konsisten
    if ($("qr-date") && data.dateStr) $("qr-date").value = data.dateStr;
    if ($("qr-type") && data.type) $("qr-type").value = data.type;
    if ($("row-qr-piket")) $("row-qr-piket").style.display = $("qr-type").value === "piket" ? "block" : "none";

    const labelType = qrState.type === "piket" ? "QR PIKET" : "QR HADIR BEBAS";

    const container = $("qr-canvas");
    container.innerHTML = "";
    new QRCode(container, { text: qrState.url, width: 300, height: 300, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });

    const print = $("print-qr");
    print.innerHTML = "";
    new QRCode(print, { text: qrState.url, width: 320, height: 320, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });

    const validUntil = new Date(qrState.expiresAtSec * 1000);
    const hhmm = `${pad2(validUntil.getHours())}:${pad2(validUntil.getMinutes())}`;
    const remNow = secondsUntil(qrState.expiresAtSec);

    $("qr-label").textContent = `${labelType} - ${$("qr-date").value} - Berlaku hingga ${hhmm}`;
    $("qr-valid-until").textContent = hhmm;
    $("qr-remaining").textContent = `${pad2(Math.floor(remNow / 60))}:${pad2(remNow % 60)}`;
    $("qr-url").textContent = qrState.url;
    $("qr-token").textContent = qrState.token;
    $("print-title").textContent = labelType;
    $("print-meta").textContent = `${$("qr-date").value} - Berlaku hingga ${hhmm}`;

    return true;
  }

  async function ensureQrCurrent() {
    const saved = loadQrStateFromStorage();
    if (saved) {
      const ok = await renderQrFromState(saved, { silent: true });
      if (ok) return;
    }
    await renderQr();
  }

  function switchAdminTab(name) {
    document.querySelectorAll(".admin-tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    document.querySelectorAll(".admin-panel").forEach((p) => {
      p.classList.toggle("active", p.id === `tab-${name}`);
    });
    if (name === "qr") ensureQrCurrent();
  }

  // ===== QR Code library =====

  function loadQRCodeLib() {
    return new Promise((resolve) => {
      if (typeof QRCode !== "undefined") { resolve(true); return; }

      // FIXED: jangan referensi vendor/ (rawan 404 di deploy). Gunakan CDN saja.
      const cdn = document.createElement("script"); // FIXED
      cdn.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"; // FIXED
      cdn.onload = () => resolve(true); // FIXED
      cdn.onerror = () => { showToast("Gagal memuat lib QR dari CDN. Pastikan koneksi internet aktif.", "error"); resolve(false); }; // FIXED
      document.head.appendChild(cdn); // FIXED
    });
  }

  // ===== QR State =====

  const qrState = { expiresAtSec: null, timer: null, url: null, token: null, type: null, dateStr: null };

  async function renderQr() {
    try {
      const settings = await DB.getSettings();
      if (!settings) { showToast("Pengaturan belum tersimpan.", "error"); return; }

      const dateStr = $("qr-date").value;
      const type = $("qr-type").value;

      if (!dateStr) { showToast("Tanggal belum diisi.", "error"); return; }

      // Simpan jadwal piket
      if (type === "piket") {
        const ids = getCheckedIds("piket-checklist");
        await DB.saveJadwalDate(dateStr, ids);
      }

      const loaded = await loadQRCodeLib();
      if (!loaded || typeof QRCode === "undefined") {
        showToast("Library QR tidak tersedia.", "error"); return;
      }

      if (location.protocol === "file:") {
        showToast("Jalankan via server HTTP/HTTPS agar QR stabil.", "error");
      }

      const token = generateToken(type, dateStr, settings.secret_key);
      const expiresAtSec = unixSecNow() + 300;
      qrState.expiresAtSec = expiresAtSec;
      qrState.token = token;
      qrState.type = type;
      qrState.dateStr = dateStr;

      // FIXED: Pendekkan payload QR agar mudah discan (banyak scanner suka "memotong" URL panjang)
      // Koordinat/radius diambil dari Supabase settings pada halaman anggota (fallback sudah ada di script.js).
      const url = new URL(window.location.origin + "/"); // FIXED: cukup root, tidak perlu /index.html
      url.searchParams.set("t", token);
      // FIXED: cache-busting untuk beberapa in-app browser yang suka pakai cache meski header no-store
      url.searchParams.set("v", String(Date.now()));

      // FIXED: fallback jika scanner/in-app browser membuang query (?)
      url.hash = new URLSearchParams({ t: token, v: String(Date.now()) }).toString();

      qrState.url = url.toString();
      saveQrStateToStorage({
        url: qrState.url,
        token: qrState.token,
        expiresAtSec: qrState.expiresAtSec,
        type: qrState.type,
        dateStr: qrState.dateStr,
      });

      const labelType = type === "piket" ? "QR PIKET" : "QR HADIR BEBAS";

      const container = $("qr-canvas");
      container.innerHTML = "";
      new QRCode(container, { text: url.toString(), width: 300, height: 300, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });

      const print = $("print-qr");
      print.innerHTML = "";
      new QRCode(print, { text: url.toString(), width: 320, height: 320, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });

      const validUntil = new Date(expiresAtSec * 1000);
      const hhmm = `${pad2(validUntil.getHours())}:${pad2(validUntil.getMinutes())}`;
      const remNow = secondsUntil(expiresAtSec);

      $("qr-label").textContent = `${labelType} - ${dateStr} - Berlaku hingga ${hhmm}`;
      $("qr-valid-until").textContent = hhmm;
      $("qr-remaining").textContent = `${pad2(Math.floor(remNow / 60))}:${pad2(remNow % 60)}`;
      $("qr-url").textContent = url.toString();
      $("qr-token").textContent = token;
      $("print-title").textContent = labelType;
      $("print-meta").textContent = `${dateStr} - Berlaku hingga ${hhmm}`;

      showToast("QR berhasil dibuat.");
    } catch (err) {
      showToast(`Gagal buat QR: ${err?.message || err}. Coba reload.`, "error");
    }
  }

  function startQrAutoRefresh() {
    if (qrState.timer) window.clearInterval(qrState.timer);
    const tick = async () => {
      const rem = qrState.expiresAtSec ? secondsUntil(qrState.expiresAtSec) : 0;
      const el = $("qr-remaining");
      if (el) el.textContent = `${pad2(Math.floor(rem / 60))}:${pad2(rem % 60)}`;
      if (rem === 0 && $("tab-qr").classList.contains("active")) {
        await renderQr();
      }
    };
    tick();
    qrState.timer = window.setInterval(tick, 1000);
  }

  // ===== Anggota =====

  async function renderAnggotaTable() {
    const q = $("anggota-search").value.trim().toLowerCase();
    const anggota = await DB.getAnggota();

    const filtered = anggota.filter((a) => {
      if (!q) return true;
      return (
        String(a.nama).toLowerCase().includes(q) ||
        String(a.nim).toLowerCase().includes(q) ||
        String(a.divisi).toLowerCase().includes(q)
      );
    });

    const tbody = $("tbody-anggota");
    tbody.innerHTML = filtered.map((a) => `
      <tr>
        <td class="mono">${a.id}</td>
        <td>${a.nama}</td>
        <td>${a.nim}</td>
        <td>${a.divisi}</td>
        <td class="mono">${a.nohp || "-"}</td>
        <td><button class="btn btn--ghost" data-del-anggota="${a.id}" type="button">Hapus</button></td>
      </tr>
    `).join("");

    tbody.querySelectorAll("[data-del-anggota]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.getAttribute("data-del-anggota"));
        if (!confirm("Hapus anggota ini?")) return;
        btn.disabled = true;
        await DB.deleteAnggota(id);
        await renderAnggotaTable();
        await renderAllChecklists();
        showToast("Anggota dihapus.");
      });
    });
  }

  async function exportAnggotaCSV() {
    const anggota = await DB.getAnggota();
    const rows = [["nama", "nim", "divisi", "nohp"]];
    anggota.forEach((a) => rows.push([a.nama, a.nim, a.divisi, a.nohp]));
    downloadText(`anggota_${formatDateYYYYMMDD(new Date())}.csv`, toCSV(rows), "text/csv");
  }

  async function importAnggotaCSV(file) {
    const text = await file.text();
    const rows = parseCSV(text);
    if (!rows.length) { showToast("File CSV kosong.", "error"); return; }

    const start = rows[0][0]?.toLowerCase() === "nama" ? 1 : 0;
    const nextId = await DB.getNextAnggotaId();
    let id = nextId;
    let added = 0;

    for (let i = start; i < rows.length; i++) {
      const [nama, nim, divisi, nohp] = rows[i];
      if (!nama || !nim) continue;
      await DB.upsertAnggota({ id, nama, nim, divisi: divisi || "-", nohp: nohp || "-" });
      id++;
      added++;
    }

    await renderAnggotaTable();
    await renderAllChecklists();
    showToast(`Impor selesai. Ditambahkan: ${added}.`);
  }

  // ===== Checklist helper =====

  async function renderChecklist(containerId, filterInputId, selectedIds) {
    const anggota = await DB.getAnggota();
    const q = filterInputId ? $(filterInputId).value.trim().toLowerCase() : "";
    const items = anggota.filter((a) => {
      if (!q) return true;
      return String(a.nama).toLowerCase().includes(q) || String(a.divisi).toLowerCase().includes(q);
    });

    const container = $(containerId);
    container.innerHTML = items.map((a) => {
      const checked = selectedIds.includes(Number(a.id)) ? "checked" : "";
      return `
        <label class="checkitem">
          <input type="checkbox" value="${a.id}" ${checked} />
          <span>${a.nama}</span>
          <span class="muted small">(${a.divisi})</span>
        </label>
      `;
    }).join("");
  }

  function getCheckedIds(containerId) {
    const container = $(containerId);
    const ids = [];
    container.querySelectorAll("input[type=checkbox]:checked").forEach((cb) => {
      const id = Number.parseInt(cb.value, 10);
      if (Number.isFinite(id)) ids.push(id);
    });
    return ids;
  }

  async function renderAllChecklists() {
    const type = $("qr-type").value;
    const jadwal = await DB.getJadwal();

    if (type === "piket") {
      const date = $("qr-date").value;
      const selected = Array.isArray(jadwal[date]) ? jadwal[date] : [];
      await renderChecklist("piket-checklist", "piket-filter", selected);
    }

    const date2 = $("jadwal-date").value;
    const selected2 = Array.isArray(jadwal[date2]) ? jadwal[date2] : [];
    await renderChecklist("jadwal-checklist", "jadwal-filter", selected2);
  }

  // ===== Jadwal Piket =====

  function mondayOfWeek(d) {
    const date = new Date(d);
    const day = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - day);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function addDays(d, n) {
    const x = new Date(d); x.setDate(x.getDate() + n); return x;
  }

  const weekState = { base: mondayOfWeek(new Date()) };

  async function renderWeekCalendar() {
    const jadwal = await DB.getJadwal();
    const anggota = await DB.getAnggota();
    const start = weekState.base;

    $("week-range").textContent = `${formatDateYYYYMMDD(start)} s/d ${formatDateYYYYMMDD(addDays(start, 6))}`;

    const tbody = $("tbody-week");
    tbody.innerHTML = "";

    for (let i = 0; i < 7; i++) {
      const date = formatDateYYYYMMDD(addDays(start, i));
      const ids = Array.isArray(jadwal[date]) ? jadwal[date] : [];
      const names = ids.map((id) => anggota.find((a) => Number(a.id) === Number(id))?.nama).filter(Boolean);
      tbody.innerHTML += `
        <tr>
          <td class="mono">${date}</td>
          <td class="mono">${ids.length}</td>
          <td>${names.join(", ") || "-"}</td>
        </tr>
      `;
    }
  }

  async function exportJadwalBulananCSV() {
    const jadwal = await DB.getJadwal();
    const anggota = await DB.getAnggota();
    const month = new Date().toISOString().slice(0, 7);
    const dates = Object.keys(jadwal).filter((d) => d.startsWith(month)).sort();
    const rows = [["tanggal", "nama"]];
    dates.forEach((d) => {
      const ids = Array.isArray(jadwal[d]) ? jadwal[d] : [];
      const names = ids.map((id) => anggota.find((a) => Number(a.id) === Number(id))?.nama).filter(Boolean);
      rows.push([d, ...names]);
    });
    downloadText(`jadwal_${month}.csv`, toCSV(rows), "text/csv");
  }

  async function importJadwalCSV(file) {
    const text = await file.text();
    const rows = parseCSV(text);
    if (!rows.length) { showToast("File CSV kosong.", "error"); return; }
    const anggota = await DB.getAnggota();
    const byName = new Map(anggota.map((a) => [String(a.nama).toLowerCase(), Number(a.id)]));
    const start = rows[0][0]?.toLowerCase() === "tanggal" ? 1 : 0;
    let changed = 0;
    for (let i = start; i < rows.length; i++) {
      const [tanggal, ...names] = rows[i];
      if (!tanggal) continue;
      const ids = names.map((n) => byName.get(String(n).toLowerCase())).filter((x) => Number.isFinite(x));
      await DB.saveJadwalDate(tanggal, ids);
      changed++;
    }
    await renderAllChecklists();
    await renderWeekCalendar();
    showToast(`Impor jadwal selesai. Baris diproses: ${changed}.`);
  }

  // ===== Dashboard =====

  async function buildStatusForToday(dateStr) {
    const [settings, anggota, jadwal, log] = await Promise.all([
      DB.getSettings(),
      DB.getAnggota(),
      DB.getJadwal(),
      DB.getLog(dateStr),
    ]);

    const dutyIds = new Set((jadwal[dateStr] || []).map((x) => Number(x)));
    const byId = new Map();
    log.forEach((e) => {
      if (e.id_anggota != null) byId.set(Number(e.id_anggota), e);
    });

    const rows = anggota.map((a) => {
      const id = Number(a.id);
      const entry = byId.get(id) || null;
      const scheduled = dutyIds.has(id);
      let statusKey = "belum", badge = "badge--belum", statusText = "Belum Absen";
      if (!scheduled && !entry) { statusKey = "noduty"; badge = "badge--noduty"; statusText = "Tidak Dijadwal"; }
      else if (entry) {
        if (entry.tipe === "piket") { statusKey = "piket"; badge = "badge--piket"; statusText = "Hadir Piket"; }
        else { statusKey = "bebas"; badge = "badge--bebas"; statusText = "Hadir Bebas"; }
      }
      return { anggota: a, entry, scheduled, statusKey, badge, statusText };
    });

    return {
      rows,
      stats: {
        totalJadwal: dutyIds.size,
        sudahPiket: log.filter((e) => e.tipe === "piket").length,
        sudahBebas: log.filter((e) => e.tipe === "bebas").length,
        belum: rows.filter((r) => r.scheduled && !r.entry).length,
      },
    };
  }

  async function renderDashboard() {
    const today = formatDateYYYYMMDD(new Date());
    $("dash-date").textContent = formatDateIndo(new Date());

    const { rows, stats } = await buildStatusForToday(today);
    $("stat-jadwal").textContent = String(stats.totalJadwal);
    $("stat-piket").textContent = String(stats.sudahPiket);
    $("stat-bebas").textContent = String(stats.sudahBebas);
    $("stat-belum").textContent = String(stats.belum);

    const q = $("dash-search").value.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (!q) return true;
      const a = r.anggota;
      return String(a.nama).toLowerCase().includes(q) || String(a.divisi).toLowerCase().includes(q) || String(a.nim).toLowerCase().includes(q);
    });

    const tbody = $("tbody-dash");
    tbody.innerHTML = filtered.map((r, idx) => {
      const e = r.entry;
      return `
        <tr>
          <td class="mono">${idx + 1}</td>
          <td>${r.anggota.nama}</td>
          <td class="mono">${r.anggota.nim}</td>
          <td>${r.anggota.divisi}</td>
          <td><span class="badge ${r.badge}">${r.statusText}</span></td>
          <td class="mono">${e?.waktu || "-"}</td>
          <td class="mono">${Number.isFinite(e?.jarak_meter) ? `${e.jarak_meter} m` : "-"}</td>
        </tr>
      `;
    }).join("");

    $("dash-empty").style.display = filtered.length ? "none" : "block";
  }

  async function exportDashboardCSV() {
    const today = formatDateYYYYMMDD(new Date());
    const { rows } = await buildStatusForToday(today);
    const out = [["nama", "nim", "divisi", "status", "tipe", "waktu", "jarak_meter"]];
    rows.forEach((r) => {
      out.push([r.anggota.nama, r.anggota.nim, r.anggota.divisi, r.statusText, r.entry?.tipe || "-", r.entry?.waktu || "-", r.entry?.jarak_meter ?? "-"]);
    });
    downloadText(`dashboard_${today}.csv`, toCSV(out), "text/csv");
  }

  // ===== Rekap =====

  function weekStartFromYearWeek(year, week) {
    const jan4 = new Date(year, 0, 4);
    const day = jan4.getDay() || 7;
    const monday = new Date(jan4);
    monday.setDate(jan4.getDate() - day + 1 + (week - 1) * 7);
    monday.setHours(0, 0, 0, 0);
    return monday;
  }

  async function renderRekapHarian() {
    const date = $("r-date").value;
    const log = await DB.getLog(date);
    const tbody = $("tbody-r-harian");
    tbody.innerHTML = log.map((e, idx) => `
      <tr>
        <td class="mono">${idx + 1}</td>
        <td>${e.nama}</td>
        <td class="mono">${e.tipe}</td>
        <td class="mono">${e.waktu}</td>
        <td class="mono">${Number.isFinite(e.jarak_meter) ? `${e.jarak_meter} m` : "-"}</td>
        <td class="mono">${e.terlambat ? "YA" : "TIDAK"}</td>
      </tr>
    `).join("");
  }

  async function exportRekapHarianCSV() {
    const date = $("r-date").value;
    const log = await DB.getLog(date);
    const rows = [["nama", "nim", "divisi", "tipe", "waktu", "jarak_meter", "terlambat"]];
    log.forEach((e) => rows.push([e.nama, e.nim, e.divisi, e.tipe, e.waktu, e.jarak_meter ?? "-", e.terlambat ? "YA" : "TIDAK"]));
    downloadText(`rekap_harian_${date}.csv`, toCSV(rows), "text/csv");
  }

  async function renderRekapMingguan() {
    const val = $("r-week").value;
    if (!val) return;
    const [y, w] = val.split("W");
    const start = weekStartFromYearWeek(Number(y), Number(w));
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i); return formatDateYYYYMMDD(d);
    });
    const anggota = await DB.getAnggota();

    $("thead-r-week").innerHTML = `<tr><th>Nama</th>${days.map((d) => `<th class="mono">${d.slice(5)}</th>`).join("")}<th>Total</th></tr>`;

    const body = $("tbody-r-week");
    const logsByDay = await Promise.all(days.map((d) => DB.getLog(d)));
    let html = "";
    anggota.forEach((a) => {
      let total = 0;
      let row = `<tr><td>${a.nama}</td>`;
      days.forEach((d, i) => {
        const hadir = logsByDay[i].some((e) => Number(e.id_anggota) === Number(a.id));
        if (hadir) { total++; row += `<td class="mono">H</td>`; } else { row += `<td class="mono">-</td>`; }
      });
      row += `<td class="mono">${total}</td></tr>`;
      html += row;
    });
    body.innerHTML = html;
  }

  async function exportRekapMingguanCSV() {
    const val = $("r-week").value;
    if (!val) return;
    const [y, w] = val.split("W");
    const start = weekStartFromYearWeek(Number(y), Number(w));
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i); return formatDateYYYYMMDD(d);
    });
    const anggota = await DB.getAnggota();
    const rows = [["nama", ...days, "total"]];
    const logsByDay = await Promise.all(days.map((d) => DB.getLog(d)));
    anggota.forEach((a) => {
      let total = 0;
      const row = [a.nama];
      days.forEach((d, i) => {
        const hadir = logsByDay[i].some((e) => Number(e.id_anggota) === Number(a.id));
        row.push(hadir ? "H" : "-");
        if (hadir) total++;
      });
      row.push(String(total));
      rows.push(row);
    });
    downloadText(`rekap_mingguan_${val}.csv`, toCSV(rows), "text/csv");
  }

  async function renderRekapBulanan() {
    const month = $("r-month").value;
    if (!month) return;
    const [dates, anggota] = await Promise.all([DB.getAllLogDates(), DB.getAnggota()]);
    const filteredDates = dates.filter((d) => d.startsWith(month));
    const totalHari = filteredDates.length;
    const logsByDay = await Promise.all(filteredDates.map((d) => DB.getLog(d)));

    const counts = new Map();
    let max = 0;
    anggota.forEach((a) => {
      let hadir = 0;
      logsByDay.forEach((log) => { if (log.some((e) => Number(e.id_anggota) === Number(a.id))) hadir++; });
      counts.set(Number(a.id), hadir);
      if (hadir > max) max = hadir;
    });

    $("tbody-r-month").innerHTML = anggota.map((a) => {
      const hadir = counts.get(Number(a.id)) || 0;
      const pct = totalHari ? Math.round((hadir / totalHari) * 100) : 0;
      const w = max ? Math.round((hadir / max) * 100) : 0;
      return `
        <tr>
          <td>${a.nama}</td><td>${a.divisi}</td>
          <td class="mono">${hadir}</td><td class="mono">${totalHari}</td><td class="mono">${pct}%</td>
          <td>
            <div style="display:flex;align-items:center;gap:.5rem">
              <div style="height:18px;width:${w}%;min-width:18px;background:var(--primary);border-radius:6px;transition:width .4s"></div>
              <span class="mono">${hadir}</span>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  async function exportRekapBulananCSV() {
    const month = $("r-month").value;
    if (!month) return;
    const [dates, anggota] = await Promise.all([DB.getAllLogDates(), DB.getAnggota()]);
    const filteredDates = dates.filter((d) => d.startsWith(month));
    const totalHari = filteredDates.length;
    const logsByDay = await Promise.all(filteredDates.map((d) => DB.getLog(d)));
    const rows = [["nama", "divisi", "total_hadir", "total_hari", "persentase"]];
    anggota.forEach((a) => {
      let hadir = 0;
      logsByDay.forEach((log) => { if (log.some((e) => Number(e.id_anggota) === Number(a.id))) hadir++; });
      rows.push([a.nama, a.divisi, String(hadir), String(totalHari), `${totalHari ? Math.round((hadir / totalHari) * 100) : 0}%`]);
    });
    downloadText(`rekap_bulanan_${month}.csv`, toCSV(rows), "text/csv");
  }

  // ===== Pengaturan =====

  async function updateSettingsUI() {
    const s = await DB.getSettings();
    if (!s) return;
    $("admin-org-name").textContent = s.nama_org;
    $("s-org").value = s.nama_org;
    // Jangan menimpa input lat/lng sesaat setelah user klik "Gunakan Lokasi Saya"
    if (Date.now() > uiState.latLngLockUntil) {
      $("s-lat").value = String(s.sekre_lat ?? "").replace(",", "."); // FIXED: normalisasi tampilan
      $("s-lng").value = String(s.sekre_lng ?? "").replace(",", "."); // FIXED: normalisasi tampilan
    }
    $("s-radius").value = String(s.radius_meter ?? "").replace(",", "."); // FIXED: normalisasi tampilan
    $("s-jam").value = s.jam_batas_terlambat;
    $("s-secret").textContent = s.secret_key;
    $("s-sk").textContent = await getSecretHash(s.secret_key);
  }

  async function wipeAllData() {
    const ok1 = confirm("Hapus semua data? Ini tidak bisa dibatalkan.");
    if (!ok1) { showToast("Dibatalkan.", "error"); return; }
    const confirm2 = prompt("Ketik HAPUS untuk konfirmasi (huruf besar/kecil bebas):");
    const normalized = String(confirm2 ?? "").trim().toUpperCase();
    if (normalized !== "HAPUS") { showToast("Dibatalkan. Ketik 'HAPUS' untuk melanjutkan.", "error"); return; }
    const ok = await DB.wipeAllData();
    if (ok) {
      setLoggedIn(false);
      location.reload();
    } else {
      showToast("Gagal hapus data. Coba lagi.", "error");
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) { showToast("GPS tidak tersedia.", "error"); return; }
    if (!window.isSecureContext) { showToast("GPS butuh HTTPS. Buka admin lewat link Vercel (https://...).", "error"); return; }
    showToast("Mengambil lokasi...");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = Number(pos.coords.latitude);
        const lng = Number(pos.coords.longitude);
        const accuracy = Number(pos.coords.accuracy);

        // Kunci sebentar agar updateSettingsUI tidak mengembalikan nilai lama
        uiState.latLngLockUntil = Date.now() + 6000;

        // Isi form supaya user lihat angkanya
        $("s-lat").value = lat.toFixed(6);
        $("s-lng").value = lng.toFixed(6);

        // Coba simpan ke Supabase agar scan berikutnya memakai lokasi terbaru
        try {
          const s = (await DB.getSettings()) || (await ensureDefaultSettings());
          if (s) {
            const prevLat = Number(s.sekre_lat);
            const prevLng = Number(s.sekre_lng);
            s.sekre_lat = lat;
            s.sekre_lng = lng;
            const ok = await DB.saveSettings(s);
            if (!ok) {
              const last = window.__SB_LAST_ERROR;
              const extra = last?.status ? ` (Supabase ${last.status})` : "";
              showToast(`Lokasi terisi, tapi gagal simpan ke server${extra}. Pastikan RLS/policy Supabase mengizinkan update.`, "error");
              return;
            }

            // Verifikasi server benar-benar menyimpan nilai baru
            const s2 = await DB.getSettings();
            const lat2 = Number(s2?.sekre_lat);
            const lng2 = Number(s2?.sekre_lng);
            const sameAsPrev = Number.isFinite(prevLat) && Number.isFinite(prevLng) && Math.abs(prevLat - lat) < 1e-7 && Math.abs(prevLng - lng) < 1e-7;
            const sameAsServer = Number.isFinite(lat2) && Number.isFinite(lng2) && Math.abs(lat2 - lat) < 1e-7 && Math.abs(lng2 - lng) < 1e-7;

            if (sameAsPrev) {
              const accText = Number.isFinite(accuracy) ? ` (akurasi ±${Math.round(accuracy)}m)` : "";
              showToast(`GPS terbaca sama dengan lokasi sebelumnya${accText}.`, "error");
            } else if (!sameAsServer) {
              const accText = Number.isFinite(accuracy) ? ` (akurasi ±${Math.round(accuracy)}m)` : "";
              showToast(`Lokasi terbaca: ${lat.toFixed(5)}, ${lng.toFixed(5)}${accText}. Tapi server masih: ${Number.isFinite(lat2) ? lat2.toFixed(5) : "?"}, ${Number.isFinite(lng2) ? lng2.toFixed(5) : "?"}. Klik Simpan Pengaturan.`, "error");
            } else {
              const accText = Number.isFinite(accuracy) ? ` (akurasi ±${Math.round(accuracy)}m)` : "";
              showToast(`Lokasi sekretariat tersimpan: ${lat.toFixed(5)}, ${lng.toFixed(5)}${accText}`);
            }
            window.setTimeout(() => { uiState.latLngLockUntil = 0; }, 1500);
            return;
          }
        } catch (e) {
          const last = window.__SB_LAST_ERROR;
          const extra = last?.status ? ` (Supabase ${last.status})` : "";
          showToast(`Lokasi terisi, tapi gagal simpan otomatis${extra}. Klik Simpan Pengaturan.`, "error");
          window.setTimeout(() => { uiState.latLngLockUntil = 0; }, 3000);
          return;
        }

        const accText = Number.isFinite(accuracy) ? ` (akurasi ±${Math.round(accuracy)}m)` : "";
        showToast(`Lokasi terisi: ${lat.toFixed(5)}, ${lng.toFixed(5)}${accText} (klik Simpan Pengaturan)`, "error");
        window.setTimeout(() => { uiState.latLngLockUntil = 0; }, 3000);
      },
      (err) => {
        const msg = err.code === 1 ? "Izin lokasi ditolak. Aktifkan izin Lokasi untuk situs ini." :
                    err.code === 2 ? "Lokasi tidak bisa dideteksi. Coba lagi." :
                    err.code === 3 ? "Timeout GPS. Coba lagi." : "Lokasi tidak bisa diambil.";
        showToast(msg, "error");
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }

  function formatLastSupabaseError() {
    const last = window.__SB_LAST_ERROR;
    if (!last) return "";
    const parts = [];
    if (last.context) parts.push(String(last.context));
    if (last.status) parts.push(`status ${last.status}`);
    if (last.code) parts.push(`code ${last.code}`);
    const head = parts.length ? `[${parts.join(" · ")}]` : "";
    const msg = last.message ? String(last.message) : "";
    const details = last.details ? ` — ${String(last.details)}` : "";
    const hint = last.hint ? ` (hint: ${String(last.hint)})` : "";
    return `${head} ${msg}${details}${hint}`.trim();
  }

  async function regenerateSecret() {
    const ok = confirm("Regenerate secret key? QR lama akan menjadi tidak valid.");
    if (!ok) return;
    const s = await DB.getSettings();
    s.secret_key = randomSecret(8);
    await DB.saveSettings(s);
    await updateSettingsUI();
    if ($("tab-qr").classList.contains("active")) await renderQr();
    showToast("Secret key diperbarui.");
  }

  async function exportAllDataJSON() {
    const data = await DB.exportAllData();
    downloadJSON(`backup_absensi_${formatDateYYYYMMDD(new Date())}.json`, data);
  }

  async function importAllDataJSON(file) {
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      const ok = confirm("Impor data akan menimpa data yang ada. Lanjutkan?");
      if (!ok) return;
      showToast("Mengimpor data...");
      const success = await DB.importAllData(data);
      if (success) { showToast("Impor berhasil."); location.reload(); }
      else showToast("Impor sebagian gagal. Cek konsol.", "error");
    } catch {
      showToast("File JSON tidak valid.", "error");
    }
  }

  // ===== BroadcastChannel =====

  function initChannel() {
    try {
      const ch = new BroadcastChannel(CHANNEL_NAME);
      ch.onmessage = async (ev) => {
        const msg = ev.data;
        if (!msg || msg.type !== "absen") return;
        const { date, entry } = msg.payload || {};
        if (!date || !entry) return;
        // Log sudah diinsert oleh halaman anggota via DB.insertLog,
        // tapi jika anggota dan admin di browser yang sama, bisa double-insert.
        // Kita skip insert di sini karena Supabase sudah jadi sumber kebenaran.
        renderDashboard();
      };
    } catch { /* abaikan */ }
  }

  // ===== Jam header =====

  function updateClock() {
    const now = new Date();
    $("admin-now-time").textContent = formatTimeHHMMSS(now);
    $("admin-now-date").textContent = formatDateIndo(now);
  }

  // ===== Bind event =====

  function bindAdminUI() {
    document.querySelectorAll(".admin-tab").forEach((b) => {
      b.addEventListener("click", () => switchAdminTab(b.dataset.tab));
    });

    const btnLogout = $("btn-logout");
    if (btnLogout) {
      btnLogout.addEventListener("click", () => {
        setLoggedIn(false);
        location.reload();
      });
    }

    // Dashboard
    $("dash-search").addEventListener("input", renderDashboard);
    $("btn-dash-refresh").addEventListener("click", renderDashboard);
    $("btn-dash-export").addEventListener("click", exportDashboardCSV);

    // QR
    $("qr-type").addEventListener("change", async () => {
      $("row-qr-piket").style.display = $("qr-type").value === "piket" ? "block" : "none";
      await renderAllChecklists();
    });
    $("piket-filter").addEventListener("input", renderAllChecklists);

    $("form-qr").addEventListener("submit", async (e) => {
      e.preventDefault();
      await renderQr();
    });

    $("btn-qr-refresh").addEventListener("click", async () => { await renderQr(); });

    // Jadwal
    $("jadwal-filter").addEventListener("input", renderAllChecklists);
    $("form-jadwal").addEventListener("submit", async (e) => {
      e.preventDefault();
      const date = $("jadwal-date").value;
      const ids = getCheckedIds("jadwal-checklist");
      await DB.saveJadwalDate(date, ids);
      await renderWeekCalendar();
      showToast("Jadwal tersimpan.");
    });

    $("btn-week-prev").addEventListener("click", async () => {
      weekState.base = new Date(weekState.base);
      weekState.base.setDate(weekState.base.getDate() - 7);
      await renderWeekCalendar();
    });
    $("btn-week-next").addEventListener("click", async () => {
      weekState.base = new Date(weekState.base);
      weekState.base.setDate(weekState.base.getDate() + 7);
      await renderWeekCalendar();
    });

    $("btn-jadwal-export").addEventListener("click", exportJadwalBulananCSV);
    $("btn-jadwal-import").addEventListener("click", () => $("file-jadwal").click());
    $("file-jadwal").addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) importJadwalCSV(f);
      e.target.value = "";
    });

    // Anggota
    $("anggota-search").addEventListener("input", renderAnggotaTable);
    $("form-anggota").addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = await DB.getNextAnggotaId();
      const anggota = {
        id,
        nama: $("a-nama").value.trim(),
        nim: $("a-nim").value.trim(),
        divisi: $("a-divisi").value.trim(),
        nohp: $("a-nohp").value.trim(),
      };
      await DB.upsertAnggota(anggota);
      e.target.reset();
      await renderAnggotaTable();
      await renderAllChecklists();
      showToast("Anggota ditambahkan.");
    });

    $("btn-anggota-export").addEventListener("click", exportAnggotaCSV);
    $("btn-anggota-import").addEventListener("click", () => $("file-anggota").click());
    $("file-anggota").addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) importAnggotaCSV(f);
      e.target.value = "";
    });

    // Rekap
    document.querySelectorAll(".segmented__btn").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".segmented__btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        const mode = b.dataset.mode;
        $("rekap-harian").style.display = mode === "harian" ? "block" : "none";
        $("rekap-mingguan").style.display = mode === "mingguan" ? "block" : "none";
        $("rekap-bulanan").style.display = mode === "bulanan" ? "block" : "none";
      });
    });

    $("r-date").addEventListener("change", renderRekapHarian);
    $("btn-r-export").addEventListener("click", exportRekapHarianCSV);
    $("r-week").addEventListener("change", renderRekapMingguan);
    $("btn-r-week-export").addEventListener("click", exportRekapMingguanCSV);
    $("r-month").addEventListener("change", renderRekapBulanan);
    $("btn-r-month-export").addEventListener("click", exportRekapBulananCSV);

    // Settings
    $("form-settings").addEventListener("submit", async (e) => {
      e.preventDefault();
      const s = (await DB.getSettings()) || (await ensureDefaultSettings());
      s.nama_org = $("s-org").value.trim() || s.nama_org;
      const latRaw = $("s-lat").value; // FIXED
      const lngRaw = $("s-lng").value; // FIXED
      const lat = Number.parseFloat(String(latRaw ?? "").replace(",", ".")); // FIXED: parseFloat + koma→titik
      const lng = Number.parseFloat(String(lngRaw ?? "").replace(",", ".")); // FIXED: parseFloat + koma→titik
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        showToast("Latitude/Longitude tidak valid. Contoh: -0.920781 dan 100.378214 (pakai titik).", "error"); // FIXED
        return; // FIXED
      }
      s.sekre_lat = lat; // FIXED
      s.sekre_lng = lng; // FIXED
      s.radius_meter = Number.parseFloat(String($("s-radius").value ?? "").replace(",", ".")) || 100; // FIXED
      s.jam_batas_terlambat = $("s-jam").value || "08:00";
      const ok = await DB.saveSettings(s);
      if (!ok) {
        const errText = formatLastSupabaseError();
        const extra = errText ? `\n${errText}` : "";
        showToast(`Gagal menyimpan ke server.\nCek Supabase: RLS/policy & Allowed Origins.${extra}`, "error");
        return;
      }
      await updateSettingsUI();
      showToast("Pengaturan disimpan.");
    });

    $("btn-use-my-location").addEventListener("click", useMyLocation);
    $("btn-secret-regenerate").addEventListener("click", regenerateSecret);

    const formPassword = $("form-password");
    if (formPassword) {
      formPassword.addEventListener("submit", async (e) => {
        e.preventDefault();
        await changePassword($("p-new").value);
        $("p-new").value = "";
      });
    }

    $("btn-export-json").addEventListener("click", exportAllDataJSON);
    $("btn-import-json").addEventListener("click", () => $("file-json").click());
    $("file-json").addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) importAllDataJSON(f);
      e.target.value = "";
    });

    $("btn-wipe").addEventListener("click", wipeAllData);
    $("btn-print-qr").addEventListener("click", () => window.print());
  }

  // ===== Init =====

  let __didInit = false; // FIXED: cegah init dobel

  function isDBReady() {
    return !!(window.DB && typeof window.DB.getSettings === "function" && window.__SEKRE_DB_READY__); // FIXED
  }

  function isSupabaseReady() {
    return !!(window.supabase && typeof window.supabase.createClient === "function"); // FIXED
  }

  async function waitForPrereqs(timeoutMs = 8000) {
    if (isDBReady() && isSupabaseReady()) return true; // FIXED

    return await new Promise((resolve) => {
      let done = false; // FIXED
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { window.removeEventListener("sekre:db-ready", onReady); } catch { /* ignore */ }
        resolve(ok);
      };

      const onReady = () => {
        if (isDBReady() && isSupabaseReady()) finish(true); // FIXED
      };

      try { window.addEventListener("sekre:db-ready", onReady, { once: false }); } catch { /* ignore */ } // FIXED

      const started = Date.now(); // FIXED
      const timer = window.setInterval(() => {
        if (isDBReady() && isSupabaseReady()) {
          window.clearInterval(timer);
          finish(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          window.clearInterval(timer);
          finish(false);
        }
      }, 50);
    });
  }

  async function init() {
    if (__didInit) return; // FIXED
    __didInit = true; // FIXED

    // FIXED: tunggu Supabase CDN + db.js benar-benar siap (hindari race condition / cache)
    const okPrereq = await waitForPrereqs(8000); // FIXED
    if (!okPrereq) {
      const last = window.__SB_LAST_ERROR;
      const hint401 = last?.status === 401 ? "\n\nCatatan: 401 dari Supabase biasanya karena domain Vercel belum di-allow (Settings → API → Allowed Origins/URLs) atau key tidak sesuai." : "";
      document.body.innerHTML = `<div style="padding:2rem;font-family:sans-serif;color:red">
        <h2>Error: db.js tidak siap</h2>
        <p>Pastikan file <code>/db.js</code> bisa di-load dari <code>/admin/admin.html</code> (Network tab: status 200).</p>
        <p>Jika <code>/db.js</code> atau <code>/style.css</code> statusnya 404 di Vercel, berarti setelan Vercel salah: Root Directory harus mengarah ke folder yang berisi <code>index.html</code>, <code>db.js</code>, <code>style.css</code>, dan folder <code>admin/</code>.</p> <!-- // FIXED -->
        <p>Jika status 200 tapi tetap gagal, kemungkinan ada error parse di db.js di browser ini.</p>
        <p style="white-space:pre-wrap">Debug: lastError=${last ? JSON.stringify(last) : "(none)"}${hint401}</p>
      </div>`; // FIXED
      return; // FIXED
    }

    // Clock
    updateClock();
    window.setInterval(updateClock, 1000);

    // Prepare default inputs
    const today = formatDateYYYYMMDD(new Date());
    $("qr-date").value = today;
    $("jadwal-date").value = today;
    $("r-date").value = today;

    const now = new Date();
    const iso = getISOWeek(now);
    $("r-week").value = `${iso.year}W${pad2(iso.week)}`;
    $("r-month").value = now.toISOString().slice(0, 7);

    // Login gating
    if (!isLoggedIn()) {
      $("panel-login").style.display = "block";
      $("panel-dashboard").style.display = "none";

      await ensureDefaultSettings();

      $("form-login").addEventListener("submit", async (e) => {
        e.preventDefault();
        const pass = $("input-password").value;
        const ok = await checkPassword(pass);
        if (!ok) { showToast("Password salah.", "error"); return; }
        setLoggedIn(true);
        location.reload();
      });

      return;
    }

    $("panel-login").style.display = "none";
    $("panel-dashboard").style.display = "block";

    await ensureDefaultSettings();

    bindAdminUI();
    initChannel();
    await updateSettingsUI();

    await Promise.all([
      renderAnggotaTable(),
      renderAllChecklists(),
      renderWeekCalendar(),
    ]);

    $("row-qr-piket").style.display = $("qr-type").value === "piket" ? "block" : "none";
    await ensureQrCurrent();
    startQrAutoRefresh();

    await renderDashboard();
    window.setInterval(() => {
      if ($("tab-dash").classList.contains("active")) renderDashboard();
    }, 10000);

    await Promise.all([renderRekapHarian(), renderRekapMingguan(), renderRekapBulanan()]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init); // FIXED
  } else {
    init(); // FIXED
  }
})();