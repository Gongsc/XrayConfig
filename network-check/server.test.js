"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  SAMPLE_COUNT,
  SCHEMA_VERSION,
  TARGETS,
  checkTarget,
  friendlyError,
  runChecks,
} = require("./server");

test("checkTarget reports a reachable response and latency", async () => {
  let calls = 0;
  const target = {
    id: "test",
    name: "Test",
    regionCode: "XX",
    regionName: "测试地区",
    category: "测试",
    url: "https://example.com/",
  };
  const fakeFetch = async () => {
    calls += 1;
    return { body: { cancel: async () => {} } };
  };
  const result = await checkTarget(target, fakeFetch);

  assert.equal(result.reachable, true);
  assert.ok(result.latencyMs >= 1);
  assert.equal(result.host, "example.com");
  assert.equal(result.attempts, 5);
  assert.equal(result.successes, 5);
  assert.equal(calls, 5);
});

test("checkTarget averages successful samples and keeps failure count", async () => {
  let calls = 0;
  const target = {
    id: "partial",
    name: "Partial",
    regionCode: "XX",
    regionName: "测试地区",
    category: "测试",
    url: "https://example.com/",
  };
  const fakeFetch = async () => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error("failed"), { cause: { code: "ENOTFOUND" } });
    return { body: { cancel: async () => {} } };
  };
  const result = await checkTarget(target, fakeFetch);

  assert.equal(result.reachable, true);
  assert.equal(result.attempts, 5);
  assert.equal(result.successes, 3);
});

test("runChecks preserves the fixed target order", async () => {
  const fakeFetch = async () => ({ body: { cancel: async () => {} } });
  const samples = [];
  const output = await runChecks(fakeFetch, (sample) => samples.push(sample));

  assert.equal(output.schemaVersion, SCHEMA_VERSION);
  assert.equal(output.sampleCount, SAMPLE_COUNT);
  assert.equal(output.results.length, TARGETS.length);
  assert.equal(TARGETS.length, 22);
  assert.deepEqual(output.results.slice(0, 2).map(({ id }) => id), ["baidu", "bilibili"]);
  assert.deepEqual([...new Set(output.results.map(({ regionCode }) => regionCode))], [
    "CN", "HK", "JP", "US", "GB", "DE", "FR",
  ]);
  assert.equal(samples.length, TARGETS.length * SAMPLE_COUNT);
  assert.deepEqual(
    samples.filter(({ targetId }) => targetId === "baidu").map(({ sampleIndex }) => sampleIndex),
    [1, 2, 3, 4, 5],
  );
});

test("friendlyError distinguishes timeouts and DNS failures", () => {
  assert.equal(friendlyError({ name: "TimeoutError" }), "连接超时");
  assert.equal(friendlyError({ cause: { code: "ENOTFOUND" } }), "DNS 解析失败");
});
