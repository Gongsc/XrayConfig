"use strict";

const { isIP } = require("node:net");

function maskIP(ip) {
  if (isIP(ip) === 4) return `${ip.split(".").slice(0, 2).join(".")}.*.*`;
  if (isIP(ip) === 6) return `${ip.split(":").slice(0, 2).map((part) => part || "0").join(":")}:*:*:*:*:*:*`;
  return "已隐藏";
}

function publicReport(raw) {
  const ip = raw.Head.IP;
  const masked = maskIP(ip);
  // Also remove copies of the address embedded in strings/URLs in the report.
  const visit = (value) => {
    if (typeof value === "string") return value.split(ip).join(masked)
      .split(encodeURIComponent(ip)).join(encodeURIComponent(masked));
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  const result = visit(raw);
  result.Head.IP = masked;
  for (const data of Object.values(result.Media || {})) {
    if (!data || typeof data !== "object") continue;
    const region = typeof data.Region === "string" ? data.Region.trim() : "";
    data.Region = /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : "";
  }
  return result;
}

// Accept a country code only when attached to the currentTerritory field.
// Prime Video uses both a plain string and a typed {dataType, val} object.
function primeRegion(html) {
  const territories = new Set();
  const fields = /(?:^|[,{\s])["']?currentTerritory["']?\s*:\s*(?:"([A-Za-z]{2})"|'([A-Za-z]{2})'|(\{[^{}]{0,400}\}))/g;
  for (const match of String(html).matchAll(fields)) {
    const code = match[1] || match[2] || /\b(?:val|value)["']?\s*:\s*["']([A-Za-z]{2})["']/.exec(match[3] || "")?.[1];
    if (code) territories.add(code.toUpperCase());
  }
  return territories.size === 1 ? [...territories][0] : "";
}

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => process.stdout.write(primeRegion(input)));
}

module.exports = { maskIP, publicReport, primeRegion };
