"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { FAMILIES, createQualityService } = require("./ip-quality");

const LISTEN_PORT = 8080;
const SCHEMA_VERSION = 3;
const REQUEST_TIMEOUT_MS = 8_000;
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

function friendlyError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "连接超时";
  if (error?.cause?.code === "ENOTFOUND" || error?.cause?.code === "EAI_AGAIN") {
    return "DNS 解析失败";
  }
  return "无法建立连接";
}

async function checkOnce(target, fetchImpl = fetch, signal) {
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
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

async function checkTarget(
  target,
  fetchImpl = fetch,
  sampleCount = SAMPLE_COUNT,
  onSample = () => {},
  signal,
) {
  const samples = [];
  let lastError = "无法建立连接";

  for (let attempt = 0; attempt < sampleCount; attempt += 1) {
    const sample = await checkOnce(target, fetchImpl, signal);
    if (sample.reachable) samples.push(sample.latencyMs);
    else lastError = sample.error;
    onSample({
      targetId: target.id,
      sampleIndex: attempt + 1,
      reachable: sample.reachable,
      ...(sample.reachable ? { latencyMs: sample.latencyMs } : { error: sample.error }),
    });
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

async function runChecks(fetchImpl = fetch, onSample = () => {}, signal) {
  const results = await Promise.all(
    TARGETS.map((target) => checkTarget(target, fetchImpl, SAMPLE_COUNT, onSample, signal)),
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    sampleCount: SAMPLE_COUNT,
    results,
  };
}

function sendJSON(response, status, payload) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function streamEvent(response, payload) {
  if (!response.destroyed && !response.writableEnded) {
    response.write(`${JSON.stringify(payload)}\n`);
  }
}

function publicTarget(target) {
  return {
    id: target.id,
    name: target.name,
    host: new URL(target.url).hostname,
    regionCode: target.regionCode,
    regionName: target.regionName,
    category: target.category,
  };
}

function createServer({ quality = createQualityService() } = {}) {
  const server = http.createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("ok\n");
      return;
    }

    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/quality/source" && request.method === "GET") {
      const archive = path.join(__dirname, "ip-quality-source.tar.gz");
      if (!fs.existsSync(archive)) {
        sendJSON(response, 503, { error: "源码包未生成，请重新构建服务镜像" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/gzip", "X-Content-Type-Options": "nosniff",
        "Content-Disposition": 'attachment; filename="ip-quality-source.tar.gz"',
      });
      fs.createReadStream(archive).on("error", () => response.destroy()).pipe(response);
      return;
    }
    if (url.pathname === "/quality") {
      const family = url.searchParams.get("family") || "4";
      if (!FAMILIES.has(family) || [...url.searchParams.keys()].some((key) => key !== "family") ||
        url.searchParams.getAll("family").length > 1) {
        sendJSON(response, 400, { error: "仅支持 IPv4、IPv6 或双栈检测" });
        return;
      }
      if (request.method === "GET") sendJSON(response, 200, quality.get(family));
      else if (request.method === "POST") {
        if (request.headers["sec-fetch-site"] === "cross-site" ||
          request.headers["content-type"] !== "application/json" ||
          Number(request.headers["content-length"] || 0) !== 0 || request.headers["transfer-encoding"]) {
          sendJSON(response, 400, { error: "不接受跨站请求或自定义检测参数" });
          return;
        }
        const { statusCode, body, retryAfterSeconds } = quality.start(family);
        if (statusCode === 429) response.setHeader("Retry-After", String(retryAfterSeconds || 30));
        sendJSON(response, statusCode, body);
      } else {
        response.setHeader("Allow", "GET, POST");
        sendJSON(response, 405, { error: "method not allowed" });
      }
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

    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    response.flushHeaders();
    streamEvent(response, {
      type: "meta",
      schemaVersion: SCHEMA_VERSION,
      sampleCount: SAMPLE_COUNT,
      targets: TARGETS.map(publicTarget),
    });

    try {
      const output = await runChecks(
        fetch,
        (sample) => streamEvent(response, { type: "sample", ...sample }),
        controller.signal,
      );
      streamEvent(response, { type: "complete", ...output });
    } catch {
      streamEvent(response, { type: "error", message: "network check unavailable" });
    }
    response.end();
  });
  server.on("close", () => quality.close());
  return server;
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
  publicTarget,
  runChecks,
};
