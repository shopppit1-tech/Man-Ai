const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

function loadDotEnv() {
  const envFile = path.join(__dirname, ".env");
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    process.env[match[1]] = value;
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL = process.env.GEMINI_MODEL || "gemini-4-hydrogen";
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 12;
const DAILY_GLOBAL_LIMIT = Math.max(1, Number(process.env.GEMINI_DAILY_LIMIT || 200));
const requestCounts = new Map();
let dailyCount = 0;
let dailyCountDate = new Date().toISOString().slice(0, 10);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

function sendJson(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(payload);
}

function sendSupabaseConfig(res) {
  const payload = `window.__SUPABASE_CONFIG__ = ${JSON.stringify({
    url: process.env.SUPABASE_URL || "",
    anonKey: process.env.SUPABASE_ANON_KEY || ""
  })};`;
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(payload);
}

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length < 256) {
    return forwarded.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  }
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(key) {
  const now = Date.now();
  const current = requestCounts.get(key);
  if (!current || now - current.start >= RATE_LIMIT_WINDOW_MS) {
    requestCounts.set(key, { start: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT_MAX;
}

function isDailyLimitReached() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyCountDate) {
    dailyCount = 0;
    dailyCountDate = today;
  }
  if (dailyCount >= DAILY_GLOBAL_LIMIT) return true;
  dailyCount += 1;
  return false;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Isi permintaan terlalu besar."), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(Object.assign(new Error("Format JSON permintaan tidak valid."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

async function handleChat(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Gunakan metode POST untuk mengirim pesan." });
  }

  const apiKeys = [
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    process.env.GEMINI_API_KEY_BACKUP,
    process.env.GEMINI_API_KEY_BACKUP_2
  ]
    .filter((key, index, keys) => Boolean(key) && keys.indexOf(key) === index);
  if (apiKeys.length === 0) {
    return sendJson(res, 503, { error: "Kunci Gemini API belum dikonfigurasi di server." });
  }

  if (isDailyLimitReached()) {
    return sendJson(res, 429, { error: "Batas pesan harian sudah tercapai. Silakan coba lagi besok." });
  }
  const clientKey = getClientKey(req);
  if (isRateLimited(clientKey)) {
    return sendJson(res, 429, { error: "Terlalu banyak pesan. Tunggu satu menit lalu coba lagi." });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message || "Permintaan tidak valid." });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return sendJson(res, 400, { error: "Pesan tidak boleh kosong." });
  if (message.length > 8000) return sendJson(res, 413, { error: "Pesan terlalu panjang (maksimal 8.000 karakter)." });

  const requestBody = {
    model: MODEL,
    system_instruction: "Anda adalah Man-Ai, asisten chat AI yang membantu dan didukung Google Gemini. Jawab selalu dalam Bahasa Indonesia yang jelas, alami, dan akurat, apa pun bahasa pertanyaan pengguna, kecuali pengguna secara khusus meminta teks dalam bahasa lain. Anda dapat menjelaskan, mencari ide, menulis draf, dan membantu membuat rencana. Anda tidak memiliki akses ke alat eksternal, situs web, file, atau platform Manus; jangan pernah mengaku telah menjalankan tugas nyata atau membuat file. Jika diminta membuat sesuatu, berikan konten atau rencana praktis dalam jawaban.",
    generation_config: { max_output_tokens: 1024, thinking_level: "low" },
    input: message
  };
  if (typeof body.previousInteractionId === "string" && body.previousInteractionId.length > 0 && body.previousInteractionId.length <= 256) {
    requestBody.previous_interaction_id = body.previousInteractionId;
  }

  try {
    let upstream;
    let result = {};
    for (let index = 0; index < apiKeys.length; index += 1) {
      upstream = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKeys[index]
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(60_000)
      });
      result = await upstream.json().catch(() => ({}));
      const canTryBackup = index < apiKeys.length - 1 && [401, 403, 429].includes(upstream.status);
      if (upstream.ok || !canTryBackup) break;
      console.warn("Primary Gemini API key unavailable; trying configured backup key.");
    }
    if (!upstream.ok) {
      console.error("Gemini API request failed with status", upstream.status);
      if (upstream.status === 429) return sendJson(res, 429, { error: "Gemini sedang sibuk atau kuotanya tercapai. Silakan coba lagi nanti." });
      if (upstream.status === 401 || upstream.status === 403) return sendJson(res, 502, { error: "Gemini menolak kunci API di server. Periksa kunci dan akses API." });
      return sendJson(res, 502, { error: "Gemini belum dapat memproses permintaan. Silakan coba lagi nanti." });
    }

    const reply = typeof result.output_text === "string"
      ? result.output_text.trim()
      : (Array.isArray(result.steps) ? result.steps
        .filter((step) => step.type === "model_output" && Array.isArray(step.content))
        .flatMap((step) => step.content)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim() : "");
    if (!reply) return sendJson(res, 502, { error: "Gemini tidak mengirim jawaban. Silakan coba lagi." });
    return sendJson(res, 200, {
      reply,
      interactionId: typeof result.id === "string" ? result.id : null
    });
  } catch (error) {
    console.error("Gemini API connection error:", error.name || "Error");
    const message = error.name === "TimeoutError"
      ? "Gemini terlalu lama merespons. Silakan coba lagi."
      : "Tidak dapat terhubung ke Gemini. Silakan coba lagi nanti.";
    return sendJson(res, 502, { error: message });
  }
}

