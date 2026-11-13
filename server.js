const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 12;
const DAILY_GLOBAL_LIMIT = Math.max(1, Number(process.env.GEMINI_DAILY_LIMIT || 200));
const requestCounts = new Map();
const pendingActions = new Map();

async function listRenderServices(token) {
  if (typeof token !== "string" || !token.trim() || token.length > 4096) return [];
  try {
    const response = await fetch("https://api.render.com/v1/services?limit=20", { headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return [];
    const rows = Array.isArray(data) ? data : (Array.isArray(data.services) ? data.services : []);
    return rows.map((entry) => entry.service || entry).filter((service) => typeof service.id === "string").slice(0, 20).map((service) => ({ id: service.id, name: service.name || "Service", status: service.status || "terdaftar" }));
  } catch { return []; }
}

async function listSupabaseTables(connection) {
  const credentials = getConnectionCredentials({ supabase: connection }, "supabase");
  if (!credentials) return [];
  try {
    const headers = { apikey: credentials.key, Accept: "application/openapi+json" };
    if (credentials.key.split(".").length === 3) headers.Authorization = `Bearer ${credentials.key}`;
    const response = await fetch(`${credentials.url}/rest/v1/`, { headers, signal: AbortSignal.timeout(12_000) });
    const schema = await response.json().catch(() => ({}));
    if (!response.ok) return [];
    return Object.keys(schema.paths || {}).filter((path) => path.startsWith("/") && !path.startsWith("/rpc/")).map((path) => path.slice(1)).filter((name) => /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(name)).slice(0, 30);
  } catch { return []; }
}
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

async function getGitHubLogin(token) {
  if (typeof token !== "string" || !token.trim() || token.length > 4096) return "";
  try {
    const response = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Man-Ai-Connector" }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return "";
    const user = await response.json().catch(() => ({}));
    return typeof user.login === "string" ? user.login : "";
  } catch { return ""; }
}

function connectorFingerprint(provider, connections) {
  const credentials = getConnectionCredentials(connections, provider);
  if (!credentials) return "";
  const material = provider === "supabase" ? `${credentials.url}\n${credentials.key}` : credentials;
  return crypto.createHash("sha256").update(`${provider}\0${material}`).digest("hex");
}

function sameFingerprint(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== 64 || right.length !== 64) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

async function handleChat(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Gunakan metode POST untuk mengirim pesan." });
  }
  const apiKeys = [process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY, process.env.GEMINI_API_KEY_BACKUP, process.env.GEMINI_API_KEY_BACKUP_2]
    .filter((key, index, keys) => Boolean(key) && keys.indexOf(key) === index);
  if (!apiKeys.length) return sendJson(res, 503, { error: "Kunci Gemini API belum dikonfigurasi di server." });
  if (isDailyLimitReached()) return sendJson(res, 429, { error: "Batas pesan harian sudah tercapai. Silakan coba lagi besok." });
  if (isRateLimited(getClientKey(req))) return sendJson(res, 429, { error: "Terlalu banyak pesan. Tunggu satu menit lalu coba lagi." });
  let body;
  try { body = await readJson(req); } catch (error) { return sendJson(res, error.status || 400, { error: error.message || "Permintaan tidak valid." }); }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return sendJson(res, 400, { error: "Pesan tidak boleh kosong." });
  if (message.length > 8000) return sendJson(res, 413, { error: "Pesan terlalu panjang (maksimal 8.000 karakter)." });

  const connections = body.connections && typeof body.connections === "object" ? body.connections : {};
  const github = connections.github && typeof connections.github.token === "string" ? connections.github : null;
  const render = connections.render && typeof connections.render.token === "string" ? connections.render : null;
  const supabase = connections.supabase && typeof connections.supabase.key === "string" && typeof connections.supabase.url === "string" ? connections.supabase : null;
  const tools = [];
  const context = [];
  const githubLogin = github?.token ? await getGitHubLogin(github.token) : "";
  const renderItems = render?.token ? await listRenderServices(render.token) : [];
  const supabaseTables = supabase?.key ? await listSupabaseTables(supabase) : [];
  if (githubLogin) {
    context.push(`Connected GitHub account: @${githubLogin}`);
    tools.push({ type: "function", name: "create_github_repository", description: "Prepare a new private repository in the connected user's GitHub account. Only propose this when explicitly requested; the server will show a confirmation before creating it.", parameters: { type: "object", properties: { name: { type: "string", description: "Repository name; letters, numbers, dots, underscores, and hyphens only." }, description: { type: "string", description: "Short repository description." } }, required: ["name"] } });
  }
  if (render?.token) {
    if (renderItems.length) {
      const ids = renderItems.map((item) => item.id);
      context.push(`Render services connected (use exact IDs): ${JSON.stringify(renderItems.map(({ id, name, status }) => ({ id, name, status })))}`);
      tools.push({ type: "function", name: "trigger_render_deploy", description: "Prepare a deployment for one of the user's connected Render services. The server validates the service ID and requests explicit confirmation before starting a deploy. Cache is never cleared.", parameters: { type: "object", properties: { service_id: { type: "string", enum: ids, description: "Exact service ID from the connected Render service list." } }, required: ["service_id"] } });
    }
  }
  if (supabase?.key && typeof supabase.url === "string") {
    const tables = supabaseTables;
    if (tables.length) {
      context.push(`Supabase REST tables visible to the connected key: ${tables.join(", ")}`);
      tools.push({ type: "function", name: "insert_supabase_row", description: "Prepare insertion of exactly one JSON row into a table visible to the connected Supabase key. The insert is enforced by the project's grants and RLS and requires explicit user confirmation.", parameters: { type: "object", properties: { table: { type: "string", enum: tables, description: "Exact table name from the connected Supabase project." }, row: { type: "object", description: "One JSON row to insert." } }, required: ["table", "row"] } });
    }
  }
  const systemInstruction = [
    "Anda adalah Man-Ai, asisten AI berbahasa Indonesia yang menggunakan Gemini.",
    "Jawab dalam Bahasa Indonesia yang jelas kecuali pengguna meminta bahasa lain. Anda dapat membantu menjelaskan, menulis, dan merencanakan.",
    "Jika pengguna meminta file atau kode HTML, buat satu dokumen HTML lengkap dan mandiri dalam satu fenced code block berlabel html, gunakan format pembuka ```html filename=nama-file.html, dan jangan mengaku file sudah tersimpan; UI akan menyediakan tombol unduh.",
    "Jika konektor yang sesuai tersedia dan pengguna secara jelas meminta pembuatan repo, penyisipan satu row Supabase, atau deploy Render, gunakan tepat satu function tool yang sesuai untuk MENYIAPKAN satu aksi. Jangan pernah mengklaim aksi telah selesai sebelum server mengembalikan hasil sukses.",
    "Function call hanya proposal: server akan menampilkan rincian dan menunggu pengguna menekan Konfirmasi. Jangan minta atau membocorkan token. Jangan melakukan tindakan lain yang tidak tercantum pada tool yang tersedia.",
    "Repo GitHub selalu dibuat privat. Insert Supabase hanya satu row dan harus tunduk pada RLS/grants proyek. Deploy Render tanpa membersihkan cache.",
    context.join("\n")
  ].filter(Boolean).join("\n");
  const requestBody = {
    model: MODEL,
    system_instruction: systemInstruction,
    generation_config: { max_output_tokens: 1200, thinking_level: "low" },
    input: message
  };
  if (tools.length) requestBody.tools = tools;
  if (typeof body.previousInteractionId === "string" && body.previousInteractionId.length > 0 && body.previousInteractionId.length <= 256) requestBody.previous_interaction_id = body.previousInteractionId;
  try {
    let upstream;
    let result = {};
    for (let index = 0; index < apiKeys.length; index += 1) {
      upstream = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKeys[index] }, body: JSON.stringify(requestBody), signal: AbortSignal.timeout(60_000) });
      result = await upstream.json().catch(() => ({}));
      if (upstream.ok || index === apiKeys.length - 1 || ![401, 403, 429].includes(upstream.status)) break;
      console.warn("Gemini API key unavailable; trying configured backup key.");
    }
    if (!upstream.ok) {
      console.error("Gemini API request failed with status", upstream.status);
      if (upstream.status === 429) return sendJson(res, 429, { error: "Gemini sedang sibuk atau kuotanya tercapai. Silakan coba lagi nanti." });
      if (upstream.status === 401 || upstream.status === 403) return sendJson(res, 502, { error: "Gemini menolak kunci API di server. Periksa kunci dan akses model." });
      return sendJson(res, 502, { error: "Gemini belum dapat memproses permintaan. Silakan coba lagi nanti." });
    }
    const steps = Array.isArray(result.steps) ? result.steps : [];
    const calls = steps.filter((step) => step.type === "function_call");
    if (calls.length) {
      if (calls.length !== 1) return sendJson(res, 502, { error: "Gemini mengusulkan lebih dari satu aksi sekaligus. Minta satu aksi per pesan." });
      const call = calls[0];
      const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
      let action;
      if (call.name === "create_github_repository" && github?.token) {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        const description = typeof args.description === "string" ? args.description.trim().slice(0, 350) : "";
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === "..") return sendJson(res, 400, { error: "Nama repo yang diusulkan tidak valid." });
        action = { provider: "github", kind: call.name, args: { name, description, private: true, owner: githubLogin } };
      } else if (call.name === "trigger_render_deploy" && render?.token) {
        const serviceId = typeof args.service_id === "string" ? args.service_id : "";
        if (!serviceId || !renderItems.some((item) => item.id === serviceId)) return sendJson(res, 400, { error: "Gemini memilih service Render yang tidak ditemukan di akun terhubung." });
        const service = renderItems.find((item) => item.id === serviceId);
        action = { provider: "render", kind: call.name, args: { serviceId, serviceName: service.name || serviceId } };
      } else if (call.name === "insert_supabase_row" && supabase?.key) {
        const table = typeof args.table === "string" ? args.table : "";
        const row = args.row;
        if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(table) || !supabaseTables.includes(table)) return sendJson(res, 400, { error: "Tabel yang diusulkan tidak tersedia melalui konektor Supabase." });
        if (!row || typeof row !== "object" || Array.isArray(row) || Buffer.byteLength(JSON.stringify(row)) > 10_000) return sendJson(res, 400, { error: "Data row Supabase tidak valid atau terlalu besar." });
        action = { provider: "supabase", kind: call.name, args: { table, row, projectUrl: new URL(supabase.url).origin } };
      } else {
        return sendJson(res, 502, { error: "Gemini meminta tool yang tidak diizinkan." });
      }
      const now = Date.now();
      for (const [id, pending] of pendingActions) if (pending.expiresAt < now) pendingActions.delete(id);
      if (pendingActions.size >= 1000) return sendJson(res, 503, { error: "Terlalu banyak aksi menunggu persetujuan. Coba lagi nanti." });
      const approvalId = crypto.randomUUID();
      const credentialFingerprint = connectorFingerprint(action.provider, connections);
      if (!credentialFingerprint) return sendJson(res, 400, { error: "Kredensial konektor tidak valid. Sambungkan ulang." });
      pendingActions.set(approvalId, { action, interactionId: result.id || null, requesterSession: req.manaiSessionId, credentialFingerprint, expiresAt: now + 5 * 60_000 });
      const reply = call.name === "create_github_repository" ? `Gemini menyiapkan repo privat bernama ${action.args.name}. Periksa rinciannya lalu konfirmasi.` : call.name === "trigger_render_deploy" ? `Gemini meminta deploy service Render ${action.args.serviceName}. Periksa rinciannya lalu konfirmasi.` : `Gemini menyiapkan satu row untuk tabel Supabase ${action.args.table}. Periksa data persisnya lalu konfirmasi.`;
      return sendJson(res, 200, { reply, interactionId: result.id || null, pendingAction: { approvalId, kind: action.kind, provider: action.provider, args: action.args } });
    }
    const reply = typeof result.output_text === "string" ? result.output_text.trim() : steps
      .filter((step) => step.type === "model_output" && Array.isArray(step.content))
      .flatMap((step) => step.content).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
    if (!reply) return sendJson(res, 502, { error: "Gemini tidak mengirim jawaban. Silakan coba lagi." });
    return sendJson(res, 200, { reply, interactionId: result.id || null });
  } catch (error) {
    console.error("Gemini API connection error:", error.name || "Error");
    return sendJson(res, 502, { error: error.name === "TimeoutError" ? "Gemini terlalu lama merespons. Silakan coba lagi." : "Tidak dapat terhubung ke Gemini. Silakan coba lagi nanti." });
  }
}

