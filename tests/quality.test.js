"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { text, factorSummary, scoreNumber, mediaTone, mediaLabel, redactJob } = require("../site/quality");

test("frontend preserves genuine zero scores without classifying missing data or failed media as good", () => {
  assert.equal(text("null"), "");
  assert.equal(text(false), "false");
  assert.equal(scoreNumber("0"), 0);
  for (const value of [null, "null", "", "—", "-1", "101"]) assert.equal(scoreNumber(value), null);
  assert.deepEqual(factorSummary({ a: null, b: "false" }), { label: "暂无数据", tone: "" });
  assert.equal(factorSummary({ a: true, b: false }).label, "是 · 1/2 来源");
  assert.equal(mediaTone("失败"), "");
  assert.equal(mediaTone("解锁"), "good");
  assert.equal(mediaTone("仅自制"), "warning");
});

test("media combines status, validated region and type in one label", () => {
  assert.equal(mediaLabel({ Status: "解锁", Region: "US", Type: "原生" }), "解锁 · US · 原生");
  assert.equal(mediaLabel({ Status: "中国", Region: "�1mCN�2m" }), "中国");
  assert.equal(mediaLabel({ Status: "区域待确认", Region: "},Program:{dataType:STRING}" }), "区域待确认");
});

test("older API responses are redacted before display and JSON export", () => {
  const payload = { results: [{ raw: { Head: { IP: "203.0.113.42" }, Info: { Note: "203.0.113.42" } } },
    { raw: { Head: { IP: "2001:db8::42" }, Info: { URL: "https://example.test/2001%3Adb8%3A%3A42" } } }] };
  const safe = redactJob(payload);
  assert.equal(safe.results[0].raw.Head.IP, "203.0.*.*");
  assert.ok(!JSON.stringify(safe).includes("203.0.113.42"));
  assert.ok(!JSON.stringify(safe).includes("2001%3Adb8%3A%3A42"));
  assert.equal(payload.results[0].raw.Head.IP, "203.0.113.42");
  assert.deepEqual(redactJob(safe), safe);
});
