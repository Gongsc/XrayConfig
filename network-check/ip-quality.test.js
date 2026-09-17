"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { CACHE_MS, createQualityService, parseMinIntervalSeconds, parseScriptOutput, runScript } = require("./ip-quality");
const { checkMail, checkDNSBL, classifyDNSBL } = require("./quality-probes");
const { createServer } = require("./server");

const fixture = (family = "4") => ({
  Head: { IP: family === "4" ? "203.0.113.42" : "2001:db8::42", Version: "test" },
  Info: { ASN: "64500", Organization: "测试组织" },
  Type: { Usage: { IPinfo: "机房" } }, Score: { IPQS: "0", SCAMALYTICS: "null" },
  Factor: { Proxy: { IPinfo: false, ipregistry: null } },
  Media: { Netflix: { Status: "失败", Region: "" } },
  Mail: { Port25: null, DNSBlacklist: null },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("bundled shell adapter serializes the actual IPQS field and strips ANSI without network calls", () => {
  const adapter = fs.readFileSync(path.join(__dirname, "ip-quality.sh"), "utf8")
    .split("\nmode_no=1")[0].replace(/^QUALITY_DIR=.*$/m, 'QUALITY_DIR="$IPQUALITY_TEST_DIR"');
  const script = `${adapter}\n
mode_no=1; mode_json=1; mode_privacy=1; fullIP=1; mode_lite=0; YY=cn
set_language
IP=203.0.113.42
ipqs[score]=17
ipapi[ipqs]=99
ipinfo[susetype]="\${Font_Green}机房\${Font_Suffix}"
youtube[uregion]="  \${Font_Red}[CN]\${Font_Green}   "
smail[local]=2
services=()
ipjson='{"Head":{},"Info":{},"Type":{},"Score":{},"Factor":{},"Media":{},"Mail":{}}'
save_json
printf '%s' "$ipjson"
`;
  const result = spawnSync("bash", ["-c", script, "test", "4"], {
    env: { ...process.env, IPQUALITY_TEST_DIR: __dirname }, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const raw = parseScriptOutput(result.stdout, "4");
  assert.equal(raw.Score.IPQS, "17");
  assert.equal(raw.Type.Usage.IPinfo, "机房");
  assert.equal(raw.Media.Youtube.Region, "CN");
});

test("upstream parser preserves zero/false/null and rejects wrong IP family or shape", () => {
  const raw = fixture();
  assert.deepEqual(parseScriptOutput(`\r\n${JSON.stringify(raw)}\n`, "4"), raw);
  assert.throws(() => parseScriptOutput(JSON.stringify(raw), "6"));
  assert.throws(() => parseScriptOutput('{"Head":{"IP":"203.0.113.42"}}', "4"));
  assert.throws(() => parseScriptOutput("ERROR", "4"));
});

test("one shared job runs once; cached POSTs cannot trigger additional probes", async () => {
  let calls = 0;
  let clock = 1000;
  let finish;
  const service = createQualityService({ now: () => clock, runner: () => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  } });
  assert.equal(service.get("4").status, "idle");
  assert.equal(service.start("4").statusCode, 202);
  assert.equal(service.start("4").statusCode, 202);
  assert.equal(service.start("6").statusCode, 429);
  assert.equal(calls, 1);
  finish(fixture());
  await tick();
  assert.equal(service.start("4").statusCode, 200);
  assert.equal(calls, 1);
  const copy = service.get("4");
  copy.results[0].raw.Score.IPQS = "100";
  assert.equal(service.get("4").results[0].raw.Score.IPQS, "0");
  clock += CACHE_MS + 1;
  assert.equal(service.start("4").statusCode, 202);
  assert.equal(calls, 2);
  finish(fixture());
  await tick();
});

test("dual-stack keeps an IPv4 report when IPv6 fails and retries failures after cooldown", async () => {
  let clock = 0;
  const calls = [];
  const service = createQualityService({ now: () => clock, minIntervalMs: 0, runner: async (family) => {
    calls.push(family);
    if (family === "6") throw new Error("无 IPv6 出口");
    return fixture();
  } });
  service.start("dual");
  await tick();
  assert.deepEqual(calls, ["4", "6"]);
  const job = service.get("dual");
  assert.equal(job.status, "partial");
  assert.equal(job.results[0].raw.Head.IP, "203.0.*.*");
  assert.equal(job.results[1].error, "无 IPv6 出口");
  service.start("6");
  await tick();
  assert.equal(service.start("6").statusCode, 200);
  clock = 60001;
  assert.equal(service.start("6").statusCode, 202);
  await tick();
  assert.equal(service.start("4; id").statusCode, 400);
});

test("global interval limits new probes across families while cached reports stay readable", async () => {
  let clock = 1000;
  let calls = 0;
  let finish;
  const service = createQualityService({ now: () => clock, minIntervalMs: 300_000,
    runner: () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); } });
  assert.equal(service.start("4").statusCode, 202);
  clock = 121000;
  finish(fixture());
  await tick();
  assert.equal(service.start("4").statusCode, 200);
  const limited = service.start("6");
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.retryAfterSeconds, 300);
  assert.equal(limited.body.retryAt, new Date(421000).toISOString());
  assert.equal(service.get("6").retryAt, limited.body.retryAt);
  assert.equal(calls, 1);
  clock = 421000;
  assert.equal(service.start("6").statusCode, 202);
  finish(fixture("6"));
  await tick();
  assert.equal(calls, 2);
});