function getConnectionCredentials(connections, provider) {
  if (!connections || typeof connections !== "object") return null;
  const entry = connections[provider];
  if (!entry || typeof entry !== "object") return null;
  if (provider === "github" || provider === "render") return typeof entry.token === "string" && entry.token.length <= 4096 ? entry.token.trim() : null;
  if (provider === "supabase" && typeof entry.url === "string" && typeof entry.key === "string") {
    const key = entry.key.trim();
    let url;
    try { url = new URL(entry.url.trim()); } catch { return null; }
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || !["", "/"].includes(url.pathname)) return null;
    let role = "";
    try { role = JSON.parse(Buffer.from(key.split(".")[1] || "", "base64url").toString("utf8")).role || ""; } catch {}
    if (!key || key.length > 4096 || /service_role/i.test(key) || /^sb_secret_/i.test(key) || role === "service_role") return null;
    return { url: url.origin, key };
  }
  return null;
}

async function executeApprovedAction(action, connections) {
  if (action.provider === "github") {
    const token = getConnectionCredentials(connections, "github");
    if (!token) throw new Error("Koneksi GitHub tidak tersedia. Hubungkan ulang lalu coba lagi.");
    const response = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Man-Ai-Connector", "Content-Type": "application/json" },
      body: JSON.stringify({ name: action.args.name, description: action.args.description, private: true, auto_init: true }),
      signal: AbortSignal.timeout(20_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 422 ? "GitHub menolak pembuatan repo. Nama mungkin sudah dipakai atau token tidak memiliki izin Repository creation." : "GitHub gagal membuat repo. Periksa token dan izin Repository creation.");
    return { summary: `Repo privat berhasil dibuat: ${data.html_url || data.full_name || action.args.name}`, url: data.html_url || null };
  }
  if (action.provider === "render") {
    const token = getConnectionCredentials(connections, "render");
    if (!token) throw new Error("Koneksi Render tidak tersedia. Hubungkan ulang lalu coba lagi.");
    const listResponse = await fetch("https://api.render.com/v1/services?limit=100", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const servicesData = await listResponse.json().catch(() => ({}));
    if (!listResponse.ok) throw new Error("Render menolak API key. Hubungkan ulang konektor Render.");
    const entries = Array.isArray(servicesData) ? servicesData : [];
    const service = entries.map((entry) => entry.service || entry).find((item) => item.id === action.args.serviceId);
    if (!service) throw new Error("Service tidak ditemukan atau aksesnya berubah. Hubungkan ulang dan minta Gemini memilih service lagi.");
    const deployResponse = await fetch(`https://api.render.com/v1/services/${encodeURIComponent(action.args.serviceId)}/deploys`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ clearCache: "do_not_clear", deployMode: "build_and_deploy" }), signal: AbortSignal.timeout(20_000)
    });
    const deploy = await deployResponse.json().catch(() => ({}));
    if (!deployResponse.ok) throw new Error("Render gagal memulai deploy. Periksa jenis service dan izin API key.");
    return { summary: `Deploy ${service.name || action.args.serviceName} masuk antrean (${deploy.id || deploy.status || "queued"}).`, deployId: deploy.id || null };
  }
  if (action.provider === "supabase") {
    const credentials = getConnectionCredentials(connections, "supabase");
    if (!credentials) throw new Error("Koneksi Supabase tidak tersedia atau key tidak aman. Hubungkan ulang dengan publishable/anon key.");
    const table = action.args.table;
    if (credentials.url !== action.args.projectUrl) throw new Error("Proyek Supabase berbeda dari yang disetujui. Ajukan aksi baru.");
    if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(table)) throw new Error("Nama tabel tidak valid.");
    const schemaResponse = await fetch(`${credentials.url}/rest/v1/`, { headers: { apikey: credentials.key, Accept: "application/openapi+json", ...(credentials.key.split(".").length === 3 ? { Authorization: `Bearer ${credentials.key}` } : {}) }, signal: AbortSignal.timeout(15_000) });
    const schema = await schemaResponse.json().catch(() => ({}));
    if (!schemaResponse.ok || !Object.hasOwn(schema.paths || {}, `/${table}`)) throw new Error("Tabel tidak tersedia melalui REST API. Periksa nama tabel dan izin proyek.");
    const insertResponse = await fetch(`${credentials.url}/rest/v1/${encodeURIComponent(table)}`, {
      method: "POST", headers: { apikey: credentials.key, ...(credentials.key.split(".").length === 3 ? { Authorization: `Bearer ${credentials.key}` } : {}), "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(action.args.row), signal: AbortSignal.timeout(20_000)
    });
    const data = await insertResponse.json().catch(() => ({}));
    if (!insertResponse.ok) throw new Error(insertResponse.status === 401 || insertResponse.status === 403 ? "Supabase menolak insert. Pastikan GRANT dan kebijakan RLS INSERT mengizinkan row ini." : `Supabase gagal menyisipkan data: ${data.message || data.hint || "periksa skema dan kebijakan tabel"}.`);
    const count = Array.isArray(data) ? data.length : 1;
    return { summary: `Berhasil menyisipkan ${count} row ke tabel ${table}.`, inserted: data };
  }
  throw new Error("Aksi ini tidak diizinkan.");
}

