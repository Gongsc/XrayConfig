"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { checkTarget, friendlyError, runChecks } = require("./server");

test("checkTarget reports a reachable response and latency", async () => {
  const target = { id: "test", name: "Test", url: "https://example.com/" };
  const fakeFetch = async () => ({ body: { cancel: async () => {} } });
  const result = await checkTarget(target, fakeFetch);

  assert.equal(result.reachable, true);
  assert.ok(result.latencyMs >= 1);
  assert.equal(result.host, "example.com");
});

test("runChecks preserves the fixed target order", async () => {
  const fakeFetch = async () => ({ body: { cancel: async () => {} } });
  const output = await runChecks(fakeFetch);

  assert.equal(output.results.length, 6);
  assert.deepEqual(output.results.slice(0, 2).map(({ id }) => id), ["baidu", "bilibili"]);
});

test("friendlyError distinguishes timeouts and DNS failures", () => {
  assert.equal(friendlyError({ name: "TimeoutError" }), "连接超时");
  assert.equal(friendlyError({ cause: { code: "ENOTFOUND" } }), "DNS 解析失败");
});
