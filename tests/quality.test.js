"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { text, factorSummary, scoreNumber, mediaTone } = require("../site/quality");

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
