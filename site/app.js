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
  const REQUEST_TIMEOUT_MS = 50_000;
  const EXPECTED_TARGETS = 22;
  const EXPECTED_SAMPLES = 5;
  const NETWORK_SCHEMA_VERSION = 3;
  const VALID_VIEWS = new Set(["briefing", "network"]);

  const elements = {
    links: [...document.querySelectorAll("[data-view-link]")],
    views: [...document.querySelectorAll("[data-view]")],
    refresh: document.querySelector("#network-refresh"),
    status: document.querySelector("#network-status"),
    groups: document.querySelector("#latency-groups"),
    online: document.querySelector("#online-count"),
    fastest: document.querySelector("#fastest-result"),
    checked: document.querySelector("#checked-time"),
    progressLabel: document.querySelector("#progress-label"),
  };

  let activeController;
  let hasChecked = false;
  let completedSamples = 0;
  let totalSamples = EXPECTED_TARGETS * EXPECTED_SAMPLES;
  let streamCompleted = false;
  const cardStates = new Map();
  const regionStates = new Map();

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

  function latencyTone(latency) {
    if (latency < 200) return ["fast", "连接流畅"];
    if (latency < 500) return ["normal", "连接一般"];
    return ["slow", "连接较慢"];
  }

  function setLoading(isLoading) {
    elements.groups.setAttribute("aria-busy", String(isLoading));
    elements.refresh.disabled = isLoading;
    elements.refresh.classList.toggle("is-spinning", isLoading);
  }

  function renderLoading() {
    const item = document.createElement("p");
    item.className = "latency-placeholder is-loading";
    item.textContent = "正在载入站点列表…";
    elements.groups.replaceChildren(item);
    elements.status.textContent = "正在准备网络检测";
    elements.online.textContent = `0 / ${EXPECTED_TARGETS}`;
    elements.fastest.textContent = "—";
    elements.progressLabel.textContent = "检测进度";
    elements.checked.textContent = `0 / ${totalSamples}`;
    delete elements.status.dataset.tone;
  }

  function renderUnavailable(message = "网络检测服务暂时不可用，请稍后重试。") {
    if (cardStates.size === 0) {
      const item = document.createElement("p");
      item.className = "latency-placeholder";
      item.textContent = message;
      elements.groups.replaceChildren(item);
      elements.online.textContent = "—";
      elements.fastest.textContent = "—";
    }
    elements.status.textContent = message;
    elements.status.dataset.tone = "warning";
    elements.progressLabel.textContent = cardStates.size > 0 ? "检测中断" : "检测进度";
  }

  function normalizeMeta(event) {
    if (
      !event || event.type !== "meta" ||
      event.schemaVersion !== NETWORK_SCHEMA_VERSION ||
      !Array.isArray(event.targets)
    ) {
      throw new Error("检测服务仍是旧版本，请重新部署以加载流式检测功能");
    }
    const sampleCount = Number(event.sampleCount);
    if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 10) {
      throw new Error("检测次数配置无效");
    }
    const targets = event.targets.slice(0, 40).map((target) => {
      const normalized = {
        id: cleanText(target?.id, 32),
        name: cleanText(target?.name, 40),
        host: cleanText(target?.host, 100),
        regionCode: cleanText(target?.regionCode, 8),
        regionName: cleanText(target?.regionName, 40),
        category: cleanText(target?.category, 40),
      };
      if (!normalized.id || !normalized.name || !normalized.regionCode || !normalized.regionName) {
        throw new Error("站点列表格式无效");
      }
      return normalized;
    });
    if (targets.length === 0) throw new Error("站点列表为空");
    return { sampleCount, targets };
  }

  function createSampleResult(targetName, index) {
    const item = document.createElement("li");
    item.className = "sample-result";
    item.dataset.tone = "pending";
    item.setAttribute("aria-label", `${targetName}第 ${index} 次：等待检测`);
    const number = document.createElement("span");
    number.textContent = `第${index}次`;
    const result = document.createElement("strong");
    result.textContent = "等待";
    item.append(number, result);
    return item;
  }

  function renderTargets(meta) {
    cardStates.clear();
    regionStates.clear();
    completedSamples = 0;
    totalSamples = meta.targets.length * meta.sampleCount;
    streamCompleted = false;

    const regions = new Map();
    meta.targets.forEach((target) => {
      if (!regions.has(target.regionCode)) {
        regions.set(target.regionCode, { name: target.regionName, targets: [] });
      }
      regions.get(target.regionCode).targets.push(target);
    });

    const fragment = document.createDocumentFragment();
    regions.forEach((region, regionCode) => {
      const section = document.createElement("section");
      section.className = "region-group";
      const heading = document.createElement("div");
      heading.className = "region-heading";
      const title = document.createElement("h3");
      title.textContent = region.name;
      const regionStatus = document.createElement("span");
      regionStatus.textContent = `0 / ${region.targets.length} 已完成`;
      heading.append(title, regionStatus);

      const list = document.createElement("ul");
      list.className = "latency-grid";
      const regionIDs = [];

      region.targets.forEach((target) => {
        const card = document.createElement("li");
        card.className = "latency-card";
        card.dataset.tone = "pending";
        const name = document.createElement("h4");
        name.className = "latency-name";
        name.textContent = target.name;
        const host = document.createElement("span");
        host.className = "latency-host";
        host.textContent = `${target.category || "网站"} · ${target.host}`;
        const value = document.createElement("span");
        value.className = "latency-value";
        value.textContent = "—";
        const sampleList = document.createElement("ol");
        sampleList.className = "sample-results";
        sampleList.setAttribute("aria-label", `${target.name}的 ${meta.sampleCount} 次检测结果`);
        const sampleElements = [];
        for (let index = 1; index <= meta.sampleCount; index += 1) {
          const sampleElement = createSampleResult(target.name, index);
          sampleElements.push(sampleElement);
          sampleList.append(sampleElement);
        }
        const state = document.createElement("span");
        state.className = "latency-state";
        state.textContent = "等待检测";
        card.append(name, host, value, sampleList, state);
        list.append(card);
        regionIDs.push(target.id);
        cardStates.set(target.id, {
          ...target,
          card,
          value,
          state,
          sampleCount: meta.sampleCount,
          sampleElements,
          samples: Array(meta.sampleCount).fill(null),
        });
      });

      regionStates.set(regionCode, { ids: regionIDs, status: regionStatus });
      section.append(heading, list);
      fragment.append(section);
    });

    elements.groups.replaceChildren(fragment);
    elements.online.textContent = `0 / ${meta.targets.length}`;
    elements.fastest.textContent = "—";
    elements.progressLabel.textContent = "检测进度";
    elements.checked.textContent = `0 / ${totalSamples}`;
    elements.status.textContent = `已展示 ${meta.targets.length} 个站点，检测结果将依次更新`;
  }

  function successfulSamples(state) {
    return state.samples.filter((sample) => sample?.reachable);
  }

  function updateRegionStatuses() {
    regionStates.forEach((region) => {
      const states = region.ids.map((id) => cardStates.get(id));
      const finished = states.filter((state) => state.samples.every(Boolean)).length;
      const online = states.filter((state) => successfulSamples(state).length > 0).length;
      region.status.textContent = `${finished} / ${states.length} 已完成 · ${online} 可连接`;
    });
  }

  function updateDashboard() {
    const states = [...cardStates.values()];
    const online = states.filter((state) => successfulSamples(state).length > 0).length;
    const successes = states.flatMap((state) =>
      successfulSamples(state).map((sample) => ({ ...sample, name: state.name })),
    );
    elements.online.textContent = `${online} / ${states.length}`;
    if (successes.length > 0) {
      const fastest = successes.reduce((best, sample) =>
        sample.latencyMs < best.latencyMs ? sample : best,
      );
      elements.fastest.textContent = `${fastest.name} · ${fastest.latencyMs} ms`;
    }
    elements.checked.textContent = `${completedSamples} / ${totalSamples}`;
    if (completedSamples % 10 === 0 || completedSamples === totalSamples) {
      elements.status.textContent = `正在检测：已完成 ${completedSamples} / ${totalSamples} 次连接`;
    }
    updateRegionStatuses();
  }

  function applySample(event) {
    const state = cardStates.get(cleanText(event?.targetId, 32));
    const sampleIndex = Number(event?.sampleIndex);
    const latency = Number(event?.latencyMs);
    if (
      !state || !Number.isInteger(sampleIndex) ||
      sampleIndex < 1 || sampleIndex > state.sampleCount ||
      state.samples[sampleIndex - 1] !== null ||
      typeof event.reachable !== "boolean" ||
      (event.reachable === true && (!Number.isFinite(latency) || latency < 0))
    ) {
      throw new Error("收到无效的单次检测结果");
    }

    const sample = event.reachable === true
      ? { reachable: true, latencyMs: Math.round(latency) }
      : { reachable: false, error: cleanText(event.error, 60) || "连接失败" };
    state.samples[sampleIndex - 1] = sample;
    completedSamples += 1;

    const sampleElement = state.sampleElements[sampleIndex - 1];
    const sampleText = sampleElement.querySelector("strong");
    if (sample.reachable) {
      const [tone, label] = latencyTone(sample.latencyMs);
      sampleElement.dataset.tone = tone;
      sampleText.textContent = `${sample.latencyMs}ms`;
      sampleElement.setAttribute(
        "aria-label",
        `${state.name}第 ${sampleIndex} 次：${sample.latencyMs} 毫秒，${label}`,
      );
    } else {
      sampleElement.dataset.tone = "error";
      sampleText.textContent = "失败";
      sampleElement.title = sample.error;
      sampleElement.setAttribute("aria-label", `${state.name}第 ${sampleIndex} 次：${sample.error}`);
    }

    const finished = state.samples.filter(Boolean).length;
    const successes = successfulSamples(state);
    if (successes.length > 0) {
      const average = Math.round(
        successes.reduce((sum, item) => sum + item.latencyMs, 0) / successes.length,
      );
      const [tone] = latencyTone(average);
      state.card.dataset.tone = tone;
      state.value.replaceChildren(String(average));
      const unit = document.createElement("small");
      unit.textContent = "ms 均值";
      state.value.append(unit);
    } else if (finished === state.sampleCount) {
      state.card.dataset.tone = "error";
      state.value.textContent = "不可达";
    } else {
      state.value.textContent = "检测中";
    }
    state.state.textContent = `已完成 ${finished}/${state.sampleCount} · ${successes.length} 次成功`;
    updateDashboard();
  }

  function finishStream(event) {
    if (event.schemaVersion !== NETWORK_SCHEMA_VERSION || completedSamples !== totalSamples) {
      throw new Error("检测数据未完整返回，请重新检测");
    }
    streamCompleted = true;
    const checkedAt = new Date(event.checkedAt);
    elements.progressLabel.textContent = "完成时间";
    elements.checked.textContent = Number.isNaN(checkedAt.getTime())
      ? "刚刚"
      : new Intl.DateTimeFormat("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(checkedAt);
    const unavailable = [...cardStates.values()]
      .filter((state) => successfulSamples(state).length === 0).length;
    elements.status.textContent = unavailable === 0
      ? `检测完成：${cardStates.size} 个站点均可连接`
      : `检测完成：${unavailable} 个站点的 5 次连接均失败`;
    if (unavailable > 0) elements.status.dataset.tone = "warning";
    else delete elements.status.dataset.tone;
  }

  function handleStreamEvent(event) {
    if (event?.type === "meta" && cardStates.size === 0) renderTargets(normalizeMeta(event));
    else if (event?.type === "sample") applySample(event);
    else if (event?.type === "complete" && !streamCompleted) finishStream(event);
    else if (event?.type === "error") throw new Error("网络检测服务执行失败");
    else if (event && Array.isArray(event.results)) {
      throw new Error("检测服务仍是旧版本，请运行 ./manage.sh up 重新部署");
    }
    else throw new Error("网络检测响应包含未知事件");
  }

  async function consumeStream(response) {
    if (!response.body) throw new Error("浏览器不支持流式检测结果");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.filter((line) => line.trim()).forEach((line) => {
        handleStreamEvent(JSON.parse(line));
      });
      if (done) break;
    }
    if (buffer.trim()) handleStreamEvent(JSON.parse(buffer));
    if (!streamCompleted) throw new Error("检测连接提前结束，请重新检测");
  }

  async function loadNetworkResults() {
    if (activeController) activeController.abort();
    activeController = new AbortController();
    const timeout = window.setTimeout(() => activeController.abort(), REQUEST_TIMEOUT_MS);

    hasChecked = true;
    cardStates.clear();
    regionStates.clear();
    completedSamples = 0;
    totalSamples = EXPECTED_TARGETS * EXPECTED_SAMPLES;
    streamCompleted = false;
    setLoading(true);
    renderLoading();

    try {
      const response = await fetch(NETWORK_ENDPOINT, {
        headers: { Accept: "application/x-ndjson" },
        cache: "no-store",
        signal: activeController.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await consumeStream(response);
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : "网络检测服务暂时不可用，请稍后重试。";
      renderUnavailable(message);
    } finally {
      window.clearTimeout(timeout);
      setLoading(false);
    }
  }

  window.addEventListener("hashchange", showView);
  elements.refresh.addEventListener("click", loadNetworkResults);
  showView();
})();
