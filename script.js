document.addEventListener("DOMContentLoaded", () => {
  const chatInput = document.getElementById("chat-input");
  const sendBtn = document.getElementById("send-btn");
  const conversation = document.getElementById("conversation");
  const chips = document.querySelectorAll(".chip");
  const modalBackdrop = document.getElementById("modal-backdrop");
  const modalClose = document.getElementById("modal-close");
  const installBtn = document.getElementById("install-btn");
  let previousInteractionId = null;
  let busy = false;
  let deferredInstallPrompt = null;

  function updateSendButton() {
    sendBtn.disabled = busy || chatInput.textContent.trim().length === 0;
  }

  function addMessage(role, text, extraClass = "") {
    const message = document.createElement("div");
    message.className = `message message-${role} ${extraClass}`.trim();
    const label = document.createElement("span");
    label.className = "message-label";
    label.textContent = role === "user" ? "Anda" : role === "assistant" ? "Gemini" : "Status";
    const body = document.createElement("p");
    body.className = "message-text";
    body.textContent = text;
    message.append(label, body);
    conversation.appendChild(message);
    conversation.scrollTop = conversation.scrollHeight;
    return message;
  }

  async function sendMessage() {
    const message = chatInput.textContent.trim();
    if (!message || busy) return;

    addMessage("user", message);
    chatInput.textContent = "";
    chatInput.focus();
    busy = true;
    updateSendButton();
    const pending = addMessage("assistant", "Gemini sedang menyiapkan jawaban…", "message-pending");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, previousInteractionId })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || `Permintaan gagal (${response.status})`);
      }
      pending.querySelector(".message-text").textContent = result.reply;
      pending.classList.remove("message-pending");
      previousInteractionId = result.interactionId || null;
    } catch (error) {
      pending.classList.add("message-error");
      pending.querySelector(".message-label").textContent = "Jawaban gagal dibuat";
      const detail = error.message.includes("GEMINI_API_KEY")
        ? "Gemini belum dikonfigurasi di server. Pemilik situs perlu menambahkan kunci API sebagai secret server."
        : error.message.includes("Failed to fetch")
          ? "Tidak dapat terhubung ke server. Periksa koneksi internet lalu coba lagi."
          : `${error.message} Silakan coba lagi sebentar. `;
      pending.querySelector(".message-text").textContent = detail.trim();
    } finally {
      busy = false;
      updateSendButton();
      conversation.scrollTop = conversation.scrollHeight;
    }
  }

  function openHelp() {
    modalBackdrop.hidden = false;
    modalClose.focus();
  }

  function closeHelp() {
    modalBackdrop.hidden = true;
    document.getElementById("help-btn").focus();
  }

  chatInput.addEventListener("input", updateSendButton);
  chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener("click", sendMessage);

  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      chatInput.textContent = chip.textContent;
      updateSendButton();
      chatInput.focus();
    });
  });

  document.getElementById("try-chat-btn").addEventListener("click", () => chatInput.focus());
  document.getElementById("help-btn").addEventListener("click", openHelp);
  modalClose.addEventListener("click", closeHelp);
  modalBackdrop.addEventListener("click", (event) => {
    if (event.target === modalBackdrop) closeHelp();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modalBackdrop.hidden) closeHelp();
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installBtn.hidden = false;
  });

  installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.hidden = true;
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    installBtn.hidden = true;
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch((error) => {
      console.warn("PWA service worker gagal didaftarkan:", error);
    });
  }
});