async function handleConnectorTest(req, res, provider) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Gunakan metode POST untuk menguji konektor." });
  }
  if (isRateLimited(`connector:${getClientKey(req)}`)) {
    return sendJson(res, 429, { error: "Terlalu banyak permintaan konektor. Coba lagi sebentar." });
  }
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message || "Permintaan tidak valid." });
  }

  const requestUpstream = async (url, headers = {}) => fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(15_000)
  });

  try {
    if (provider === "github") {
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token || token.length > 512) return sendJson(res, 400, { error: "Token GitHub tidak valid." });
      const response = await requestUpstream("https://api.github.com/user/repos?per_page=20&sort=updated", {
        Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Man-Ai-Connector"
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return sendJson(res, 401, { error: response.status === 403 ? "GitHub menolak token atau batas API tercapai." : "Token GitHub tidak valid atau tidak memiliki akses baca repo." });
      const repos = Array.isArray(data) ? data.slice(0, 20).map((repo) => ({ name: repo.full_name, private: Boolean(repo.private), branch: repo.default_branch })) : [];
      return sendJson(res, 200, { identity: "GitHub terhubung", summary: `${repos.length} repo terakhir: ${repos.map((repo) => repo.name).join(", ") || "tidak ada repo yang terlihat"}`, items: repos });
    }

    if (provider === "render") {
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token || token.length > 512) return sendJson(res, 400, { error: "Render API key tidak valid." });
      const response = await requestUpstream("https://api.render.com/v1/services?limit=20", { Authorization: `Bearer ${token}` });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return sendJson(res, 401, { error: "Render menolak API key atau tidak dapat mengambil daftar service." });
      const rows = Array.isArray(data) ? data : (Array.isArray(data.services) ? data.services : []);
      const services = rows.slice(0, 20).map((entry) => {
        const service = entry.service || entry;
        return { name: service.name || "Service", type: service.type || "service", status: service.suspended === "suspended" ? "suspended" : (service.status || "terdaftar") };
      });
      return sendJson(res, 200, { identity: "Render terhubung", summary: `${services.length} service: ${services.map((item) => `${item.name} (${item.status})`).join(", ") || "belum ada service"}`, items: services });
    }

    if (provider === "supabase") {
      const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
      const key = typeof body.key === "string" ? body.key.trim() : "";
      let projectUrl;
      try { projectUrl = new URL(rawUrl); } catch { return sendJson(res, 400, { error: "Project URL Supabase tidak valid." }); }
      if (projectUrl.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/i.test(projectUrl.hostname) || !["", "/"].includes(projectUrl.pathname)) {
        return sendJson(res, 400, { error: "Gunakan URL proyek resmi https://<project-ref>.supabase.co." });
      }
      let role = "";
      try { role = JSON.parse(Buffer.from(key.split(".")[1] || "", "base64url").toString("utf8")).role || ""; } catch {}
      if (!key || key.length > 4096 || /service_role/i.test(key) || role === "service_role") return sendJson(res, 400, { error: "Masukkan publishable/anon key saja; service_role key tidak diizinkan." });
      const supabaseHeaders = { apikey: key, Accept: "application/openapi+json" };
      if (key.split(".").length === 3) supabaseHeaders.Authorization = `Bearer ${key}`;
      const response = await requestUpstream(`${projectUrl.origin}/rest/v1/`, supabaseHeaders);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return sendJson(res, 401, { error: "Supabase menolak key atau REST API proyek tidak aktif." });
      const tables = Object.keys(data.paths || {}).filter((path) => path.startsWith("/") && !path.startsWith("/rpc/")).map((path) => path.slice(1)).filter(Boolean).slice(0, 30);
      return sendJson(res, 200, { identity: "Supabase terhubung", summary: `${tables.length} endpoint tabel tersedia untuk key ini: ${tables.join(", ") || "metadata API berhasil dibaca"}`, items: tables });
    }
    return sendJson(res, 404, { error: "Konektor tidak dikenal." });
  } catch (error) {
    const message = error.name === "TimeoutError" ? "Layanan terlalu lama merespons. Coba lagi." : "Tidak dapat menghubungi layanan. Periksa koneksi dan coba lagi.";
    return sendJson(res, 502, { error: message });
  }
}

function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end("Metode tidak diizinkan");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    return res.end("Permintaan tidak valid");
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT, relative);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) && filePath !== ROOT) {
    res.writeHead(403);
    return res.end("Akses ditolak");
  }
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Halaman tidak ditemukan");
    }
    const type = contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": ["/", "/index.html", "/service-worker.js", "/manifest.webmanifest", "/script.js", "/styles.css"].includes(pathname)
        ? "no-cache, no-store, must-revalidate"
        : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self' https://mgntwsjbaihyhtwetbdi.supabase.co; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' https://cdn.jsdelivr.net; base-uri 'self'; frame-ancestors 'none'"
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/chat") return void handleChat(req, res);
  const connectorMatch = url.pathname.match(/^\/api\/connectors\/(github|render|supabase)\/test$/);
  if (connectorMatch) return void handleConnectorTest(req, res, connectorMatch[1]);
  if (url.pathname === "/supabase-config.js") return void sendSupabaseConfig(res);
  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Man-Ai server listening on port ${PORT}`);
});
