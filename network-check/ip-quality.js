"use strict";

const { spawn } = require("node:child_process");
const { isIP } = require("node:net");
const path = require("node:path");
const { checkMail, checkDNSBL } = require("./quality-probes");
const { publicReport } = require("./quality-report");

const CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 60_000;
const DEFAULT_MIN_INTERVAL_SECONDS = 5 * 60;
const SCRIPT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const FAMILIES = new Set(["4", "6", "dual"]);

function parseMinIntervalSeconds(value) {
  if (value === undefined || value === "") return DEFAULT_MIN_INTERVAL_SECONDS;
  if (!/^(0|[1-9]\d*)$/.test(String(value)) || Number(value) > 86400) {
    throw new Error("IP_QUALITY_MIN_INTERVAL_SECONDS 必须是 0 到 86400 的整数");
  }
  return Number(value);
}

function parseScriptOutput(stdout, family) {
  const raw = JSON.parse(stdout.trim());
  if (!raw || isIP(raw.Head?.IP) !== Number(family) ||
    !["Info", "Type", "Score", "Factor", "Media", "Mail"].every((key) =>
      raw[key] && typeof raw[key] === "object" && !Array.isArray(raw[key]))) {
    throw new Error("检测脚本返回了无效报告");
  }
  return raw;
}

function runScript(family, { spawnImpl = spawn, timeoutMs = SCRIPT_TIMEOUT_MS, signal } = {}) {
  if (!["4", "6"].includes(String(family))) return Promise.reject(new Error("无效的 IP 协议"));
  return new Promise((resolve, reject) => {
    const child = spawnImpl("bash", [path.join(__dirname, "ip-quality.sh"), String(family)], {
      cwd: "/tmp", detached: true, stdio: ["ignore", "pipe", "ignore"],
      // Do not inherit host proxy settings, credentials or user shell startup files.
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TERM: "dumb" },
    });
    let stdout = "";
    let size = 0;
    let failure;
    function terminate(message) {
      failure ||= new Error(message);
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }
    const timer = setTimeout(() => terminate("检测超时，请稍后重试"), timeoutMs);
    const abort = () => terminate("检测已停止");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    function cleanup() { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_OUTPUT_BYTES) terminate("检测报告超出大小限制");
      else stdout += chunk.toString("utf8");
    });
    child.once("error", () => { cleanup(); reject(new Error("检测引擎无法启动，请重新构建检测服务")); });
    child.once("close", (code) => {
      cleanup();
      if (failure) { reject(failure); return; }
      if (code === 40) { reject(new Error("检测容器没有可用的 IPv4 公网出口")); return; }
      if (code === 60) { reject(new Error("检测容器无法通过 IPv6 连接公网，请检查 Docker IPv6 网络和宿主机出站路由")); return; }
      if (code !== 0) { reject(new Error("检测引擎执行失败，请检查服务依赖与网络")); return; }
      try { resolve(parseScriptOutput(stdout, family)); }
      catch { reject(new Error("检测报告解析失败，请稍后重试")); }
    });
  });
}

async function runFamily(family, signal) {
  const raw = await runScript(family, { signal });
  const [mail, blacklist] = await Promise.all([
    checkMail(Number(family)).catch(() => ({ Port25: null })),
    checkDNSBL(raw.Head.IP).catch(() => null),
  ]);
  raw.Mail = { ...mail, DNSBlacklist: blacklist };
  return raw;
}

function createQualityService({ runner = runFamily, now = Date.now,
  minIntervalMs = parseMinIntervalSeconds(process.env.IP_QUALITY_MIN_INTERVAL_SECONDS) * 1000 } = {}) {
  const jobs = new Map();
  let active;
  const controller = new AbortController();
  const versions = (family) => family === "dual" ? ["4", "6"] : [family];
  const nextAllowedAt = (family) => Math.max(0, ...versions(family).map((version) => {
    const job = jobs.get(version);
    return job?.finishedAt ? Math.max(Date.parse(job.retryAt), Date.parse(job.finishedAt) + minIntervalMs) : 0;
  }));
  const snapshot = (family) => {
    let job = jobs.get(family);
    if (family === "dual") {
      const reports = versions(family).map((version) => jobs.get(version)).filter(Boolean);
      if (reports.length) {
        const results = reports.flatMap((report) => report.results);
        const successes = results.filter((result) => result.status === "complete").length;
        const running = reports.some((report) => report.status === "running");
        job = { schemaVersion: 1, family, total: 2, results,
          status: running ? "running" : successes === 2 ? "complete" : successes ? "partial" : "error",
          startedAt: reports.map((report) => report.startedAt).sort()[0],
          ...(!running && { finishedAt: reports.map((report) => report.finishedAt).sort().at(-1) }) };
      }
    }
    const copy = job ? JSON.parse(JSON.stringify(job)) : { status: "idle" };
    const retryAt = nextAllowedAt(family);
    if (retryAt > now()) copy.retryAt = new Date(retryAt).toISOString();
    else delete copy.retryAt;
    return copy;
  };
  return {
    get(family) { return snapshot(family); },
    start(family) {
      if (!FAMILIES.has(family)) return { statusCode: 400, body: { error: "无效的 IP 协议" } };
      if (active === family || (family !== "dual" && jobs.get(family)?.status === "running")) {
        return { statusCode: 202, body: snapshot(family) };
      }
      const existing = jobs.get(family);
      if (existing && now() < Date.parse(existing.retryAt)) {
        return { statusCode: 200, body: snapshot(family) };
      }
      if (active) return { statusCode: 429, body: { error: "服务器正在执行其他 IP 检测，请稍后重试" } };
      const retryAt = nextAllowedAt(family);
      if (now() < retryAt) {
        const retryAfterSeconds = Math.ceil((retryAt - now()) / 1000);
        return { statusCode: 429, retryAfterSeconds,
          body: { error: `检测过于频繁，请在 ${retryAfterSeconds} 秒后重试`,
            retryAt: new Date(retryAt).toISOString() } };
      }
      for (const version of versions(family)) {
        jobs.set(version, { schemaVersion: 1, family: version, status: "running",
          startedAt: new Date(now()).toISOString(), results: [], total: 1 });
      }
      active = family;
      (async () => {
        for (const version of versions(family)) {
          const job = jobs.get(version);
          const started = now();
          job.startedAt = new Date(started).toISOString();
          try {
            const raw = publicReport(await runner(version, controller.signal));
            job.results.push({ family: version, status: "complete", raw,
              checkedAt: new Date(now()).toISOString(), durationMs: now() - started });
          } catch (error) {
            job.results.push({ family: version, status: "error",
              error: error.message || "检测失败", durationMs: now() - started });
          }
          const finished = now();
          job.status = job.results[0].status;
          job.finishedAt = new Date(finished).toISOString();
          job.retryAt = new Date(finished + (job.status === "complete" ? CACHE_MS : FAILURE_CACHE_MS)).toISOString();
        }
        active = undefined;
      })();
      return { statusCode: 202, body: snapshot(family) };
    },
    close() { controller.abort(); },
  };
}

module.exports = { CACHE_MS, DEFAULT_MIN_INTERVAL_SECONDS, FAMILIES, createQualityService,
  parseMinIntervalSeconds, parseScriptOutput, runScript, runFamily };
