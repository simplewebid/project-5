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

  const FALLBACK_MEMBERS = Array.from({ length: 100 }, (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    return { id: i + 1, nama: `Anggota ${n}`, nim: "-", divisi: "-" };
  });

  const state = {
    token: null,
    type: "bebas",
    date: null,
    expiresAtSec: null,
    sekre: { lat: null, lng: null, radius: 100 },
    gps: { lat: null, lng: null, accuracy: null, distance: null },
    remainingSec: 0,
    countdownTimer: null,
    channel: null,
    anggota: [],
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

  function timeToMinutes(hhmm) {
    const [hh, mm] = String(hhmm).split(":");
    return Number.parseInt(hh || "0", 10) * 60 + Number.parseInt(mm || "0", 10);
  }

  function isLate(waktuHHMMSS, jamBatasHHMM) {
    return timeToMinutes(String(waktuHHMMSS).slice(0, 5)) > timeToMinutes(jamBatasHHMM);
  }

  // ===== Token =====

  function decodeToken(token) {
    try {
      const raw = atob(token);
      const parts = raw.split(":");
      if (parts.length < 4) return null;
      const [type, dateStr, wtStr, secret] = parts;
      const third = Number.parseInt(wtStr, 10);
      if (!type || !dateStr || !Number.isFinite(third) || !secret) return null;
      const isIat = third >= 1_000_000_000;
      return {
        type,
        date: dateStr,
        windowTime: isIat ? null : third,
        iatSec: isIat ? third : null,
        secret,
        nonce: parts.slice(4).join(":") || null,
      };
    } catch {
      return null;
    }
  }

  async function validateTokenFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("t") || params.get("token");
    const lat = params.get("a") || params.get("lat");
    const lng = params.get("o") || params.get("lng");
    const r = params.get("r");

    state.token = token;
    state.sekre.lat = toNumberOrNull(lat);
    state.sekre.lng = toNumberOrNull(lng);
    state.sekre.radius = toNumberOrNull(r) ?? 100;

    if (!token) return { valid: false, missingToken: true, error: "Tautan tidak memiliki token. Minta admin untuk generate QR ulang." };

    const decoded = decodeToken(token);
    if (!decoded) return { valid: false, error: "Token tidak bisa dibaca. Scan ulang QR yang terbaru." };

    state.type = decoded.type || "bebas";

    const nowSec = unixSecNow();
    let expiresAtSec = null;

    if (Number.isFinite(decoded.iatSec)) {
      expiresAtSec = decoded.iatSec + 300;
    } else {
      const wtNow = windowTimeNow();
      if (decoded.windowTime !== wtNow) {
        return {
          valid: false,
          expired: true,
          nextInSec: secondsUntilNextWindow(),
          error: "QR sudah kedaluwarsa. Minta QR terbaru dari admin.",
        };
      }
      expiresAtSec = windowEndSecNow();
    }

    if (!Number.isFinite(expiresAtSec) || nowSec >= expiresAtSec) {
      return {
        valid: false,
        expired: true,
        nextInSec: secondsUntilNextWindow(),
        error: "QR sudah kedaluwarsa. Minta QR terbaru dari admin.",
      };
    }

    // FIXED: koordinat bisa berasal dari QR *atau* fallback dari Supabase settings
    // (tidak langsung dianggap invalid di tahap token)

    state.date = decoded.date;
    state.expiresAtSec = expiresAtSec;

    return { valid: true, type: decoded.type, date: decoded.date };
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

  async function cekLokasi() {
    try {
      if (!window.isSecureContext && location.hostname !== "localhost") {
        return { ok: false, error: "Lokasi hanya bisa diakses lewat HTTPS. Pastikan situs menggunakan HTTPS." };
      }

      if (!Number.isFinite(state.sekre.lat) || !Number.isFinite(state.sekre.lng)) {
        return { ok: false, error: "Koordinat sekretariat belum valid. Minta admin mengatur lokasi di Pengaturan dan generate QR ulang." }; // FIXED: validasi koordinat sebelum hitung jarak
      }

      $("gps-status").textContent = "Meminta akses lokasi GPS...";
      const pos = await getGpsPosition(20000);
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = pos.coords.accuracy;

      state.gps.lat = lat;
      state.gps.lng = lng;
      state.gps.accuracy = accuracy;

      const dist = haversineMeter(lat, lng, state.sekre.lat, state.sekre.lng);
      state.gps.distance = dist;

      $("gps-info").style.display = "block";
      $("gps-distance").textContent = `${Math.round(dist)} m`;
      $("gps-radius").textContent = `${Math.round(state.sekre.radius)} m`;
      $("gps-accuracy").textContent = `${Math.round(accuracy)} m`;

      if (Number.isFinite(accuracy) && accuracy > Math.max(150, state.sekre.radius)) {
        return {
          ok: false,
          error: `Akurasi GPS terlalu rendah (${Math.round(accuracy)} m). Nyalakan mode akurasi tinggi di pengaturan HP, lalu coba lagi.`,
        };
      }

      if (dist > state.sekre.radius) {
        return {
          ok: false,
          error: `Kamu berada ${Math.round(dist)} meter dari sekretariat (radius: ${Math.round(state.sekre.radius)} m). Absensi hanya bisa di dalam radius.`,
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
      $("qr-countdown").textContent = `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
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
    const sec = secondsUntilNextWindow();
    $("countdown-token").textContent = `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
  }

  // ===== Fill member dropdown =====

  function fillMembers(anggota) {
    state.anggota = anggota;
    const select = $("select-anggota");
    select.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = ""; opt0.textContent = "Pilih nama";
    select.appendChild(opt0);

    anggota.forEach((a) => {
      const opt = document.createElement("option");
      opt.value = String(a.id);
      opt.textContent = a.nama;
      select.appendChild(opt);
    });

    const optOther = document.createElement("option");
    optOther.value = "other"; optOther.textContent = "Lainnya";
    select.appendChild(optOther);

    select.addEventListener("change", () => {
      const show = select.value === "other";
      $("row-nama-manual").style.display = show ? "block" : "none";
      $("input-nama").required = show;
    });
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

    // Cek duplikat di Supabase
    if (window.DB) {
      const existing = await DB.isAlreadyCheckedIn(tanggal, member?.id ?? null, nama);
      if (existing) {
        setResult("warning", "Sudah absen", "Absensi sudah tercatat.", `Kamu sudah absen pada ${existing.waktu}.`,
          { nama: existing.nama, tipe: existing.tipe, waktu: existing.waktu });
        return;
      }
    }

    const settings = await loadSettings();
    const jamBatas = settings?.jam_batas_terlambat || "08:00";

    const now = new Date();
    const waktu = formatTimeHHMMSS(now);
    const terlambat = isLate(waktu, jamBatas);

    const entry = {
      id_anggota: member?.id ?? null,
      nama,
      nim: member?.nim ?? "-",
      divisi: member?.divisi ?? "-",
      tipe,
      waktu,
      timestamp: Date.now(),
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
        terlambat ? "Status: terlambat." : "Status: tepat waktu.",
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

    setTypeFromUrl();
    startQrCountdown();

    // Load anggota dari Supabase (parallel dengan GPS agar lebih cepat)
    const [anggota, settings] = await Promise.all([loadAnggota(), loadSettings()]);
    fillMembers(anggota);
    if (settings?.nama_org) {
      const orgEl = $("org-name");
      if (orgEl) orgEl.textContent = settings.nama_org;
    }

    // FIXED: fallback koordinat sekretariat dari Supabase jika QR tidak membawa koordinat
    if ((state.sekre.lat === null || state.sekre.lng === null) && settings && typeof settings === "object") {
      const lat2 = toNumberOrNull(settings.sekre_lat); // FIXED
      const lng2 = toNumberOrNull(settings.sekre_lng); // FIXED
      const r2 = toNumberOrNull(settings.radius_meter); // FIXED
      if (lat2 !== null) state.sekre.lat = lat2; // FIXED
      if (lng2 !== null) state.sekre.lng = lng2; // FIXED
      if (r2 !== null) state.sekre.radius = r2; // FIXED
    }

    if (state.sekre.lat === null || state.sekre.lng === null) {
      const msg = "Koordinat sekretariat belum diatur (atau tidak terbaca). Admin: isi lat/lng di Pengaturan dengan format titik, lalu generate QR ulang."; // FIXED
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