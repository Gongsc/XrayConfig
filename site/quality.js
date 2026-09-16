"use strict";

(() => {
  const TITLES = ["基础信息", "IP 类型", "风险评分", "风险因子", "流媒体与 AI 解锁", "邮件与黑名单"];
  const PROVIDERS = { IPinfo: "IPinfo", ipregistry: "IPregistry", ipapi: "ipapi", AbuseIPDB: "AbuseIPDB",
    IP2LOCATION: "IP2Location", IPQS: "IPQS", SCAMALYTICS: "Scamalytics", DBIP: "DB-IP", ipdata: "ipdata" };
  const MEDIA = { Netflix: "Netflix", ChatGPT: "ChatGPT", DisneyPlus: "Disney+", Youtube: "YouTube Premium",
    TikTok: "TikTok", AmazonPrimeVideo: "Prime Video", Reddit: "Reddit" };
  const FACTORS = { Proxy: "代理", VPN: "VPN", Tor: "Tor 出口", Server: "机房", Abuser: "滥用记录", Robot: "机器人" };
  function text(value) {
    if (value === null || value === undefined || typeof value === "object") return "";
    const result = String(value).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim().slice(0, 240);
    return /^(null|undefined|N\/A)$/i.test(result) ? "" : result;
  }
  function factorSummary(values) {
    const known = Object.values(values || {}).filter((value) => typeof value === "boolean");
    const positive = known.filter(Boolean).length;
    return !known.length ? { label: "暂无数据", tone: "" }
      : positive ? { label: `是 · ${positive}/${known.length} 来源`, tone: "warning" }
        : { label: `否 · ${known.length} 来源`, tone: "good" };
  }
  function mediaTone(value) {
    if (/^(解锁|Yes|可用)$/i.test(text(value))) return "good";
    if (/^(屏蔽|Block|中国|China)$/i.test(text(value))) return "bad";
    if (/^(仅自制|仅网页|仅APP|禁会员|NF\.Only|WebOnly|APPOnly|NoPrem\.)$/i.test(text(value))) return "warning";
    return "";
  }
  function mediaLabel(data) {
    const region = text(data.Region);
    return [text(data.Status), /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : "", text(data.Type)].filter(Boolean).join(" · ");
  }
  function redactJob(payload) {
    const result = JSON.parse(JSON.stringify(payload));
    for (const entry of result.results || []) {
      const ip = entry.raw?.Head?.IP;
      if (typeof ip !== "string" || ip.includes("*")) continue;
      const masked = /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? `${ip.split(".").slice(0, 2).join(".")}.*.*`
        : ip.includes(":") ? `${ip.split(":").slice(0, 2).map((part) => part || "0").join(":")}:*:*:*:*:*:*` : "已隐藏";
      const visit = (value) => typeof value === "string" ? (ip ? value.split(ip).join(masked).split(encodeURIComponent(ip)).join(encodeURIComponent(masked)) : value)
        : Array.isArray(value) ? value.map(visit)
          : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)])) : value;
      entry.raw = visit(entry.raw);
      entry.raw.Head.IP = masked;
    }
    return result;
  }
  function scoreNumber(value) {
    const raw = text(value);
    if (!/^\d+(\.\d+)?%?$/.test(raw)) return null;
    const number = Number(raw.replace("%", ""));
    return number >= 0 && number <= 100 ? number : null;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { text, factorSummary, mediaTone, scoreNumber, mediaLabel, redactJob };
  }
  if (typeof document === "undefined") return;

  const elements = {
    results: document.querySelector("#quality-results"), status: document.querySelector("#quality-status"),
    time: document.querySelector("#quality-time"), start: document.querySelector("#quality-start"),
    family: document.querySelector("#quality-family"), export: document.querySelector("#quality-export"),
    switch: document.querySelector("#quality-report-switch"),
  };
  if (!elements.results) return;
  let family = "4";
  let selected = "4";
  let job;
  let pollTimer;
  let activeController;
  let requestId = 0;
  let initialized = false;
  let requesting = false;
  let painted = "";

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function pill(label, tone = "") { return el("span", `quality-pill ${tone}`, label || "暂无数据"); }
  function row(label, value) {
    const node = el("div", "quality-row");
    node.append(el("span", "", label), typeof value === "string" ? el("span", "", value) : value);
    return node;
  }
  function note(container, content) { container.append(el("p", "quality-note", content)); }
  function details(label, items) {
    const node = el("details", "quality-details");
    node.append(el("summary", "", label));
    items.forEach((item) => node.append(item));
    return node;
  }
  function basic(container, raw) {
    const info = raw.Info;
    const list = el("dl", "quality-facts");
    const facts = [
      [`出口 IPv${selected}`, text(raw.Head.IP), "quality-ip"],
      ["地理位置", [text(info.Region?.Name), text(info.City?.Name)].filter(Boolean).join(" · ")],
      ["自治系统 / ASN", text(info.ASN) ? `AS${text(info.ASN).replace(/^AS/i, "")}` : ""],
      ["组织", text(info.Organization)], ["时区", text(info.TimeZone)],
    ];
    for (const [label, value, style] of facts) {
      const item = el("div", style);
      item.append(el("dt", "", label), el("dd", "", value || "暂无数据"));
      list.append(item);
    }
    container.append(list);
    note(container, "基础信息来源：MaxMind");
  }
  function types(container, raw) {
    ["IPinfo", "ipregistry", "IP2LOCATION"].forEach((key) =>
      container.append(row(PROVIDERS[key], pill(text(raw.Type.Usage?.[key]), text(raw.Type.Usage?.[key]) ? "info" : ""))));
    const items = [];
    for (const key of ["IPinfo", "ipregistry", "ipapi", "AbuseIPDB", "IP2LOCATION"]) {
      items.push(el("p", "", `${PROVIDERS[key]} · 用途：${text(raw.Type.Usage?.[key]) || "暂无数据"} · 组织类型：${text(raw.Type.Company?.[key]) || "暂无数据"}`));
    }
    container.append(details("查看各来源详细分类", items));
  }
  function scores(container, raw) {
    for (const key of ["SCAMALYTICS", "IPQS", "AbuseIPDB", "IP2LOCATION", "ipapi"]) {
      const value = text(raw.Score[key]);
      const numeric = scoreNumber(value);
      const item = el("div", "quality-row quality-score");
      item.append(el("span", "", PROVIDERS[key]));
      if (numeric !== null) {
        const bar = el("progress");
        bar.max = 100;
        bar.value = numeric;
        bar.setAttribute("aria-label", `${PROVIDERS[key]} 原始评分 ${value}`);
        item.append(bar);
      } else item.append(el("span"));
      item.append(el("span", "quality-score-value", value || "暂无数据"));
      container.append(item);
    }
    const dbip = { "0": "低", "50": "中", "100": "高" }[text(raw.Score.DBIP)];
    container.append(row("DB-IP 风险等级", pill(dbip)));
    note(container, "保留原始评分，各来源口径不同，不合并为综合分。DB-IP 展示来源分级。");
  }
  function factors(container, raw) {
    const grid = el("div", "quality-factors");
    for (const [key, label] of Object.entries(FACTORS)) {
      const summary = factorSummary(raw.Factor[key]);
      grid.append(row(label, pill(summary.label, summary.tone)));
    }
    container.append(grid);
    container.append(details("查看风险因子来源", Object.entries(FACTORS).map(([key, label]) => {
      const entries = Object.entries(raw.Factor[key] || {}).filter(([, value]) => typeof value === "boolean");
      return el("p", "", `${label}：${entries.map(([source, value]) => `${PROVIDERS[source] || source} ${value ? "是" : "否"}`).join("；") || "暂无数据"}`);
    })));
    note(container, "“是”表示至少一个来源标记；机房或代理标记不等同于服务不可用。");
  }
  function media(container, raw) {
    const grid = el("div", "quality-services");
    for (const [key, label] of Object.entries(MEDIA)) {
      const data = raw.Media[key] || {};
      const value = el("span", "quality-service-result");
      value.append(pill(mediaLabel(data), mediaTone(data.Status)));
      grid.append(row(label, value));
    }
    container.append(grid);
    note(container, "展示各服务的检测状态、区域与解锁类型。");
  }
  function mail(container, raw) {
    const data = raw.Mail;
    container.append(row("SMTP · 出站 25 端口", pill(data.Port25 === true ? "可连接" : data.Port25 === false ? "未连接" : "暂无数据", data.Port25 === true ? "good" : "")));
    const counts = data.DNSBlacklist;
    if (counts && Number.isInteger(counts.Total) && counts.Total > 0) {
      container.append(row("黑名单查询", `${counts.Blacklisted ?? "—"} 黑名单 / ${counts.Marked ?? "—"} 标记`));
      note(container, `共 ${counts.Total} 个来源：${counts.Clean ?? "—"} 未列入，${counts.Unknown ?? "—"} 查询失败或拒绝。`);
    } else container.append(row("黑名单查询", pill(selected === "6" ? "IPv6 暂不支持" : "暂无数据")));
    const services = el("div", "quality-mail");
    const names = ["Gmail", "Outlook", "Yahoo", "Apple", "QQ", "MailRU", "AOL", "GMX", "MailCOM", "163", "Sohu", "Sina"];
    names.forEach((name) => services.append(pill(`${name} ${data[name] === true ? "可连接" : data[name] === false ? "未连接" : "未知"}`, data[name] === true ? "good" : "")));
    container.append(services);
    note(container, "仅验证 SMTP 欢迎响应，不发送邮件。超时和网络限制均可能导致未连接。");
  }

  function paint() {
    const result = job?.results?.find((item) => item.family === selected);
    const signature = JSON.stringify([selected, result, job?.status]);
    if (painted === signature) return;
    painted = signature;
    elements.results.replaceChildren();
    TITLES.forEach((title, index) => {
      const card = el("section", "quality-card");
      const heading = el("h2");
      heading.append(el("span", "quality-card-number", String(index + 1).padStart(2, "0")), el("span", "", title));
      card.append(heading);
      if (result?.status === "complete") [basic, types, scores, factors, media, mail][index](card, result.raw);
      else card.append(el("p", "quality-empty", result?.error || (job?.status === "running" ? `正在检测 IPv${selected}…` : "尚未检测")));
      elements.results.append(card);
    });
    elements.switch.hidden = family !== "dual";
    elements.switch.replaceChildren();
    if (family === "dual") for (const version of ["4", "6"]) {
      const item = job?.results?.find((entry) => entry.family === version);
      const button = el("button", "quality-button", `IPv${version}${item ? item.status === "complete" ? " · 已完成" : " · 失败" : ""}`);
      button.type = "button";
      button.setAttribute("aria-pressed", String(selected === version));
      button.addEventListener("click", () => { selected = version; paint(); });
      elements.switch.append(button);
    }
  }
  function updateControls() {
    const running = job?.status === "running";
    const remaining = Math.max(0, Math.ceil((Date.parse(job?.retryAt) - Date.now()) / 1000)) || 0;
    elements.family.disabled = requesting || running;
    elements.start.disabled = requesting || running || remaining > 0;
    elements.start.querySelector("span").textContent = running ? "检测中…" : remaining > 0 ? `${remaining} 秒后可重测` : job?.results?.length ? "重新检测" : "开始检测";
    elements.export.disabled = !job?.results?.some((result) => result.status === "complete");
    elements.results.setAttribute("aria-busy", String(running));
  }
  function render() {
    const running = job?.status === "running";
    elements.status.className = running ? "is-running" : job?.status === "error" ? "is-error" : "";
    const count = job?.results?.length || 0;
    if (running) elements.status.textContent = `正在检测服务器出口 · ${count}/${job.total} 个协议已完成，请稍候。`;
    else if (job?.status === "error") elements.status.textContent = job.results.map((result) => result.error).join("；");
    else if (job?.status === "partial") elements.status.textContent = "部分检测完成，请切换协议查看结果与失败原因。";
    else if (job?.status === "complete") elements.status.textContent = "检测完成 · 数据源未返回的项目显示为暂无数据。";
    else elements.status.textContent = "点击开始检测，查看当前服务器的 IP 质量。";
    elements.time.textContent = job?.finishedAt ? `报告时间 ${new Date(job.finishedAt).toLocaleString("zh-CN", { hour12: false })} · 耗时 ${Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000)} 秒`
      : "完整检测可能需要数分钟";
    updateControls();
    paint();
  }
  async function request(start = false) {
    window.clearTimeout(pollTimer);
    activeController?.abort();
    const id = ++requestId;
    const controller = new AbortController();
    activeController = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    requesting = true;
    updateControls();
    try {
      const response = await fetch(`/api/ip-quality?family=${family}`, {
        method: start ? "POST" : "GET", headers: { Accept: "application/json", ...(start ? { "Content-Type": "application/json" } : {}) },
        cache: "no-store", signal: controller.signal,
      });
      const payload = await response.json();
      if (id !== requestId) return;
      if (!response.ok) throw new Error(payload.error || `检测服务暂不可用（HTTP ${response.status}）`);
      if (!payload || !["idle", "running", "complete", "partial", "error"].includes(payload.status) ||
        (payload.status !== "idle" && (payload.family !== family || !Array.isArray(payload.results)))) {
        throw new Error("检测服务返回了无法识别的数据");
      }
      job = redactJob(payload);
      render();
      if (job.status === "running") pollTimer = window.setTimeout(() => request(), 3000);
    } catch (error) {
      if (id !== requestId) return;
      elements.status.className = "is-error";
      elements.status.textContent = error.name === "AbortError" ? "连接检测服务超时，请稍后重试。" : `无法获取检测结果：${error.message}`;
      // Keep a running server job visible and reconnect without starting another job.
      if (job?.status === "running" || start) pollTimer = window.setTimeout(() => request(), 5000);
    } finally {
      window.clearTimeout(timeout);
      if (id === requestId) { requesting = false; updateControls(); }
    }
  }
  elements.family.addEventListener("change", (event) => {
    family = event.target.value;
    selected = family === "dual" ? "4" : family;
    job = undefined;
    render();
    request();
  });
  elements.start.addEventListener("click", () => request(true));
  elements.export.addEventListener("click", () => {
    if (!job?.results?.some((result) => result.status === "complete")) return;
    const blob = new Blob([JSON.stringify(job, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = el("a");
    link.href = url;
    link.download = `ip-quality-${family}-${job.startedAt.slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  function activate() {
    if (window.location.hash === "#quality" && !initialized) { initialized = true; request(); }
  }
  window.addEventListener("hashchange", activate);
  window.setInterval(updateControls, 1000);
  render();
  activate();
})();
