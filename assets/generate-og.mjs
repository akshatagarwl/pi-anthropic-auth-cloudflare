// Regeneration instructions: assets/README.md. No repository dependencies needed.
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.argv[2]) {
  throw new Error("Usage: node assets/generate-og.mjs <temporary renderer directory>");
}
const require = createRequire(resolve(process.argv[2], "package.json"));
const { render, renderSvg } = await import(pathToFileURL(require.resolve("takumi-js")));

const ink = "#11171b";
const orange = "#ff9856";
const muted = "#a6afb2";
const text = (content, x, y, size, color = "#f6f2e9", extra = "") =>
  `<div style="position:absolute;left:${x}px;top:${y}px;font-size:${size}px;color:${color};line-height:1.15;${extra}">${content}</div>`;
const box = (x, width, label, emphasis = false) => `
  <div style="position:absolute;left:${x}px;top:436px;width:${width}px;height:66px;display:flex;align-items:center;justify-content:center;border:1px solid ${emphasis ? "#9d613e" : "#394348"};border-radius:12px;background:${emphasis ? "#2c221c" : "#1a2227"};color:${emphasis ? orange : "#e4e8e5"};font-size:24px;font-weight:500;">${label}</div>`;
const arrow = (x) => `
  <div style="position:absolute;left:${x}px;top:468px;width:65px;height:1px;background:#667176;"></div>
  <div style="position:absolute;left:${x + 57}px;top:464px;width:8px;height:8px;border-top:1px solid #667176;border-right:1px solid #667176;transform:rotate(45deg);"></div>`;

// Original typographic artwork; no brand logos or external image/font requests.
const html = `<div style="position:relative;width:1200px;height:630px;overflow:hidden;background:${ink};font-family:sans-serif;">
  <div style="position:absolute;left:0;top:0;width:1200px;height:5px;background:${orange};"></div>
  <div style="position:absolute;right:-170px;top:-220px;width:620px;height:620px;border:1px solid #293034;border-radius:310px;"></div>
  <div style="position:absolute;right:-104px;top:-154px;width:488px;height:488px;border:1px solid #293034;border-radius:244px;"></div>
  <div style="position:absolute;right:-38px;top:-88px;width:356px;height:356px;border:1px solid #293034;border-radius:178px;"></div>
  <div style="position:absolute;left:64px;top:61px;width:9px;height:9px;border-radius:5px;background:${orange};"></div>
  ${text("pi-anthropic-auth-cloudflare", 86, 52, 23, "#d6dedb", "font-weight:500;letter-spacing:0.2px;")}
  ${text("WEB API ONLY", 954, 57, 15, muted, "letter-spacing:2px;")}
  ${text("Anthropic auth.", 60, 143, 86, "#f6f2e9", "font-weight:700;letter-spacing:-3px;")}
  ${text("Built for Workers.", 60, 239, 86, orange, "font-weight:700;letter-spacing:-3px;")}
  ${text("Request shaping for pi-ai provider collections.", 65, 361, 25, muted)}
  ${box(64, 212, "pi-ai")}
  ${arrow(293)}
  ${box(376, 244, "adapter", true)}
  ${arrow(637)}
  ${box(720, 244, "Workers")}
  <div style="position:absolute;left:64px;top:549px;width:1072px;height:1px;background:#30393e;"></div>
  ${text("Unofficial · Experimental · MIT", 64, 576, 18, muted)}
  ${text("TYPESCRIPT / WEB CRYPTO", 851, 578, 14, "#879398", "letter-spacing:1.7px;")}
</div>`;

const options = { width: 1200, height: 630, emoji: "from-font" };
await writeFile(new URL("og.png", import.meta.url), await render(html, { ...options, format: "png" }));
await writeFile(new URL("og.svg", import.meta.url), await renderSvg(html, options));
console.log("Generated assets/og.png and assets/og.svg (1200 × 630)");
