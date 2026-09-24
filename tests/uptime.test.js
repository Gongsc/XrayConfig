"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { once } = require("node:events");
const { createServer } = require("../network-check/server");
const { formatUptime } = require("../site/uptime");

test("uptime displays day and clock rollovers", () => {
  assert.equal(formatUptime(0), "已运行 0 天 0 小时 0 分 0 秒");
  assert.equal(formatUptime(86399), "已运行 0 天 23 小时 59 分 59 秒");
  assert.equal(formatUptime(86400), "已运行 1 天 0 小时 0 分 0 秒");
  assert.equal(formatUptime(90061.9), "已运行 1 天 1 小时 1 分 1 秒");
});

test("uptime endpoint reads fresh system uptime and does not cache responses", async (t) => {
  let seconds = 90061.9;
  const server = createServer({ uptime: () => seconds });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/uptime`;
  const response = await fetch(url);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { uptimeSeconds: 90061 });
  seconds = 3;
  assert.deepEqual(await (await fetch(url)).json(), { uptimeSeconds: 3 });
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
});
