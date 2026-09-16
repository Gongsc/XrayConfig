"use strict";

const { spawn } = require("node:child_process");
const { isIP } = require("node:net");
const path = require("node:path");
const { checkMail, checkDNSBL } = require("./quality-probes");
const { publicReport } = require("./quality-report");

const CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 60_000;
const SCRIPT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const FAMILIES = new Set(["4", "6", "dual"]);

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
      if (code === 40 || code === 60) { reject(new Error(`未获取到 IPv${family} 出口，请检查服务器网络`)); return; }
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

function createQualityService({ runner = runFamily, now = Date.now } = {}) {
  const jobs = new Map();
  let active;
  const controller = new AbortController();
  const snapshot = (job) => job ? JSON.parse(JSON.stringify(job)) : { status: "idle" };
  return {
    get(family) { return snapshot(jobs.get(family)); },
    start(family) {
      if (!FAMILIES.has(family)) return { statusCode: 400, body: { error: "无效的 IP 协议" } };
      const existing = jobs.get(family);
      if (existing && (existing.status === "running" || now() < Date.parse(existing.retryAt))) {
        return { statusCode: existing.status === "running" ? 202 : 200, body: snapshot(existing) };
      }
      if (active) return { statusCode: 429, body: { error: "服务器正在执行其他 IP 检测，请稍后重试" } };
      const job = {
        schemaVersion: 1, family, status: "running", startedAt: new Date(now()).toISOString(),
        results: [], total: family === "dual" ? 2 : 1,
      };
      jobs.set(family, job);
      active = job;
      (async () => {
        for (const version of family === "dual" ? ["4", "6"] : [family]) {
          const started = now();
          try {
            const raw = publicReport(await runner(version, controller.signal));
            job.results.push({ family: version, status: "complete", raw,
              checkedAt: new Date(now()).toISOString(), durationMs: now() - started });
          } catch (error) {
            job.results.push({ family: version, status: "error",
              error: error.message || "检测失败", durationMs: now() - started });
          }
        }
        const successes = job.results.filter((result) => result.status === "complete").length;
        job.status = successes === job.total ? "complete" : successes ? "partial" : "error";
        job.finishedAt = new Date(now()).toISOString();
        job.retryAt = new Date(now() + (successes ? CACHE_MS : FAILURE_CACHE_MS)).toISOString();
        active = undefined;
      })();
      return { statusCode: 202, body: snapshot(job) };
    },
    close() { controller.abort(); },
  };
}

module.exports = { CACHE_MS, FAMILIES, createQualityService, parseScriptOutput, runScript, runFamily };