test("minimum interval accepts only bounded whole seconds", () => {
  assert.equal(parseMinIntervalSeconds(undefined), 300);
  assert.equal(parseMinIntervalSeconds("0"), 0);
  assert.equal(parseMinIntervalSeconds("86400"), 86400);
  for (const value of ["-1", "1.5", "abc", "86401", " 30", "1e3"]) {
    assert.throws(() => parseMinIntervalSeconds(value), /IP_QUALITY_MIN_INTERVAL_SECONDS/);
  }
});

test("runner uses argument arrays, isolated environment, and decodes split UTF-8", async () => {
  let invocation;
  const raw = fixture();
  const output = JSON.stringify(raw);
  const result = await runScript("4", { spawnImpl: (cmd, args, options) => {
    invocation = { cmd, args, options };
    return spawn(process.execPath, ["-e", `const b=Buffer.from(${JSON.stringify(output)});let i=0;const t=setInterval(()=>{if(i<b.length)process.stdout.write(b.subarray(i,i+=1));else clearInterval(t)},1)`], options);
  } });
  assert.deepEqual(result, raw);
  assert.equal(invocation.cmd, "bash");
  assert.equal(invocation.args.at(-1), "4");
  assert.equal(invocation.options.shell, undefined);
  assert.equal(invocation.options.env.HTTP_PROXY, undefined);
  assert.equal(invocation.options.env.BASH_ENV, undefined);
  await assert.rejects(runScript("4;id"), /无效/);
});

test("runner handles engine absence, exit status, timeout and malformed output", async () => {
  const runNode = (code, timeoutMs = 1000) => runScript("6", {
    timeoutMs, spawnImpl: (_cmd, _args, opts) => spawn(process.execPath, ["-e", code], opts),
  });
  await assert.rejects(runNode("process.exit(60)"), /未获取到 IPv6/);
  await assert.rejects(runNode("console.log('not JSON')"), /解析失败/);
  await assert.rejects(runNode("setInterval(()=>{},1000)", 60), /超时/);
  await assert.rejects(runScript("4", { spawnImpl: (_cmd, _args, opts) => spawn("/nonexistent/engine", [], opts) }), /无法启动/);
});

test("DNSBL distinguishes negative answers, listed addresses, blocked resolvers and timeouts", async () => {
  assert.equal(classifyDNSBL(null, { code: "ENOTFOUND" }), "Clean");
  assert.equal(classifyDNSBL(null, { code: "ETIMEOUT" }), "Unknown");
  assert.equal(classifyDNSBL(["127.255.255.254"]), "Unknown");
  assert.equal(classifyDNSBL(["192.0.2.1"]), "Unknown");
  assert.equal(classifyDNSBL(["127.0.0.2"]), "Blacklisted");
  assert.equal(classifyDNSBL(["127.0.0.4"]), "Marked");
  const summary = await checkDNSBL("203.0.113.42", { resolve4: async (host) => {
    assert.ok(host.startsWith("42.113.0.203."));
    if (host.endsWith("clean.test")) throw Object.assign(new Error(), { code: "ENOTFOUND" });
    if (host.endsWith("error.test")) throw Object.assign(new Error(), { code: "ETIMEOUT" });
    return ["127.0.0.2"];
  } }, ["clean.test", "listed.test", "error.test"]);
  assert.deepEqual(summary, { Total: 3, Clean: 1, Marked: 0, Blacklisted: 1, Unknown: 1 });
  assert.equal(await checkDNSBL("2001:db8::42"), null);
});

test("SMTP selects preferred MX and preserves unknown DNS results for the selected family", async () => {
  const mail = await checkMail(6, { resolveMx: async (host) => {
    if (host === "gmail.com") throw new Error("DNS failure");
    return [{ priority: 20, exchange: "second.test" }, { priority: 10, exchange: "first.test" }];
  } }, async (host, family) => {
    assert.equal(host, "first.test");
    assert.equal(family, 6);
    return true;
  });
  assert.equal(mail.Gmail, null);
  assert.equal(mail.Outlook, true);
  assert.equal(mail.Port25, true);
});

test("HTTP validates protocols and methods; GET never starts a probe; POST shares the job", async (t) => {
  let calls = 0;
  const quality = createQualityService({ runner: async () => { calls += 1; return fixture(); } });
  const server = createServer({ quality });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = await fetch(`${base}/quality?family=4`);
  assert.equal((await get.json()).status, "idle");
  assert.equal(calls, 0);
  for (const query of ["family=4&target=localhost", "family=4&family=6", "family=4%3Bid"]) {
    assert.equal((await fetch(`${base}/quality?${query}`)).status, 400);
  }
  assert.equal((await fetch(`${base}/quality`, { method: "DELETE" })).status, 405);
  assert.equal((await fetch(`${base}/quality`, { method: "POST" })).status, 400);
  assert.equal((await fetch(`${base}/quality`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" } })).status, 400);
  assert.equal((await fetch(`${base}/quality`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 400);
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${base}/quality`, { method: "POST", headers: { "Content-Type": "application/json" } });
    assert.ok([200, 202].includes(response.status));
    await response.json();
  }
  assert.equal(calls, 1);
  const limited = await fetch(`${base}/quality?family=6`, { method: "POST", headers: { "Content-Type": "application/json" } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("Retry-After")) > 0);
  assert.ok((await limited.json()).retryAt);
  assert.ok((await (await fetch(`${base}/quality?family=6`)).json()).retryAt);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});