async function handleExecuteAction(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return sendJson(res, 405, { error: "Gunakan POST." }); }
  let body;
  try { body = await readJson(req); } catch (error) { return sendJson(res, error.status || 400, { error: error.message || "Permintaan tidak valid." }); }
  const id = typeof body.approvalId === "string" ? body.approvalId : "";
  const pending = pendingActions.get(id);
  if (!pending || pending.expiresAt < Date.now()) { pendingActions.delete(id); return sendJson(res, 410, { error: "Persetujuan sudah kedaluwarsa. Kirim ulang permintaan ke Gemini." }); }
  if (!req.manaiSessionId || pending.requesterSession !== req.manaiSessionId) return sendJson(res, 403, { error: "Persetujuan ini berasal dari sesi browser lain." });
  if (body.confirmed !== true) return sendJson(res, 400, { error: "Aksi belum dikonfirmasi." });
  const submittedFingerprint = connectorFingerprint(pending.action.provider, body.connections);
  if (!sameFingerprint(pending.credentialFingerprint, submittedFingerprint)) return sendJson(res, 403, { error: "Kredensial atau proyek konektor berubah setelah proposal dibuat. Ajukan aksi baru." });
  pendingActions.delete(id);
  if (isRateLimited(`action:${getClientKey(req)}`)) return sendJson(res, 429, { error: "Terlalu banyak aksi. Coba lagi sebentar." });
  try {
    const result = await executeApprovedAction(pending.action, body.connections);
    return sendJson(res, 200, { success: true, reply: result.summary, interactionId: pending.interactionId, result });
  } catch (error) {
    return sendJson(res, 502, { success: false, error: error.message || "Aksi gagal dijalankan." });
  }
}

