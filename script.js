document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");
  const sendButton = document.getElementById("sendButton");
  const conversation = document.getElementById("conversation");
  const welcome = document.getElementById("welcomePanel");
  const count = document.getElementById("charCount");
  const modal = document.getElementById("connectorsModal");
  let busy = false;
  let approvalPending = false;
  let previousInteractionId = null;
  const connectorProviders = ["github", "render", "supabase"];

  function updateComposer() {
    count.textContent = `${input.value.length} / 8000`;
    sendButton.disabled = busy || approvalPending || !input.value.trim();
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }
  function addMessage(role, text, extraClass = "") {
    const row = document.createElement("article");
    row.className = `message ${role} ${extraClass}`.trim();
    const badge = document.createElement("span");
    badge.className = "message-badge";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = role === "user" ? "U" : "✳";
    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = text;
    row.append(badge, content);
    conversation.appendChild(row);
    conversation.scrollTop = conversation.scrollHeight;
    return { row, content };
  }
  function addHtmlDownload(parent, text) {
    const match = text.match(/```html(?:\s+filename=([^\s]+))?\s*\r?\n([\s\S]*?)```/i);
    if (!match) return;
    const filename = (match[1] || "man-ai.html").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "man-ai.html";
    const code = match[2].trim();
    if (!code) return;
    const wrap = document.createElement("div");
    wrap.className = "html-download-wrap";
    const note = document.createElement("span");
    note.textContent = `File siap: ${filename}. Periksa kode sebelum membukanya.`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "html-download-button";
    button.textContent = "Unduh file HTML";
    button.addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([code], { type: "text/html;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = filename.toLowerCase().endsWith(".html") ? filename : `${filename}.html`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    wrap.append(note, button);
    parent.appendChild(wrap);
  }
  function storageKey(provider) { return `manai-connector-${provider}`; }
  function metadataKey(provider) { return `manai-connector-meta-${provider}`; }
  function readConnections() {
    const output = {};
    for (const provider of connectorProviders) {
      try {
        const credentials = JSON.parse(sessionStorage.getItem(storageKey(provider)) || "null");
        if (!credentials) continue;
        const items = JSON.parse(sessionStorage.getItem(metadataKey(provider)) || "[]");
        output[provider] = { ...credentials, items: Array.isArray(items) ? items : [] };
      } catch {}
    }
    return output;
  }
  function displayAction(action) {
    if (action.kind === "create_github_repository") return { title: "Buat repository GitHub privat", detail: { akun: `@${action.args.owner}`, nama: action.args.name, deskripsi: action.args.description || "", visibilitas: "Private", README: "inisialisasi" } };
    if (action.kind === "trigger_render_deploy") return { title: "Jalankan deploy Render", detail: { service: action.args.serviceName, service_id: action.args.serviceId, cache: "tidak dibersihkan", metode: "build dan deploy" } };
    return { title: "Sisipkan satu row ke Supabase", detail: { proyek: action.args.projectUrl, tabel: action.args.table, data: action.args.row } };
  }
  function appendApprovalCard(messageRow, action) {
    approvalPending = true;
    updateComposer();
    const card = document.createElement("div");
    card.className = "approval-card";
    const title = document.createElement("strong");
    const shown = displayAction(action);
    title.textContent = shown.title;
    const detail = document.createElement("pre");
    detail.textContent = JSON.stringify(shown.detail, null, 2);
    const warning = document.createElement("p");
    warning.textContent = "Aksi belum dijalankan. Periksa rincian ini; Gemini tidak dapat mengubahnya setelah konfirmasi.";
    const buttons = document.createElement("div");
    buttons.className = "approval-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "cancel-action"; cancel.textContent = "Batal";
    const confirm = document.createElement("button");
    confirm.type = "button"; confirm.className = "confirm-action"; confirm.textContent = "Konfirmasi dan jalankan";
    buttons.append(cancel, confirm);
    card.append(title, detail, warning, buttons);
    messageRow.querySelector(".message-content").appendChild(card);
    cancel.addEventListener("click", async () => {
      cancel.disabled = confirm.disabled = true;
      try { await fetch("/api/actions/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approvalId: action.approvalId }) }); } catch {}
      card.classList.add("approval-done");
      warning.textContent = "Aksi dibatalkan; tidak ada perubahan yang dilakukan.";
      buttons.remove();
      previousInteractionId = null;
      approvalPending = false;
      updateComposer();
    });
    confirm.addEventListener("click", async () => {
      cancel.disabled = confirm.disabled = true;
      confirm.textContent = "Menjalankan…";
      warning.textContent = "Menunggu hasil dari layanan…";
      try {
        const response = await fetch("/api/actions/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approvalId: action.approvalId, confirmed: true, connections: readConnections() }) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `Aksi gagal (${response.status}).`);
        card.classList.add("approval-done");
        warning.textContent = result.reply || "Aksi berhasil.";
        buttons.remove();
        previousInteractionId = null;
        approvalPending = false;
      } catch (error) {
        card.classList.add("approval-error");
        warning.textContent = error.message;
        buttons.remove();
        previousInteractionId = null;
        approvalPending = false;
      } finally { updateComposer(); conversation.scrollTop = conversation.scrollHeight; }
    });
  }
  async function sendMessage(text = input.value.trim()) {
    if (!text || busy || approvalPending) return;
    welcome.hidden = true;
    conversation.hidden = false;
    addMessage("user", text);
    input.value = "";
    busy = true;
    updateComposer();
    const pending = addMessage("assistant", "Gemini sedang menyiapkan jawaban…", "pending");
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, previousInteractionId, connections: readConnections() }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Permintaan gagal (${response.status}).`);
      pending.content.textContent = result.reply || "Gemini mengirim jawaban kosong.";
      pending.row.classList.remove("pending");
      addHtmlDownload(pending.content, result.reply || "");
      previousInteractionId = result.interactionId || null;
      if (result.pendingAction) appendApprovalCard(pending.row, result.pendingAction);
    } catch (error) {
      pending.row.classList.remove("pending");
      pending.row.classList.add("error");
      pending.content.textContent = `${error.message} Periksa konfigurasi server, lalu coba lagi.`;
    } finally {
      busy = false;
      updateComposer();
      input.focus();
      conversation.scrollTop = conversation.scrollHeight;
    }
  }

  const providerFields = {
    github: () => ({ token: document.getElementById("githubToken").value.trim() }),
    render: () => ({ token: document.getElementById("renderToken").value.trim() }),
    supabase: () => ({ url: document.getElementById("supabaseUrl").value.trim(), key: document.getElementById("supabaseAnonKey").value.trim() })
  };
  function showResult(provider, message, error = false) {
    const panel = document.getElementById(`${provider}Result`);
    panel.hidden = false; panel.textContent = message; panel.style.color = error ? "#ffafb9" : "";
  }
  function setConnected(provider, connected, label = "Terhubung (sesi ini)") {
    document.getElementById(`${provider}Status`).textContent = connected ? label : "Belum terhubung";
    document.getElementById(`${provider}Dot`).classList.toggle("active", connected);
    document.querySelector(`.disconnect-button[data-provider="${provider}"]`).hidden = !connected;
  }
  function setInputs(provider, credentials) {
    if (provider === "github") document.getElementById("githubToken").value = credentials.token || "";
    if (provider === "render") document.getElementById("renderToken").value = credentials.token || "";
    if (provider === "supabase") { document.getElementById("supabaseUrl").value = credentials.url || ""; document.getElementById("supabaseAnonKey").value = credentials.key || ""; }
  }
  function saveConnection(provider, credentials, result) {
    sessionStorage.setItem(storageKey(provider), JSON.stringify(credentials));
    sessionStorage.setItem(metadataKey(provider), JSON.stringify(result.items || []));
    setInputs(provider, credentials);
    setConnected(provider, true, result.identity || "Terhubung (sesi ini)");
    showResult(provider, result.summary || "Koneksi berhasil.");
  }
  async function connect(provider, credentials) {
    const button = document.querySelector(`.connect-button[data-provider="${provider}"]`);
    button.disabled = true; button.textContent = "Memeriksa…"; showResult(provider, "Menghubungi layanan…");
    try {
      const response = await fetch(`/api/connectors/${provider}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Koneksi gagal (${response.status}).`);
      saveConnection(provider, credentials, result);
    } catch (error) { setConnected(provider, false); showResult(provider, error.message, true); }
    finally { button.disabled = false; button.textContent = "Hubungkan"; }
  }
  async function refreshConnector(provider) {
    let credentials;
    try { credentials = JSON.parse(sessionStorage.getItem(storageKey(provider)) || "null"); } catch { credentials = null; }
    if (!credentials) return;
    try {
      const response = await fetch(`/api/connectors/${provider}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Koneksi tidak aktif.");
      saveConnection(provider, credentials, result);
    } catch { sessionStorage.removeItem(storageKey(provider)); sessionStorage.removeItem(metadataKey(provider)); setConnected(provider, false); }
  }

  form.addEventListener("submit", (event) => { event.preventDefault(); void sendMessage(); });
  input.addEventListener("input", updateComposer);
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
  document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => { input.value = button.dataset.prompt || ""; updateComposer(); input.focus(); }));
  document.getElementById("themeToggle").addEventListener("click", () => document.body.classList.toggle("light-theme"));
  document.getElementById("connectorsOpen").addEventListener("click", () => { modal.hidden = false; });
  document.getElementById("connectorsClose").addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", (event) => { if (event.target === modal) modal.hidden = true; });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") modal.hidden = true; });
  document.querySelectorAll(".connect-button").forEach((button) => button.addEventListener("click", () => {
    const provider = button.dataset.provider; const credentials = providerFields[provider]();
    if (Object.values(credentials).some((value) => !value)) { showResult(provider, "Isi semua kolom yang diperlukan terlebih dahulu.", true); return; }
    void connect(provider, credentials);
  }));
  document.querySelectorAll(".disconnect-button").forEach((button) => button.addEventListener("click", () => {
    const provider = button.dataset.provider;
    sessionStorage.removeItem(storageKey(provider)); sessionStorage.removeItem(metadataKey(provider));
    setInputs(provider, {}); setConnected(provider, false);
    const panel = document.getElementById(`${provider}Result`); panel.hidden = true; panel.textContent = "";
  }));
  connectorProviders.forEach((provider) => void refreshConnector(provider));
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/service-worker.js").catch(() => {}));
  updateComposer();
});
