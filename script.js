/*
  script.js (Halaman Anggota) — versi Supabase
  - Validasi token QR dinamis
  - Validasi GPS radius dari sekretariat
  - Simpan log absensi di Supabase (sinkron dengan admin)

  Perbaikan:
  1. Data anggota diambil dari Supabase (bukan localStorage) → selalu sinkron
  2. Log absensi dikirim ke Supabase → admin bisa lihat real-time
  3. GPS timeout ditambah ke 20 detik
  4. Pesan error GPS lebih jelas
*/

(function () {
  "use strict";

  const CHANNEL_NAME = "absensi-sekre";
  const DEFAULT_ATTENDANCE_RADIUS_METER = 150;

  const FALLBACK_MEMBERS = Array.from({ length: 100 }, (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    return { id: i + 1, nama: `Anggota ${n}`, nim: "-", divisi: "-" };
  });

  const state = {
    token: null,
    type: "bebas",
    date: null,
    expiresAtSec: null,
    issuedAtSec: null,
    ttlSec: null,
    deviceId: null,
    sekre: { lat: null, lng: null, radius: DEFAULT_ATTENDANCE_RADIUS_METER },
    gps: { lat: null, lng: null, accuracy: null, distance: null, tolerance: 0, effectiveRadius: DEFAULT_ATTENDANCE_RADIUS_METER },
    remainingSec: 0,
    countdownTimer: null,
    channel: null,
    anggota: [],
    qrUpdatedNotified: false,
  };

  // ===== Util =====

  function $(id) { return document.getElementById(id); }

  function showToast(message, type = "success") {
    const toast = $("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.style.borderLeftColor = type === "error" ? "var(--red)" : "var(--primary)";
    toast.classList.add("show");
    window.setTimeout(() => toast.classList.remove("show"), 3500);
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function formatRemaining(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return hh > 0 ? `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}` : `${pad2(mm)}:${pad2(ss)}`;
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

  function formatDateYYYYMMDD(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function dateFromYYYYMMDD(dateStr) {
    const [y, m, d] = String(dateStr || "").split("-").map((x) => Number.parseInt(x, 10));
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    return new Date(y, m - 1, d);
  }

  function piketJadwalKey(dateStr) {
    const d = dateFromYYYYMMDD(dateStr);
    if (!d) return "";
    return `piket_day_${d.getDay()}`;
  }

  function getPiketIdsForDate(jadwal, dateStr) {
    const key = piketJadwalKey(dateStr);
    if (Array.isArray(jadwal?.[key])) return jadwal[key];
    return Array.isArray(jadwal?.[dateStr]) ? jadwal[dateStr] : [];
  }

  function jadwalKey(dateStr, type) {
    const d = String(dateStr || "");
    const t = String(type || "");
    if (!d) return d;
    return t === "acara" ? `${d}__acara` : piketJadwalKey(d);
  }

  function unixSecNow() { return Math.floor(Date.now() / 1000); }

  function windowTimeNow() { return Math.floor(unixSecNow() / 300); }

  function windowEndSecNow() {
    const now = unixSecNow();
    return (Math.floor(now / 300) + 1) * 300;
  }

  function secondsUntilNextWindow() {
    const now = unixSecNow();
    return Math.max(0, (Math.floor(now / 300) + 1) * 300 - now);
  }

  function toNumberOrNull(v) {
    if (v === null || v === undefined) return null; // FIXED: jangan anggap null/undefined sebagai 0
    const s = typeof v === "string" ? v.trim() : v; // FIXED: trim input string
    if (s === "") return null; // FIXED: string kosong = null
    const normalized = typeof s === "string" ? s.replace(",", ".") : s; // FIXED: dukung koma desimal
    const n = Number(normalized); // FIXED: parse setelah normalisasi
    return Number.isFinite(n) ? n : null;
  }

  function normalizeAttendanceRadius(radius) {
    const n = Number(radius);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_ATTENDANCE_RADIUS_METER;
  }

  function getIndoorGpsTolerance(accuracy) {
    const acc = Number(accuracy);
    if (!Number.isFinite(acc)) return 0;
    if (acc > 50) return 40;
    if (acc > 20) return 20;
    return 0;
  }

  function timeToMinutes(hhmm) {
    const [hh, mm] = String(hhmm).split(":");
    return Number.parseInt(hh || "0", 10) * 60 + Number.parseInt(mm || "0", 10);
  }

  function isLate(waktuHHMMSS, jamBatasHHMM) {
    return timeToMinutes(String(waktuHHMMSS).slice(0, 5)) > timeToMinutes(jamBatasHHMM);
  }

  function isWithinPiketHours(waktuHHMMSS) {
    const m = timeToMinutes(String(waktuHHMMSS).slice(0, 5));
    return m >= timeToMinutes("07:00") && m <= timeToMinutes("18:00");
  }

  // ===== Device ID (1 perangkat = 1 absen) =====

  function randomIdFallback() {
    // 128-bit-ish random, URL-safe
    const bytes = new Uint8Array(16);
    try { crypto.getRandomValues(bytes); } catch { /* ignore */ }
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
  }

  function getOrCreateDeviceId() {
    try {
      const key = "sekre_device_id";
      const existing = window.localStorage.getItem(key);
      if (existing && existing.length >= 12) return existing;
      const id = (crypto?.randomUUID ? crypto.randomUUID() : randomIdFallback());
      window.localStorage.setItem(key, id);
      return id;
    } catch {
      // localStorage mungkin diblokir; fallback session-only
      return (crypto?.randomUUID ? crypto.randomUUID() : randomIdFallback());
    }
  }

  // ===== Token =====

  function normalizeTokenBase64(token) {
    // FIXED: beberapa scanner/in-app browser bisa mengubah + menjadi spasi,
    // atau mengubah token menjadi base64url (- dan _) tanpa padding.
    let t = String(token ?? "").trim();
    if (!t) return "";
    t = t.replace(/\s+/g, "+"); // FIXED: spasi/newline → '+'
    t = t.replace(/-/g, "+").replace(/_/g, "/"); // FIXED: base64url → base64
    const mod = t.length % 4;
    if (mod) t += "=".repeat(4 - mod); // FIXED: tambah padding
    return t;
  }

  function decodeToken(token) {
    try {
      const raw = atob(normalizeTokenBase64(token)); // FIXED
      const parts = raw.split(":");
      if (parts.length < 4) return null;
      const [type, dateStr, wtStr] = parts;
      const third = Number.parseInt(wtStr, 10);
      if (!type || !dateStr || !Number.isFinite(third)) return null;
      const isIat = third >= 1_000_000_000;
      let ttlSec = 300;
      let secret = null;
      let nonce = null;

      if (isIat) {
        // Format baru: type:date:iatSec:ttlSec:secret:nonce
        // Format lama: type:date:iatSec:secret:nonce
        const maybeTtl = Number.parseInt(parts[3] ?? "", 10);
        const ttlLooksValid = Number.isFinite(maybeTtl) && maybeTtl >= 60 && maybeTtl <= 86400;
        if (ttlLooksValid) {
          ttlSec = maybeTtl;
          secret = parts[4] || null;
          nonce = parts.slice(5).join(":") || null;
        } else {
          ttlSec = 300;
          secret = parts[3] || null;
          nonce = parts.slice(4).join(":") || null;
        }
      } else {
        // windowTime (legacy): type:date:windowTime:secret:nonce
        ttlSec = 300;
        secret = parts[3] || null;
        nonce = parts.slice(4).join(":") || null;
      }

      if (!secret) return null;
      return {
        type,
        date: dateStr,
        windowTime: isIat ? null : third,
        iatSec: isIat ? third : null,
        ttlSec,
        secret,
        nonce,
      };
    } catch {
      return null;
    }
  }

  async function validateTokenFromUrl() {
    const params = new URLSearchParams(window.location.search);
    let token = params.get("t") || params.get("token"); // FIXED: pakai let agar bisa fallback dari hash

    // FIXED: beberapa scanner/WA kadang memindahkan query ke fragment (#...)
    if (!token && window.location.hash) { // FIXED
      const rawHash = String(window.location.hash || "").replace(/^#/, ""); // FIXED
      const hashQuery = rawHash.includes("?") ? rawHash.split("?").slice(1).join("?") : rawHash; // FIXED
      const hParams = new URLSearchParams(hashQuery.replace(/^\?/, "")); // FIXED
      token = hParams.get("t") || hParams.get("token") || token; // FIXED
    }

    state.token = token;
    // Koordinat sekretariat HARUS selalu dari Supabase settings agar tidak terkunci di QR lama.
    // (QR lama mungkin masih membawa a/o/r, tapi kita abaikan.)
    state.sekre.lat = null;
    state.sekre.lng = null;
    state.sekre.radius = DEFAULT_ATTENDANCE_RADIUS_METER;

    if (!token) return { valid: false, missingToken: true, error: "Tautan tidak memiliki token. Minta admin untuk generate QR ulang." };

    let decoded = decodeToken(token);
    if (!decoded) return { valid: false, error: "Token tidak bisa dibaca. Scan ulang QR yang terbaru." };

    state.type = decoded.type || "bebas";

    // FIXED: QR harus untuk tanggal hari ini (lokal). Kalau tidak, user akan absen ke tanggal lama.
    const today = formatDateYYYYMMDD(new Date());
    if (decoded.date && decoded.date !== today) {
      return {
        valid: false,
        error: `QR ini untuk tanggal ${decoded.date}, bukan hari ini (${today}). Minta admin untuk generate QR HARI INI.`,
      };
    }

    const nowSec = unixSecNow();
    let expiresAtSec = null;
    const todayType = state.type;

    function computeExpiry(d) {
      if (!d) return { ok: false };
      if (Number.isFinite(d.iatSec)) {
        const ttl = Math.max(60, Math.min(86400, Number(d.ttlSec) || 300));
        return { ok: true, expiresAtSec: d.iatSec + ttl, issuedAtSec: d.iatSec, ttlSec: ttl, legacyWindow: false };
      }
      const wtNow = windowTimeNow();
      if (d.windowTime !== wtNow) {
        return { ok: false, expired: true, legacyWindow: true };
      }
      return { ok: true, expiresAtSec: windowEndSecNow(), issuedAtSec: null, ttlSec: null, legacyWindow: true };
    }

    const initialExp = computeExpiry(decoded);
    expiresAtSec = initialExp.expiresAtSec ?? null;
    state.issuedAtSec = initialExp.issuedAtSec ?? null;
    state.ttlSec = initialExp.ttlSec ?? null;

    // Auto-update: jika admin sudah generate QR baru, pakai token aktif terbaru dari server.
    let updated = false;
    if (window.DB && typeof DB.getSettings === "function") {
      try {
        const s = await DB.getSettings();
        const activeToken = s?.active_qr?.[todayType]?.token;
        const activeDate = s?.active_qr?.[todayType]?.date;
        if (activeToken && activeDate === today) {
          // Pakai QR aktif jika token yang discan beda, atau token yang discan sudah expired.
          const activeDecoded = decodeToken(activeToken);
          const activeExp = computeExpiry(activeDecoded);
          const activeOk = !!(activeDecoded && activeExp.ok && Number.isFinite(activeExp.expiresAtSec) && nowSec < activeExp.expiresAtSec);
          const scannedOk = !!(initialExp.ok && Number.isFinite(expiresAtSec) && nowSec < expiresAtSec);

          if (activeOk && (String(token) !== String(activeToken) || !scannedOk)) {
            token = activeToken;
            decoded = activeDecoded;
            const newExp = computeExpiry(decoded);
            expiresAtSec = newExp.expiresAtSec;
            state.issuedAtSec = newExp.issuedAtSec;
            state.ttlSec = newExp.ttlSec;
            state.token = token;
            state.type = decoded.type || todayType;
            updated = true;
          }
        }
      } catch {
        // Jika gagal load settings, tetap pakai token yang discan (fallback).
      }
    }

    if (!Number.isFinite(expiresAtSec) || nowSec >= expiresAtSec) {
      return {
        valid: false,
        expired: true,
        nextInSec: secondsUntilNextWindow(),
        error: "QR sudah kedaluwarsa. Minta QR terbaru dari admin.",
      };
    }

    // FIXED: koordinat selalu dari Supabase settings (single source of truth)

    state.date = decoded.date;
    state.expiresAtSec = expiresAtSec;

    return { valid: true, type: decoded.type, date: decoded.date, updated };
  }

  function isLateByQrHalf() {
    if (!Number.isFinite(state.issuedAtSec) || !Number.isFinite(state.ttlSec)) return null;
    const elapsed = unixSecNow() - state.issuedAtSec;
    const half = state.ttlSec / 2;
    // Setengah awal: tidak terlambat. Setengah akhir: terlambat.
    return elapsed >= half;
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
    return `${head} ${msg}${details}`.trim();
  }

  // ===== GPS =====

  function haversineMeter(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function getGpsPosition(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("GPS tidak tersedia di perangkat ini."));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 0,
      });
    });
  }

  function getBestGpsPosition(timeoutMs = 20000, desiredAccuracy = 100) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("GPS tidak tersedia di perangkat ini."));
        return;
      }

      let bestPos = null;
      let bestAcc = Number.POSITIVE_INFINITY;
      let done = false;

      const finish = (pos, err) => {
        if (done) return;
        done = true;
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        if (pos) resolve(pos);
        else reject(err || new Error("Gagal mendapatkan lokasi."));
      };

      const onPos = (pos) => {
        const acc = Number(pos?.coords?.accuracy);
        if (Number.isFinite(acc) && acc < bestAcc) {
          bestAcc = acc;
          bestPos = pos;
        }
        if (Number.isFinite(acc) && acc <= desiredAccuracy) {
          finish(pos);
        }
      };

      const onErr = (err) => {
        // Kalau belum ada posisi sama sekali, simpan error untuk fallback
        lastErr = err;
      };

      let lastErr = null;
      let watchId = null;

      // Mulai watch supaya akurasi bisa membaik
      watchId = navigator.geolocation.watchPosition(onPos, onErr, {
        enableHighAccuracy: true,
        maximumAge: 0,
      });

      // Fallback: juga request satu kali (kadang lebih cepat di beberapa device)
      navigator.geolocation.getCurrentPosition(onPos, onErr, {
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 0,
      });

      window.setTimeout(() => {
        if (bestPos) finish(bestPos);
        else finish(null, lastErr || Object.assign(new Error("Timeout GPS."), { code: 3 }));
      }, timeoutMs);
    });
  }

  async function cekLokasi() {
    try {
      if (!window.isSecureContext && location.hostname !== "localhost") {
        return { ok: false, error: "Lokasi hanya bisa diakses lewat HTTPS. Pastikan situs menggunakan HTTPS." };
      }

      if (!Number.isFinite(state.sekre.lat) || !Number.isFinite(state.sekre.lng)) {
        return { ok: false, error: "Koordinat sekretariat belum valid. Minta admin mengatur lokasi di Pengaturan dan generate QR ulang." }; // FIXED: validasi koordinat sebelum hitung jarak
      }

      $("gps-status").textContent = "Meminta akses lokasi GPS...";
      state.sekre.radius = normalizeAttendanceRadius(state.sekre.radius);
      const desiredAccuracy = Math.max(150, state.sekre.radius);
      $("gps-status").textContent = "Mengunci lokasi (tunggu beberapa detik untuk akurasi terbaik)...";
      const pos = await getBestGpsPosition(20000, desiredAccuracy);
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = pos.coords.accuracy;

      state.gps.lat = lat;
      state.gps.lng = lng;
      state.gps.accuracy = accuracy;

      const dist = haversineMeter(lat, lng, state.sekre.lat, state.sekre.lng);
      const tolerance = getIndoorGpsTolerance(accuracy);
      const effectiveRadius = state.sekre.radius + tolerance;
      state.gps.distance = dist;
      state.gps.tolerance = tolerance;
      state.gps.effectiveRadius = effectiveRadius;

      $("gps-info").style.display = "block";
      $("gps-distance").textContent = `${Math.round(dist)} m`;
      $("gps-radius").textContent = tolerance > 0
        ? `${Math.round(effectiveRadius)} m efektif (${Math.round(state.sekre.radius)} + toleransi ${Math.round(tolerance)} m)`
        : `${Math.round(effectiveRadius)} m efektif`;
      $("gps-accuracy").textContent = `${Math.round(accuracy)} m`;

      if (dist > effectiveRadius) {
        return {
          ok: false,
          error: `Kamu berada ${Math.round(dist)} meter dari sekretariat (radius efektif: ${Math.round(effectiveRadius)} m, akurasi GPS ${Math.round(accuracy)} m). Absensi hanya bisa di dalam radius.`,
        };
      }

      return { ok: true };
    } catch (err) {
      const code = err?.code;
      let msg;
      if (code === 1) msg = "Izin lokasi ditolak. Aktifkan izin lokasi untuk browser ini di pengaturan HP, lalu scan ulang.";
      else if (code === 2) msg = "Posisi tidak bisa ditentukan. Pastikan GPS aktif dan coba di tempat terbuka.";
      else if (code === 3) msg = "Timeout GPS (20 detik). Pastikan GPS aktif dan sinyal baik, lalu scan ulang.";
      else msg = `GPS error: ${err?.message || "tidak diketahui"}`;
      return { ok: false, gpsDenied: code === 1, error: msg };
    }
  }

  // ===== Data anggota (dari Supabase) =====

  async function loadAnggota() {
    if (!window.DB) return FALLBACK_MEMBERS;
    try {
      const arr = await DB.getAnggota();
      if (Array.isArray(arr) && arr.length) return arr;
      return FALLBACK_MEMBERS;
    } catch {
      return FALLBACK_MEMBERS;
    }
  }

  async function loadSettings() {
    if (!window.DB) return null;
    try {
      return await DB.getSettings();
    } catch {
      return null;
    }
  }

  // ===== UI Stepper =====

  function setStep(active) {
    [$("step-1"), $("step-2"), $("step-3"), $("step-4")].forEach((el, idx) => {
      if (el) el.classList.toggle("step--active", idx + 1 === active);
    });
  }

  function setHead(title, desc) {
    $("step-title").textContent = title;
    $("step-desc").textContent = desc;
  }

  function setResult(kind, title, sub, note, meta) {
    setStep(4);
    setHead("Selesai", sub);
    const panel = $("result-panel");
    panel.style.borderColor = kind === "success" ? "rgba(22,163,74,.35)" :
                               kind === "warning" ? "rgba(217,119,6,.35)" : "rgba(220,38,38,.35)";
    panel.style.background = kind === "success" ? "rgba(220,252,231,.45)" :
                               kind === "warning" ? "rgba(254,243,199,.6)" : "rgba(254,226,226,.55)";
    $("result-title").textContent = title;
    $("result-sub").textContent = sub;
    $("result-note").textContent = note;
    $("result-name").textContent = meta?.nama || "-";
    $("result-type").textContent = meta?.tipe || "-";
    $("result-time").textContent = meta?.waktu || "-";
  }

  // ===== Countdown QR =====

  function startQrCountdown() {
    if (state.countdownTimer) window.clearInterval(state.countdownTimer);
    const update = () => {
      const sec = state.expiresAtSec ? Math.max(0, state.expiresAtSec - unixSecNow()) : secondsUntilNextWindow();
      state.remainingSec = sec;
      $("qr-countdown").textContent = formatRemaining(sec);
      if (sec === 0) showTokenExpiredUI();
    };
    update();
    state.countdownTimer = window.setInterval(update, 1000);
  }

  function showTokenExpiredUI() {
    const btn = $("btn-absen");
    if (btn) btn.disabled = true;
    $("token-error").style.display = "block";
    $("token-error-title").textContent = "QR sudah kedaluwarsa";
    $("token-error-msg").textContent = "Minta QR terbaru dari admin.";
    $("token-countdown").style.display = "block";
    const sec = state.expiresAtSec ? 0 : secondsUntilNextWindow();
    $("countdown-token").textContent = formatRemaining(sec);
  }

  // ===== Fill member dropdown =====

  function fillMembers(anggota, opts = {}) {
    const allowManual = opts.allowManual !== false;
    const placeholder = opts.placeholder || "Pilih nama";
    const hintText = opts.hintText || "Jika namamu tidak ada, pilih \"Lainnya\" lalu isi nama manual.";

    state.anggota = Array.isArray(anggota) ? anggota : [];
    const select = $("select-anggota");
    const rowManual = $("row-nama-manual");
    const inputManual = $("input-nama");
    const hintEl = select?.parentElement?.querySelector(".hint") || null;

    if (hintEl) {
      hintEl.textContent = hintText;
      hintEl.style.display = hintText ? "block" : "none";
    }

    if (rowManual) rowManual.style.display = "none";
    if (inputManual) inputManual.required = false;

    select.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = placeholder;
    select.appendChild(opt0);

    state.anggota.forEach((a) => {
      const opt = document.createElement("option");
      opt.value = String(a.id);
      opt.textContent = a.nama;
      select.appendChild(opt);
    });

    if (allowManual) {
      const optOther = document.createElement("option");
      optOther.value = "other";
      optOther.textContent = "Lainnya";
      select.appendChild(optOther);
    }

    select.onchange = () => {
      const show = allowManual && select.value === "other";
      if (rowManual) rowManual.style.display = show ? "block" : "none";
      if (inputManual) inputManual.required = show;
    };

    // Jika tidak ada pilihan selain placeholder, matikan submit agar tidak membingungkan.
    const btn = $("btn-absen");
    const hasRealOptions = state.anggota.length > 0;
    select.disabled = !hasRealOptions;
    if (btn) btn.disabled = !hasRealOptions;
  }

  function setTypeFromUrl() {
    $("chip-type").textContent = state.type.toUpperCase();
    const radios = document.querySelectorAll('input[name="tipe"]');
    radios.forEach((r) => { r.checked = r.value === state.type; r.disabled = true; });
  }

  // ===== Form submit =====

  function getSelectedName() {
    const select = $("select-anggota");
    if (select.value === "other") return $("input-nama").value.trim();
    const id = Number.parseInt(select.value, 10);
    const found = state.anggota.find((a) => a.id === id);
    return found ? found.nama : "";
  }

  function getSelectedMember() {
    const select = $("select-anggota");
    if (select.value === "other") return null;
    const id = Number.parseInt(select.value, 10);
    return state.anggota.find((a) => a.id === id) || null;
  }

  // BroadcastChannel (untuk 1 perangkat / browser yang sama)
  function initChannel() {
    try {
      state.channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      state.channel = null;
    }
  }

  function broadcastAttendance(payload) {
    if (!state.channel) return;
    state.channel.postMessage({ type: "absen", payload });
  }

  async function onSubmitAbsen(e) {
    e.preventDefault();

    const nama = getSelectedName();
    if (!nama) { showToast("Nama belum dipilih.", "error"); return; }

    // Revalidasi token
    const tv = await validateTokenFromUrl();
    if (!tv.valid) {
      setStep(1);
      $("token-error").style.display = "block";
      $("token-error-title").textContent = tv.expired ? "QR sudah kedaluwarsa" : "QR tidak valid";
      $("token-error-msg").textContent = tv.error;
      if (tv.expired) {
        $("token-countdown").style.display = "block";
        $("countdown-token").textContent = `${pad2(Math.floor((tv.nextInSec || 0) / 60))}:${pad2((tv.nextInSec || 0) % 60)}`;
      }
      showToast(tv.error, "error");
      return;
    }

    const member = getSelectedMember();
    const tipe = state.type;
    const tanggal = state.date;

    // Validasi jadwal: piket harus sesuai jadwal, acara harus sesuai daftar peserta.
    if (window.DB && (tipe === "piket" || tipe === "acara")) {
      if (!member || member?.id == null) {
        setResult(
          "warning",
          "Nama tidak valid",
          "Untuk tipe ini, nama harus dipilih dari daftar.",
          "Silakan pilih nama (bukan manual).",
          { tipe },
        );
        return;
      }

      const jadwal = await DB.getJadwal();
      const key = jadwalKey(tanggal, tipe);
      const rawIds = tipe === "piket" ? getPiketIdsForDate(jadwal, tanggal) : jadwal?.[key];
      const ids = Array.isArray(rawIds) ? rawIds.map((x) => Number(x)) : [];
      const allowed = new Set(ids);
      if (!allowed.has(Number(member.id))) {
        const label = tipe === "piket" ? "jadwal piket" : "daftar peserta acara";
        setResult(
          "warning",
          "Tidak terdaftar",
          "Nama ini tidak terdaftar untuk absensi ini.",
          `Nama kamu tidak ada di ${label} untuk tanggal ${tanggal}.`,
          { nama: member?.nama, tipe, tanggal },
        );
        return;
      }
    }

    // Cek duplikat berbasis device (1 device hanya boleh 1x absen per tanggal PER TIPE)
    if (window.DB) {
      const deviceExisting = await DB.isDeviceAlreadyCheckedIn(tanggal, state.deviceId, tipe);
      if (deviceExisting) {
        setResult(
          "warning",
          "Device sudah dipakai",
          `Perangkat ini sudah melakukan absensi ${tipe}.`,
          `Absensi ${tipe} pertama tercatat pada ${deviceExisting.waktu}.`,
          { nama: deviceExisting.nama, tipe: deviceExisting.tipe, waktu: deviceExisting.waktu },
        );
        return;
      }
    }

    // Cek duplikat di Supabase (per tanggal PER TIPE)
    if (window.DB) {
      const existing = await DB.isAlreadyCheckedIn(tanggal, member?.id ?? null, nama, tipe);
      if (existing) {
        setResult("warning", "Sudah absen", "Absensi sudah tercatat.", `Kamu sudah absen pada ${existing.waktu}.`,
          { nama: existing.nama, tipe: existing.tipe, waktu: existing.waktu });
        return;
      }
    }

    const now = new Date();
    const waktu = formatTimeHHMMSS(now);

    // Jam piket fleksibel tapi dibatasi rentang (07:00–18:00)
    if (tipe === "piket" && !isWithinPiketHours(waktu)) {
      setResult(
        "warning",
        "Di luar jam piket",
        "Absensi piket hanya dibuka jam 07:00–18:00.",
        `Sekarang ${waktu}. Silakan absen di jam piket.`,
        { tipe, tanggal, waktu },
      );
      return;
    }
    // PIKET: tidak ada konsep "terlambat" (selalu '-').
    // Bebas/Acara: tetap pakai aturan terlambat dari durasi QR (atau fallback jam batas).
    let terlambat = null;
    if (tipe !== "piket") {
      const lateByHalf = isLateByQrHalf();
      if (lateByHalf === null) {
        // Fallback: kalau token model lama (windowTime) atau tidak ada ttl, pakai jam batas settings.
        const settings = await loadSettings();
        const jamBatas = settings?.jam_batas_terlambat || "08:00";
        terlambat = isLate(waktu, jamBatas);
      } else {
        terlambat = lateByHalf;
      }
    }

    const entry = {
      id_anggota: member?.id ?? null,
      nama,
      nim: member?.nim ?? "-",
      divisi: member?.divisi ?? "-",
      tipe,
      waktu,
      timestamp: Date.now(),
      device_id: state.deviceId,
      status: "hadir",
      terlambat,
      lat_absen: state.gps.lat,
      lng_absen: state.gps.lng,
      jarak_meter: Math.round(state.gps.distance ?? 0),
    };

    // Kirim ke Supabase
    const btn = $("btn-absen");
    if (btn) { btn.disabled = true; btn.textContent = "Menyimpan..."; }

    let saved = false;
    if (window.DB) {
      saved = await DB.insertLog(tanggal, entry);
    }

    if (btn) {
      btn.disabled = false;
      btn.textContent = "ABSEN SEKARANG";
    }

    // Broadcast untuk admin di browser yang sama
    broadcastAttendance({ date: tanggal, entry });

    if (saved) {
      setResult("success", "Berhasil", "Absensi berhasil tersimpan.",
        tipe === "piket" ? "Status: hadir." : (terlambat ? "Status: terlambat." : "Status: tepat waktu."),
        { nama: entry.nama, tipe: entry.tipe, waktu: entry.waktu });
      showToast("Absensi tersimpan.");
    } else {
      setResult("warning", "Peringatan", "Absensi mungkin gagal tersimpan ke server.",
        "Hubungi admin untuk konfirmasi.",
        { nama: entry.nama, tipe: entry.tipe, waktu: entry.waktu });
      showToast("Gagal menyimpan ke server. Hubungi admin.", "error");
    }
  }

  // ===== Clock =====

  function updateClock() {
    const now = new Date();
    const timeEl = $("now-time");
    const dateEl = $("now-date");
    if (timeEl) timeEl.textContent = formatTimeHHMMSS(now);
    if (dateEl) dateEl.textContent = formatDateIndo(now);
  }

  // ===== Main =====

  async function run() {
    updateClock();
    window.setInterval(updateClock, 1000);
    initChannel();

    state.deviceId = getOrCreateDeviceId();

    // STEP 1: Validasi token
    setStep(1);
    setHead("Validasi", "Memeriksa QR...");

    const tv = await validateTokenFromUrl();
    $("absen-date").textContent = tv.date || state.date || "-";

    if (!tv.valid) {
      const tokenActions = $("token-actions");
      if (tokenActions) tokenActions.style.display = tv.missingToken ? "grid" : "none";
      $("token-error").style.display = "block";
      $("token-error-title").textContent = tv.expired ? "QR sudah kedaluwarsa" : "QR tidak valid";
      $("token-error-msg").textContent = tv.error;
      if (tv.expired) {
        $("token-countdown").style.display = "block";
        const sec = tv.nextInSec || secondsUntilNextWindow();
        $("countdown-token").textContent = `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
      }
      setHead("Gagal", tv.error);
      showToast(tv.error, "error");
      return;
    }

    if (tv.updated && !state.qrUpdatedNotified) {
      state.qrUpdatedNotified = true;
      showToast("QR sudah diperbarui. Memakai QR terbaru.");
    }

    setTypeFromUrl();
    startQrCountdown();

    // Load anggota dari Supabase (parallel dengan settings)
    const tipe = state.type;
    const tanggal = state.date;
    const needFilter = !!(window.DB && (tipe === "piket" || tipe === "acara"));
    const [anggota, settings, jadwal] = await Promise.all([
      loadAnggota(),
      loadSettings(),
      needFilter ? DB.getJadwal() : Promise.resolve(null),
    ]);

    let anggotaShown = anggota;
    if (needFilter) {
      const key = jadwalKey(tanggal, tipe);
      const rawIds = tipe === "piket" ? getPiketIdsForDate(jadwal, tanggal) : jadwal?.[key];
      const ids = Array.isArray(rawIds) ? rawIds.map((x) => Number(x)) : [];
      const allowed = new Set(ids.filter((x) => Number.isFinite(x)));
      anggotaShown = (anggota || []).filter((a) => allowed.has(Number(a.id)));
      fillMembers(anggotaShown, {
        allowManual: false,
        placeholder: tipe === "piket" ? "Pilih nama (yang dijadwalkan piket)" : "Pilih nama (peserta acara)",
        hintText: tipe === "piket"
          ? "Hanya nama yang dijadwalkan piket yang bisa dipilih."
          : "Hanya nama yang terdaftar sebagai peserta acara yang bisa dipilih.",
      });

      if (!anggotaShown.length) {
        showToast(
          tipe === "piket"
            ? "Belum ada jadwal piket untuk hari ini. Hubungi admin."
            : "Belum ada peserta acara untuk hari ini. Hubungi admin.",
          "error",
        );
      }
    } else {
      fillMembers(anggotaShown, { allowManual: true });
    }

    if (settings?.nama_org) {
      const orgEl = $("org-name");
      if (orgEl) orgEl.textContent = settings.nama_org;
    }

    // FIXED: Koordinat sekretariat sebaiknya menjadi "single source of truth" dari Supabase settings.
    // Ini mencegah QR lama (yang dulu membawa a/o/r) mengunci lokasi lama.
    if (settings && typeof settings === "object") {
      const lat2 = toNumberOrNull(settings.sekre_lat);
      const lng2 = toNumberOrNull(settings.sekre_lng);
      const r2 = toNumberOrNull(settings.radius_meter);
      if (lat2 !== null && lng2 !== null) {
        state.sekre.lat = lat2;
        state.sekre.lng = lng2;
      }
      if (r2 !== null) state.sekre.radius = normalizeAttendanceRadius(r2);
    } else {
      const errText = formatLastSupabaseError();
      const msg = `Gagal memuat pengaturan lokasi dari server. Pastikan internet aktif dan coba scan ulang QR.\n${errText}`.trim();
      $("gps-error").style.display = "block";
      $("gps-error-title").textContent = "Pengaturan tidak terbaca";
      $("gps-error-msg").textContent = msg;
      setHead("Lokasi gagal", msg);
      showToast("Gagal memuat pengaturan dari server.", "error");
      return;
    }

    if (state.sekre.lat === null || state.sekre.lng === null) {
      const msg = "Koordinat sekretariat belum diatur (atau tidak terbaca). Admin: pastikan lat/lng sudah disimpan di Pengaturan, lalu scan ulang QR."; // FIXED
      $("gps-error").style.display = "block"; // FIXED
      $("gps-error-title").textContent = "Koordinat sekretariat tidak valid"; // FIXED
      $("gps-error-msg").textContent = msg; // FIXED
      setHead("Lokasi gagal", msg); // FIXED
      showToast(msg, "error"); // FIXED
      return; // FIXED
    }

    // STEP 2: GPS
    setStep(2);
    setHead("Lokasi", "Memeriksa lokasi kamu...");

    const gps = await cekLokasi();
    if (!gps.ok) {
      $("gps-error").style.display = "block";
      $("gps-error-title").textContent = "Lokasi tidak valid";
      $("gps-error-msg").textContent = gps.error;
      setHead("Lokasi gagal", gps.error);
      showToast(gps.error, "error");
      return;
    }

    // STEP 3: Form
    setStep(3);
    setHead("Form", "Isi dan klik absen.");

    $("form-absen").addEventListener("submit", onSubmitAbsen);
  }

  document.addEventListener("DOMContentLoaded", run);
})();