function handleCancelAction(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return sendJson(res, 405, { error: "Gunakan POST." }); }
  return readJson(req).then((body) => {
    const id = typeof body.approvalId === "string" ? body.approvalId : "";
    const pending = pendingActions.get(id);
    if (pending && pending.requesterSession === req.manaiSessionId) pendingActions.delete(id);
    return sendJson(res, 200, { canceled: true });
  }).catch((error) => sendJson(res, error.status || 400, { error: error.message || "Permintaan tidak valid." }));
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
      const userResponse = await requestUpstream("https://api.github.com/user", { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Man-Ai-Connector" });
      const user = await userResponse.json().catch(() => ({}));
      if (!userResponse.ok || typeof user.login !== "string") return sendJson(res, 401, { error: "GitHub menolak token atau token tidak valid." });
      const response = await requestUpstream("https://api.github.com/user/repos?per_page=20&sort=updated", {
        Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Man-Ai-Connector"
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return sendJson(res, 401, { error: response.status === 403 ? "GitHub menolak token atau batas API tercapai." : "Token GitHub tidak valid atau tidak memiliki akses baca repo." });
      const repos = Array.isArray(data) ? data.slice(0, 20).map((repo) => ({ name: repo.full_name, private: Boolean(repo.private), branch: repo.default_branch })) : [];
      return sendJson(res, 200, { identity: `GitHub @${user.login}`, account: user.login, summary: `${repos.length} repo terakhir: ${repos.map((repo) => repo.name).join(", ") || "tidak ada repo yang terlihat"}`, items: repos });
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
        return { id: service.id || "", name: service.name || "Service", type: service.type || "service", status: service.suspended === "suspended" ? "suspended" : (service.status || "terdaftar") };
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
      if (!key || key.length > 4096 || /service_role/i.test(key) || /^sb_secret_/i.test(key) || role === "service_role") return sendJson(res, 400, { error: "Masukkan publishable/anon key saja; service_role dan sb_secret_ key tidak diizinkan." });
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
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'"
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

function attachBrowserSession(req, res) {
  const cookie = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  const match = cookie.match(/(?:^|;\s*)manai_sid=([0-9a-f-]{36})(?:;|$)/i);
  if (match) {
    req.manaiSessionId = match[1];
    return;
  }
  const id = crypto.randomUUID();
  req.manaiSessionId = id;
  const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `manai_sid=${id}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400${secure}`);
}

const server = http.createServer((req, res) => {
  attachBrowserSession(req, res);
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/chat") return void handleChat(req, res);
  if (url.pathname === "/api/actions/execute") return void handleExecuteAction(req, res);
  if (url.pathname === "/api/actions/cancel") return void handleCancelAction(req, res);
  const connectorMatch = url.pathname.match(/^\/api\/connectors\/(github|render|supabase)\/test$/);
  if (connectorMatch) return void handleConnectorTest(req, res, connectorMatch[1]);
  if (url.pathname === "/supabase-config.js") return void sendSupabaseConfig(res);
  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Man-Ai server listening on port ${PORT}`);
});
