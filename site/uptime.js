"use strict";

(() => {
  function formatUptime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const days = Math.floor(total / 86400);
    const hours = Math.floor(total % 86400 / 3600);
    const minutes = Math.floor(total % 3600 / 60);
    return `已运行 ${days} 天 ${hours} 小时 ${minutes} 分 ${total % 60} 秒`;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { formatUptime };
  if (typeof document === "undefined") return;
  const label = document.querySelector("#server-uptime");
  if (!label) return;
  let sample;
  let sampledAt;
  let pending = false;
  function paint() {
    if (sample === undefined) return;
    label.textContent = formatUptime(sample + (performance.now() - sampledAt) / 1000);
  }
  async function sync() {
    if (pending || document.hidden) return;
    pending = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("/api/uptime", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Uptime unavailable");
      const data = await response.json();
      if (!Number.isFinite(data.uptimeSeconds) || data.uptimeSeconds < 0) throw new Error("Invalid uptime");
      sample = data.uptimeSeconds;
      sampledAt = performance.now();
      paint();
    } catch {
      sample = undefined;
      label.textContent = "已运行时间暂不可用";
    } finally {
      window.clearTimeout(timeout);
      pending = false;
    }
  }
  window.setInterval(paint, 1000);
  window.setInterval(sync, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  sync();
})();
