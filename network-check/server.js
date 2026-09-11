"use strict";

const http = require("node:http");

const LISTEN_PORT = 8080;
const SCHEMA_VERSION = 2;
const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_LIFETIME_MS = 30_000;
const SAMPLE_COUNT = 5;
const TARGETS = Object.freeze([
  { id: "baidu", name: "百度", regionCode: "CN", regionName: "中国大陆", category: "搜索", url: "https://www.baidu.com/" },
  { id: "bilibili", name: "哔哩哔哩", regionCode: "CN", regionName: "中国大陆", category: "流媒体", url: "https://www.bilibili.com/favicon.ico" },
  { id: "weibo", name: "微博", regionCode: "CN", regionName: "中国大陆", category: "社交媒体", url: "https://weibo.com/favicon.ico" },
  { id: "hong-kong-01", name: "香港01", regionCode: "HK", regionName: "香港", category: "新闻", url: "https://www.hk01.com/favicon.ico" },
  { id: "viu", name: "Viu", regionCode: "HK", regionName: "香港", category: "流媒体", url: "https://viu.tv/favicon.ico" },
  { id: "lihkg", name: "LIHKG", regionCode: "HK", regionName: "香港", category: "社交媒体", url: "https://lihkg.com/favicon.ico" },
  { id: "yahoo-japan", name: "Yahoo! JAPAN", regionCode: "JP", regionName: "日本", category: "门户", url: "https://www.yahoo.co.jp/" },
  { id: "niconico", name: "ニコニコ", regionCode: "JP", regionName: "日本", category: "流媒体", url: "https://www.nicovideo.jp/favicon.ico" },
  { id: "line", name: "LINE", regionCode: "JP", regionName: "日本", category: "社交媒体", url: "https://www.line.me/favicon.ico" },
  { id: "google", name: "Google", regionCode: "US", regionName: "美国", category: "搜索", url: "https://www.google.com/generate_204" },
  { id: "youtube", name: "YouTube", regionCode: "US", regionName: "美国", category: "流媒体", url: "https://www.youtube.com/favicon.ico" },
  { id: "netflix", name: "Netflix", regionCode: "US", regionName: "美国", category: "流媒体", url: "https://www.netflix.com/favicon.ico" },
  { id: "x", name: "X", regionCode: "US", regionName: "美国", category: "社交媒体", url: "https://x.com/favicon.ico" },
  { id: "reddit", name: "Reddit", regionCode: "US", regionName: "美国", category: "社交媒体", url: "https://www.reddit.com/favicon.ico" },
  { id: "github", name: "GitHub", regionCode: "US", regionName: "美国", category: "开发服务", url: "https://github.com/favicon.ico" },
  { id: "cloudflare", name: "Cloudflare", regionCode: "US", regionName: "美国", category: "网络服务", url: "https://1.1.1.1/cdn-cgi/trace" },
  { id: "bbc", name: "BBC", regionCode: "GB", regionName: "英国", category: "新闻", url: "https://www.bbc.com/favicon.ico" },
  { id: "itvx", name: "ITVX", regionCode: "GB", regionName: "英国", category: "流媒体", url: "https://www.itv.com/favicon.ico" },
  { id: "spiegel", name: "DER SPIEGEL", regionCode: "DE", regionName: "德国", category: "新闻", url: "https://www.spiegel.de/favicon.ico" },
  { id: "zdf", name: "ZDF", regionCode: "DE", regionName: "德国", category: "流媒体", url: "https://www.zdf.de/favicon.ico" },
  { id: "le-monde", name: "Le Monde", regionCode: "FR", regionName: "法国", category: "新闻", url: "https://www.lemonde.fr/favicon.ico" },
  { id: "france-tv", name: "France.tv", regionCode: "FR", regionName: "法国", category: "流媒体", url: "https://www.france.tv/favicon.ico" },
]);

let cachedResponse;
let cachedAt = 0;
let activeCheck;

function friendlyError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "连接超时";
  if (error?.cause?.code === "ENOTFOUND" || error?.cause?.code === "EAI_AGAIN") {
    return "DNS 解析失败";
  }
  return "无法建立连接";
}

async function checkOnce(target, fetchImpl = fetch) {
  const started = performance.now();
  const host = new URL(target.url).hostname;

  try {
    const response = await fetchImpl(target.url, {
      headers: {
        Accept: "*/*",
        Connection: "close",
        "User-Agent": "server-network-check/1.0",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const latencyMs = Math.max(1, Math.round(performance.now() - started));
    await response.body?.cancel().catch(() => {});
    return {
      id: target.id,
      name: target.name,
      host,
      latencyMs,
      reachable: true,
    };
  } catch (error) {
    return {
      id: target.id,
      name: target.name,
      host,
      reachable: false,
      error: friendlyError(error),
    };
  }
}

async function checkTarget(target, fetchImpl = fetch, sampleCount = SAMPLE_COUNT) {
  const samples = [];
  let lastError = "无法建立连接";

  for (let attempt = 0; attempt < sampleCount; attempt += 1) {
    const sample = await checkOnce(target, fetchImpl);
    if (sample.reachable) samples.push(sample.latencyMs);
    else lastError = sample.error;
  }

  const base = {
    id: target.id,
    name: target.name,
    host: new URL(target.url).hostname,
    regionCode: target.regionCode,
    regionName: target.regionName,
    category: target.category,
    attempts: sampleCount,
    successes: samples.length,
  };

  if (samples.length === 0) {
    return { ...base, reachable: false, error: lastError };
  }

  return {
    ...base,
    reachable: true,
    latencyMs: Math.round(samples.reduce((sum, latency) => sum + latency, 0) / samples.length),
  };
}

async function runChecks(fetchImpl = fetch) {
  const results = await Promise.all(TARGETS.map((target) => checkTarget(target, fetchImpl)));
  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    sampleCount: SAMPLE_COUNT,
    results,
  };
}

async function getChecks() {
  if (cachedResponse && Date.now() - cachedAt < CACHE_LIFETIME_MS) return cachedResponse;
  if (!activeCheck) {
    activeCheck = runChecks().then((output) => {
      cachedResponse = output;
      cachedAt = Date.now();
      return output;
    }).finally(() => {
      activeCheck = undefined;
    });
  }
  return activeCheck;
}

function sendJSON(response, status, payload) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function createServer() {
  return http.createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("ok\n");
      return;
    }

    if (request.url !== "/check") {
      sendJSON(response, 404, { error: "not found" });
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendJSON(response, 405, { error: "method not allowed" });
      return;
    }

    try {
      sendJSON(response, 200, await getChecks());
    } catch {
      sendJSON(response, 503, { error: "network check unavailable" });
    }
  });
}

async function runHealthcheck() {
  try {
    const response = await fetch(`http://127.0.0.1:${LISTEN_PORT}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    process.exit(response.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}

if (require.main === module) {
  if (process.argv[2] === "healthcheck") {
    runHealthcheck();
  } else {
    const server = createServer();
    server.requestTimeout = 12_000;
    server.headersTimeout = 5_000;
    server.listen(LISTEN_PORT, "0.0.0.0", () => {
      console.log(`network check service listening on :${LISTEN_PORT}`);
    });
  }
}

module.exports = {
  SAMPLE_COUNT,
  SCHEMA_VERSION,
  TARGETS,
  checkOnce,
  checkTarget,
  createServer,
  friendlyError,
  runChecks,
};
