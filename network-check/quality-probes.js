"use strict";

const { Resolver } = require("node:dns/promises");
const net = require("node:net");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAIL_DOMAINS = Object.freeze({
  Gmail: "gmail.com", Outlook: "outlook.com", Yahoo: "yahoo.com", Apple: "me.com",
  QQ: "qq.com", MailRU: "mail.ru", AOL: "aol.com", GMX: "gmx.com",
  MailCOM: "mail.com", "163": "163.com", Sohu: "sohu.com", Sina: "sina.com",
});

function smtpGreeting(host, family) {
  return new Promise((resolve) => {
    let data = "";
    const socket = net.createConnection({ host, port: 25, family });
    const timer = setTimeout(() => finish(false), 6_000);
    function finish(result) {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (/^220[ -]/.test(data)) finish(true);
      else if (data.includes("\n") || data.length > 4096) finish(false);
    });
    socket.on("error", (error) => finish(
      ["ENOTFOUND", "EAI_AGAIN"].includes(error.code) ? null : false,
    ));
    socket.on("end", () => finish(false));
  });
}

async function checkMail(family, resolver = new Resolver({ timeout: 2000, tries: 1 }), connect = smtpGreeting) {
  const entries = await Promise.all(Object.entries(MAIL_DOMAINS).map(async ([name, domain]) => {
    try {
      const hosts = (await resolver.resolveMx(domain)).sort((a, b) => a.priority - b.priority);
      if (!hosts[0]?.exchange) return [name, null];
      return [name, await connect(hosts[0].exchange, family)];
    } catch { return [name, null]; }
  }));
  const services = Object.fromEntries(entries);
  // Port25 denotes a verified outgoing SMTP greeting, not a local listening port.
  const values = Object.values(services);
  return { Port25: values.includes(true) ? true : values.includes(false) ? false : null, ...services };
}

function classifyDNSBL(answers, error) {
  if (error) return ["ENOTFOUND", "ENODATA"].includes(error.code) ? "Clean" : "Unknown";
  if (!Array.isArray(answers) || answers.length === 0) return "Clean";
  if (answers.some((ip) => !ip.startsWith("127.") || ip.startsWith("127.255.255."))) return "Unknown";
  return answers.includes("127.0.0.2") ? "Blacklisted" : "Marked";
}

async function checkDNSBL(ip, resolver = new Resolver({ timeout: 2000, tries: 1 }), domains) {
  if (net.isIP(ip) !== 4) return null;
  if (!domains) {
    const list = await fs.readFile(path.join(__dirname, "vendor/IPQuality/ref/dnsbl.list"), "utf8");
    domains = [...new Set(list.split(/\r?\n/).map((x) => x.trim())
      .filter((x) => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(x)))];
  }
  const summary = { Total: domains.length, Clean: 0, Marked: 0, Blacklisted: 0, Unknown: 0 };
  if (!domains.length) return null;
  const reverse = ip.split(".").reverse().join(".");
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, domains.length) }, async () => {
    while (next < domains.length) {
      const domain = domains[next++];
      try { summary[classifyDNSBL(await resolver.resolve4(`${reverse}.${domain}`))] += 1; }
      catch (error) { summary[classifyDNSBL(null, error)] += 1; }
    }
  }));
  return summary;
}

module.exports = { checkMail, checkDNSBL, classifyDNSBL, smtpGreeting };
