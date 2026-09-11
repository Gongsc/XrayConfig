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

(() => {
  "use strict";

  const NETWORK_ENDPOINT = "/api/network-check";
  const REQUEST_TIMEOUT_MS = 12_000;
  const VALID_VIEWS = new Set(["briefing", "network"]);

  const elements = {
    links: [...document.querySelectorAll("[data-view-link]")],
    views: [...document.querySelectorAll("[data-view]")],
    refresh: document.querySelector("#network-refresh"),
    status: document.querySelector("#network-status"),
    grid: document.querySelector("#latency-grid"),
    average: document.querySelector("#average-latency"),
    grade: document.querySelector("#network-grade-label"),
    online: document.querySelector("#online-count"),
    fastest: document.querySelector("#fastest-result"),
    checked: document.querySelector("#checked-time"),
  };

  let activeController;
  let hasChecked = false;

  function currentView() {
    const requested = window.location.hash.slice(1);
    if (VALID_VIEWS.has(requested)) return requested;
    if (!requested) return "briefing";
    return elements.views.find((view) => !view.hidden)?.dataset.view || "briefing";
  }

  function showView() {
    const selected = currentView();
    elements.views.forEach((view) => {
      view.hidden = view.dataset.view !== selected;
    });
    elements.links.forEach((link) => {
      const isActive = link.dataset.viewLink === selected;
      link.classList.toggle("is-active", isActive);
      if (isActive) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    if (selected === "network" && !hasChecked) loadNetworkResults();
  }

  function cleanText(value, maxLength = 100) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  }

  function normalize(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.results)) {
      throw new Error("响应格式无效");
    }

    const results = payload.results.slice(0, 10).map((item) => {
      if (!item || typeof item !== "object") throw new Error("检测项目无效");
      const latency = Number(item.latencyMs);
      return {
        id: cleanText(item.id, 32),
        name: cleanText(item.name, 40) || "未知站点",
        host: cleanText(item.host, 100),
        reachable: item.reachable === true,
        latencyMs: Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : 0,
        error: cleanText(item.error, 60),
      };
    });

    if (results.length === 0) throw new Error("没有检测结果");
    return { checkedAt: cleanText(payload.checkedAt, 40), results };
  }

  function latencyTone(latency) {
    if (latency < 200) return ["fast", "连接流畅"];
    if (latency < 500) return ["normal", "连接一般"];
    return ["slow", "连接较慢"];
  }

  function setLoading(isLoading) {
    elements.grid.setAttribute("aria-busy", String(isLoading));
    elements.refresh.disabled = isLoading;
    elements.refresh.classList.toggle("is-spinning", isLoading);
  }

  function renderLoading() {
    const item = document.createElement("li");
    item.className = "latency-placeholder is-loading";
    item.textContent = "服务器正在连接各站点…";
    elements.grid.replaceChildren(item);
    elements.status.textContent = "正在检测 6 个站点，最慢可能需要 8 秒";
    delete elements.status.dataset.tone;
  }

  function renderResults(data) {
    const reachable = data.results.filter((item) => item.reachable);
    const fragment = document.createDocumentFragment();

    data.results.forEach((result) => {
      const card = document.createElement("li");
      card.className = "latency-card";

      const name = document.createElement("h3");
      name.className = "latency-name";
      name.textContent = result.name;

      const host = document.createElement("span");
      host.className = "latency-host";
      host.textContent = result.host;

      const value = document.createElement("span");
      value.className = "latency-value";

      const state = document.createElement("span");
      state.className = "latency-state";

      if (result.reachable) {
        const [tone, label] = latencyTone(result.latencyMs);
        card.dataset.tone = tone;
        value.append(String(result.latencyMs));
        const unit = document.createElement("small");
        unit.textContent = "ms";
        value.append(unit);
        state.textContent = label;
      } else {
        card.dataset.tone = "error";
        value.textContent = "不可达";
        state.textContent = result.error || "连接失败";
      }

      card.append(name, host, value, state);
      fragment.append(card);
    });

    elements.grid.replaceChildren(fragment);
    elements.online.textContent = `${reachable.length} / ${data.results.length}`;

    if (reachable.length > 0) {
      const average = Math.round(
        reachable.reduce((sum, item) => sum + item.latencyMs, 0) / reachable.length,
      );
      const fastest = reachable.reduce((best, item) =>
        item.latencyMs < best.latencyMs ? item : best,
      );
      const [, gradeLabel] = latencyTone(average);
      elements.average.textContent = `${average} ms`;
      elements.grade.textContent = gradeLabel;
      elements.fastest.textContent = `${fastest.name} · ${fastest.latencyMs} ms`;
    } else {
      elements.average.textContent = "不可用";
      elements.grade.textContent = "全部不可达";
      elements.fastest.textContent = "—";
    }

    const checkedAt = new Date(data.checkedAt);
    elements.checked.textContent = Number.isNaN(checkedAt.getTime())
      ? "刚刚"
      : new Intl.DateTimeFormat("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(checkedAt);

    const failed = data.results.length - reachable.length;
    elements.status.textContent = failed === 0
      ? "检测完成，所有站点均可连接"
      : `检测完成，${failed} 个站点暂时不可达`;
    if (failed > 0) elements.status.dataset.tone = "warning";
    else delete elements.status.dataset.tone;
  }

  function renderUnavailable() {
    const item = document.createElement("li");
    item.className = "latency-placeholder";
    item.textContent = "网络检测服务暂时不可用，请稍后重试。";
    elements.grid.replaceChildren(item);
    elements.status.textContent = "未能取得检测结果";
    elements.status.dataset.tone = "warning";
    elements.average.textContent = "—";
    elements.grade.textContent = "检测失败";
    elements.online.textContent = "—";
    elements.fastest.textContent = "—";
    elements.checked.textContent = "—";
  }

  async function loadNetworkResults() {
    if (activeController) activeController.abort();
    activeController = new AbortController();
    const timeout = window.setTimeout(() => activeController.abort(), REQUEST_TIMEOUT_MS);

    hasChecked = true;
    setLoading(true);
    renderLoading();

    try {
      const response = await fetch(NETWORK_ENDPOINT, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: activeController.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      renderResults(normalize(await response.json()));
    } catch {
      renderUnavailable();
    } finally {
      window.clearTimeout(timeout);
      setLoading(false);
    }
  }

  window.addEventListener("hashchange", showView);
  elements.refresh.addEventListener("click", loadNetworkResults);
  showView();
})();
