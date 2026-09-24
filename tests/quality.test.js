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

test("report tabs share protocol reports across detection modes and export the selected protocol", async () => {
  const vm = require("node:vm");
  const fs = require("node:fs");
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.attributes = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    querySelector() { return this.label ||= new Element(); }
    click() {}
    remove() {}
  }
  const elements = Object.fromEntries(["results", "status", "time", "start", "family", "export", "report-switch"].map((key) => [`#quality-${key}`, new Element()]));
  const raw = { Head: { IP: "203.0.*.*" }, Info: {}, Type: {}, Score: {}, Factor: {}, Media: {}, Mail: {} };
  const reports = Object.fromEntries(["4", "6"].map((family) => [family, {
    family, status: "complete", total: 1, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z",
    results: [{ family, status: "complete", raw }],
  }]));
  let exported;
  vm.runInNewContext(fs.readFileSync(require.resolve("../site/quality"), "utf8"), {
    document: { querySelector: (key) => elements[key], createElement: () => new Element(), body: new Element() },
    window: { location: { hash: "#quality" }, addEventListener() {}, setTimeout() {}, clearTimeout() {}, setInterval() {} },
    AbortController, Blob,
    URL: { createObjectURL(blob) { exported = blob; return "blob:test"; }, revokeObjectURL() {} },
    fetch: async (url) => ({ ok: true, json: async () => {
      const family = new URL(url, "http://test").searchParams.get("family");
      return family === "dual" ? { ...reports["4"], family: "dual", total: 2, results: [...reports["4"].results, ...reports["6"].results] } : reports[family];
    } }),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  const tabs = elements["#quality-report-switch"];
  assert.equal(tabs.hidden, false);
  assert.equal(tabs.children.length, 2);
  tabs.children[1].listeners.click();
  elements["#quality-export"].listeners.click();
  assert.equal(JSON.parse(await exported.text()).family, "6");
  elements["#quality-family"].listeners.change({ target: { value: "dual" } });
  await settle();
  assert.equal(tabs.children.length, 2);
  assert.equal(tabs.children[1].attributes["aria-pressed"], "true");
  elements["#quality-export"].listeners.click();
  const downloaded = JSON.parse(await exported.text());
  assert.equal(downloaded.family, "6");
  assert.equal(downloaded.total, 1);
  assert.equal(downloaded.results.length, 1);
});
