(() => {
  "use strict";

  const API_ENDPOINT = "/api/60s";
  const CACHE_KEY = "world-in-60-seconds:v1";
  const MAX_NEWS_ITEMS = 30;
  const REQUEST_TIMEOUT_MS = 10_000;

  const elements = {
    today: document.querySelector("#today"),
    count: document.querySelector("#edition-count"),
    meta: document.querySelector("#edition-meta"),
    status: document.querySelector("#status"),
    refresh: document.querySelector("#refresh"),
    list: document.querySelector("#news-list"),
    note: document.querySelector("#daily-note"),
    tip: document.querySelector("#daily-tip"),
  };

  let activeController;

  function displayDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!match) return value || "今日";
    return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
  }

  function currentDateLabel() {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    }).format(new Date());
  }

  function cleanText(value, maxLength = 500) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  }

  function normalize(payload) {
    if (!payload || typeof payload !== "object") throw new Error("响应不是有效对象");
    if ("code" in payload && Number(payload.code) !== 200) {
      throw new Error(cleanText(payload.message) || "API 返回错误");
    }

    const source = payload.data && typeof payload.data === "object" ? payload.data : payload;
    const news = Array.isArray(source.news)
      ? source.news.map((item) => cleanText(item)).filter(Boolean).slice(0, MAX_NEWS_ITEMS)
      : [];

    if (news.length === 0) throw new Error("响应中没有新闻内容");

    return {
      date: cleanText(source.date, 32),
      dayOfWeek: cleanText(source.day_of_week || source.dayOfWeek, 16),
      lunarDate: cleanText(source.lunar_date || source.lunarDate, 32),
      updated: cleanText(source.updated || source.api_updated, 32),
      tip: cleanText(source.tip, 300),
      news,
    };
  }

  function setLoading(isLoading) {
    elements.list.setAttribute("aria-busy", String(isLoading));
    elements.refresh.disabled = isLoading;
    elements.refresh.classList.toggle("is-spinning", isLoading);
  }

  function setStatus(message, tone = "normal") {
    elements.status.textContent = message;
    if (tone === "warning") elements.status.dataset.tone = "warning";
    else delete elements.status.dataset.tone;
  }

  function render(data, sourceLabel) {
    const fragment = document.createDocumentFragment();
    data.news.forEach((headline) => {
      const item = document.createElement("li");
      item.textContent = headline;
      fragment.append(item);
    });

    elements.list.replaceChildren(fragment);
    elements.list.classList.remove("is-loading");
    elements.count.textContent = `${data.news.length} 条`;

    const dateParts = [displayDate(data.date), data.dayOfWeek, data.lunarDate].filter(Boolean);
    elements.today.textContent = dateParts.join(" · ") || currentDateLabel();
    elements.meta.textContent = sourceLabel;

    if (data.tip) {
      elements.tip.textContent = `“${data.tip}”`;
      elements.note.hidden = false;
    } else {
      elements.note.hidden = true;
      elements.tip.textContent = "";
    }

    const updatedLabel = data.updated ? `数据更新于 ${data.updated}` : "今日数据已就绪";
    setStatus(updatedLabel, sourceLabel === "离线缓存" ? "warning" : "normal");
  }

  function renderUnavailable() {
    const item = document.createElement("li");
    item.className = "notice-item";
    item.textContent = "今日简报暂时未能送达，请稍后刷新。";
    elements.list.replaceChildren(item);
    elements.list.classList.remove("is-loading");
    elements.count.textContent = "暂不可用";
    elements.meta.textContent = "稍后再试";
    elements.note.hidden = true;
    setStatus("新闻服务暂时不可用", "warning");
  }

  function saveCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
    } catch {
      // Storage can be unavailable in strict privacy modes; the live page still works.
    }
  }

  function readCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (!cached || typeof cached !== "object") return null;
      return normalize(cached.data);
    } catch {
      return null;
    }
  }

  async function loadBriefing() {
    if (activeController) activeController.abort();
    activeController = new AbortController();
    const timeout = window.setTimeout(() => activeController.abort(), REQUEST_TIMEOUT_MS);

    setLoading(true);
    setStatus("正在获取今日简报…");

    try {
      const response = await fetch(API_ENDPOINT, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: activeController.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = normalize(await response.json());
      render(data, "今日简报");
      saveCache(data);
    } catch {
      const cached = readCache();
      if (cached) render(cached, "离线缓存");
      else renderUnavailable();
    } finally {
      window.clearTimeout(timeout);
      setLoading(false);
    }
  }

  elements.today.textContent = currentDateLabel();
  elements.refresh.addEventListener("click", loadBriefing);
  loadBriefing();
})();
