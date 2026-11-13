document.addEventListener("DOMContentLoaded", () => {
  const loadingOverlay = document.getElementById("loadingOverlay");
  setTimeout(() => {
    loadingOverlay.classList.add("hidden");
  }, 600);

  const themeToggle = document.getElementById("themeToggle");
  const body = document.body;
  themeToggle.addEventListener("click", () => {
    if (body.classList.contains("dark-theme")) {
      body.classList.remove("dark-theme");
      body.classList.add("light-theme");
    } else {
      body.classList.remove("light-theme");
      body.classList.add("dark-theme");
    }
  });

  const actionPrompt = document.getElementById("actionPrompt");
  const executeBtn = document.getElementById("executeBtn");
  const terminalBox = document.getElementById("terminalBox");
  const terminalLogs = document.getElementById("terminalLogs");
  const chips = document.querySelectorAll(".chip");

  chips.forEach(chip => {
    chip.addEventListener("click", () => {
      actionPrompt.value = chip.textContent;
      actionPrompt.focus();
    });
  });

  executeBtn.addEventListener("click", () => {
    const text = actionPrompt.value.trim();
    if (!text) return;

    terminalBox.style.display = "block";
    terminalLogs.innerHTML = "";

    const steps = [
      "Initializing Action Engine context...",
      `Analyzing prompt parameters: "${text}"...`,
      "Connecting to autonomous agent cluster...",
      "Executing sub-tasks & synthesizing workflows...",
      "Task execution successfully completed!"
    ];

    let i = 0;
    const interval = setInterval(() => {
      if (i < steps.length) {
        const p = document.createElement("div");
        p.textContent = `> ${steps[i]}`;
        terminalLogs.appendChild(p);
        terminalLogs.scrollTop = terminalLogs.scrollHeight;
        i++;
      } else {
        clearInterval(interval);
      }
    }, 400);
  });
});