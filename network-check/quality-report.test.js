"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { maskIP, publicReport, primeRegion } = require("./quality-report");

test("public reports mask both address families and embedded address copies without altering probe input", () => {
  for (const ip of ["203.0.113.42", "2001:db8::42", "::ffff:192.0.2.1"]) {
    const raw = { Head: { IP: ip }, Info: { URL: `https://example.test/${encodeURIComponent(ip)}`, Note: `IP=${ip}` }, Media: {} };
    const report = publicReport(raw);
    assert.equal(report.Head.IP, maskIP(ip));
    assert.ok(!JSON.stringify(report).includes(ip));
    assert.ok(!JSON.stringify(report).includes(encodeURIComponent(ip)));
    assert.equal(raw.Head.IP, ip);
  }
  assert.equal(maskIP("203.0.113.42"), "203.0.*.*");
  assert.equal(maskIP("2001:db8::42"), "2001:db8:*:*:*:*:*:*");
});

test("regions exclude markup, damaged ANSI and unexpected non-country strings", () => {
  const report = publicReport({ Head: { IP: "203.0.113.42" }, Media: {
    Netflix: { Region: "us", Status: "解锁", Type: "原生" },
    Youtube: { Region: "�1mCN�2m" }, AmazonPrimeVideo: { Region: "},Program:{dataType:a.MinervaValueDataType.STRING,val:o?" },
  } });
  assert.equal(report.Media.Netflix.Region, "US");
  assert.equal(report.Media.Youtube.Region, "");
  assert.equal(report.Media.AmazonPrimeVideo.Region, "");
});

test("Prime Video extracts only a territory string or typed territory value", () => {
  assert.equal(primeRegion('{"currentTerritory":"US","Program":{"title":"test"}}'), "US");
  assert.equal(primeRegion('currentTerritory:{dataType:a.MinervaValueDataType.STRING,val:"JP"},Program:{}'), "JP");
  assert.equal(primeRegion('{"currentTerritory":{"dataType":"String","value":"DE"}}'), "DE");
  assert.equal(primeRegion('{"currentTerritory":null,"Program":{"val":"US"}}'), "");
  assert.equal(primeRegion('currentTerritory:{dataType:a.MinervaValueDataType.STRING,val:o?},Program:{val:"US"}'), "");
  assert.equal(primeRegion('{"currentTerritory":"US"},{"currentTerritory":"GB"}'), "");
  assert.equal(primeRegion('<html>Access denied</html>'), "");
});
