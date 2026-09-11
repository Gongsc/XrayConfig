"use strict";

const http = require("node:http");

const LISTEN_PORT = 8080;
const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_LIFETIME_MS = 15_000;
const TARGETS = Object.freeze([
  { id: "baidu", name: "百度", url: "https://www.baidu.com/" },
  { id: "bilibili", name: "哔哩哔哩", url: "https://www.bilibili.com/favicon.ico" },
  { id: "bing", name: "Bing", url: "https://www.bing.com/favicon.ico" },
  { id: "github", name: "GitHub", url: "https://github.com/favicon.ico" },
  { id: "cloudflare", name: "Cloudflare", url: "https://1.1.1.1/cdn-cgi/trace" },
  { id: "google", name: "Google", url: "https://www.google.com/generate_204" },
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

async function checkTarget(target, fetchImpl = fetch) {
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

async function runChecks(fetchImpl = fetch) {
  const results = await Promise.all(TARGETS.map((target) => checkTarget(target, fetchImpl)));
  return { checkedAt: new Date().toISOString(), results };
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

module.exports = { TARGETS, checkTarget, createServer, friendlyError, runChecks };
