// Probe how a web page draws its graph: screenshots over time, graph-data requests, rendering library and node/edge counts.
//   node tools/probe-graph.cjs <url> <out-dir> [--login email password] [--wait 12000]
// Observation only: it records what a user would see and the shape of the data, it does not save page scripts.
const { chromium } = require("playwright");
const fs = require("fs");
const [url, out, ...rest] = process.argv.slice(2);
const opt = (k, n = 1) => { const i = rest.indexOf(k); return i < 0 ? null : rest.slice(i + 1, i + 1 + n); };
const wait = Number(opt("--wait")?.[0] ?? 12000);
const login = opt("--login", 2);
if (!url || !out) { console.error("usage: node tools/probe-graph.cjs <url> <out-dir> [--login email password] [--wait ms]"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  const requests = [], errors = [];
  p.on("pageerror", e => errors.push(e.message));
  p.on("response", async r => {
    const ct = r.headers()["content-type"] ?? "";
    if (!/json/.test(ct) || !/^(xhr|fetch)$/.test(r.request().resourceType())) return;
    try {
      const j = await r.json();
      const find = (o, d = 0) => (d > 4 || !o || typeof o !== "object") ? [] : Object.entries(o).flatMap(([k, v]) => Array.isArray(v) ? [[k, v.length, v[0] && typeof v[0] === "object" ? Object.keys(v[0]).slice(0, 14) : typeof v[0]], ...find(v[0], d + 1)] : find(v, d + 1));
      requests.push({ url: r.url().replace(/\?.*/, ""), status: r.status(), arrays: find(j).slice(0, 10) });
    } catch { /* not parseable */ }
  });
  await p.goto(url, { waitUntil: "domcontentloaded" });
  if (login) {
    await p.fill("#em", login[0]).catch(() => {}); await p.fill("#pw", login[1]).catch(() => {});
    await p.keyboard.press("Enter"); await p.waitForTimeout(1500); await p.goto(url, { waitUntil: "domcontentloaded" });
  }
  const shots = [1500, 4000, wait];
  let last = 0;
  for (const t of shots) { await p.waitForTimeout(t - last); last = t; await p.screenshot({ path: `${out}/t${t}.png` }); }
  const info = await p.evaluate(() => {
    const g = window;
    const libs = Object.fromEntries(["d3", "THREE", "Sigma", "sigma", "cytoscape", "ForceGraph", "ForceGraph3D", "vis", "echarts", "G6", "Graphology", "graphology", "mermaid", "PIXI"]
      .filter(k => g[k]).map(k => [k, typeof g[k]]));
    const canvases = [...document.querySelectorAll("canvas")].map(c => ({ w: c.width, h: c.height, webgl: !!(c.getContext && (() => { try { return c.getContext("webgl2") || c.getContext("webgl"); } catch { return null; } })()) }));
    const svg = document.querySelector("svg");
    const svgStats = svg ? { circles: svg.querySelectorAll("circle").length, paths: svg.querySelectorAll("path").length, lines: svg.querySelectorAll("line").length, texts: svg.querySelectorAll("text").length, groups: svg.querySelectorAll("g").length } : null;
    const text = [...document.querySelectorAll("h1,h2,h3,h4,h5,label,button,legend,[class*=legend] *,[class*=Legend] *")].map(e => e.textContent.trim()).filter(t => t && t.length < 80);
    return { title: document.title, libs, canvases, svgStats, text: [...new Set(text)].slice(0, 80) };
  });
  fs.writeFileSync(`${out}/probe.json`, JSON.stringify({ url, ...info, requests, errors }, null, 2));
  console.log(JSON.stringify({ url, libs: info.libs, canvases: info.canvases.length, svg: info.svgStats, graphRequests: requests.length, errors: errors.length }));
  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
