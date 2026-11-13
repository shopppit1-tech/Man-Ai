document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");
  const sendButton = document.getElementById("sendButton");
  const conversation = document.getElementById("conversation");
  const welcome = document.getElementById("welcomePanel");
  const count = document.getElementById("charCount");
  const modal = document.getElementById("connectorsModal");
  let busy = false;
  let previousInteractionId = null;
  const connectorProviders = ["github", "render", "supabase"];

  function updateComposer() {
    count.textContent = `${input.value.length} / 8000`;
    sendButton.disabled = busy || !input.value.trim();
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

  async function sendMessage(text = input.value.trim()) {
    if (!text || busy) return;
    welcome.hidden = true;
    conversation.hidden = false;
    addMessage("user", text);
    input.value = "";
    busy = true;
    updateComposer();
    const pending = addMessage("assistant", "Gemini sedang menyiapkan jawaban…", "pending");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, previousInteractionId })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Permintaan gagal (${response.status}).`);
      pending.content.textContent = result.reply || "Gemini mengirim jawaban kosong.";
      pending.row.classList.remove("pending");
      previousInteractionId = result.interactionId || null;
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
  function storageKey(provider) { return `manai-connector-${provider}`; }
  function showResult(provider, message, error = false) {
    const panel = document.getElementById(`${provider}Result`);
    panel.hidden = false;
    panel.textContent = message;
    panel.style.color = error ? "#ffafb9" : "";
  }
  function setConnected(provider, connected, label = "Terhubung (sesi ini)") {
    document.getElementById(`${provider}Status`).textContent = connected ? label : "Belum terhubung";
    document.getElementById(`${provider}Dot`).classList.toggle("active", connected);
    document.querySelector(`.disconnect-button[data-provider="${provider}"]`).hidden = !connected;
  }
  function setInputs(provider, credentials) {
    if (provider === "github") document.getElementById("githubToken").value = credentials.token || "";
    if (provider === "render") document.getElementById("renderToken").value = credentials.token || "";
    if (provider === "supabase") {
      document.getElementById("supabaseUrl").value = credentials.url || "";
      document.getElementById("supabaseAnonKey").value = credentials.key || "";
    }
  }
  async function connect(provider, credentials) {
    const button = document.querySelector(`.connect-button[data-provider="${provider}"]`);
    button.disabled = true;
    button.textContent = "Memeriksa…";
    showResult(provider, "Menghubungi layanan…");
    try {
      const response = await fetch(`/api/connectors/${provider}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Koneksi gagal (${response.status}).`);
      sessionStorage.setItem(storageKey(provider), JSON.stringify(credentials));
      setInputs(provider, credentials);
      setConnected(provider, true, result.identity || "Terhubung (sesi ini)");
      showResult(provider, result.summary || "Koneksi berhasil. Hanya akses baca yang digunakan.");
    } catch (error) {
      setConnected(provider, false);
      showResult(provider, error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "Hubungkan";
    }
  }
  async function refreshConnector(provider) {
    let credentials;
    try { credentials = JSON.parse(sessionStorage.getItem(storageKey(provider)) || "null"); } catch { credentials = null; }
    if (!credentials) return;
    try {
      const response = await fetch(`/api/connectors/${provider}/test`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Koneksi tidak aktif.");
      setInputs(provider, credentials);
      setConnected(provider, true, result.identity || "Terhubung (sesi ini)");
      showResult(provider, result.summary || "Koneksi aktif. Hanya akses baca yang digunakan.");
    } catch {
      sessionStorage.removeItem(storageKey(provider));
      setConnected(provider, false);
    }
  }

  form.addEventListener("submit", (event) => { event.preventDefault(); void sendMessage(); });
  input.addEventListener("input", updateComposer);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
  });
  document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
    input.value = button.dataset.prompt || ""; updateComposer(); input.focus();
  }));
  document.getElementById("themeToggle").addEventListener("click", () => document.body.classList.toggle("light-theme"));
  document.getElementById("connectorsOpen").addEventListener("click", () => { modal.hidden = false; });
  document.getElementById("connectorsClose").addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", (event) => { if (event.target === modal) modal.hidden = true; });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") modal.hidden = true; });
  document.querySelectorAll(".connect-button").forEach((button) => button.addEventListener("click", () => {
    const provider = button.dataset.provider;
    const credentials = providerFields[provider]();
    if (Object.values(credentials).some((value) => !value)) {
      showResult(provider, "Isi semua kolom yang diperlukan terlebih dahulu.", true);
      return;
    }
    void connect(provider, credentials);
  }));
  document.querySelectorAll(".disconnect-button").forEach((button) => button.addEventListener("click", () => {
    const provider = button.dataset.provider;
    sessionStorage.removeItem(storageKey(provider));
    setInputs(provider, {});
    setConnected(provider, false);
    const panel = document.getElementById(`${provider}Result`);
    panel.hidden = true;
    panel.textContent = "";
  }));
  connectorProviders.forEach((provider) => void refreshConnector(provider));
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/service-worker.js").catch(() => {}));
  updateComposer();
});
