// 半々ビフォーアフター表紙(案A 額装/マット)をサーバー生成する共通ロジック。
// satori(JSX→SVG) + @resvg/resvg-js(SVG→PNG) + sharp(写真取得・JPEG化)。
// フォントを明示的に渡すので Vercel(システムフォント無し)でも日本語明朝が出る。
// ローカル生成 == 本番生成 の結果一致が利点。
//
// 使い方: buildCover({ beforeUrl, afterUrl, title, sub }) -> JPEG Buffer
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, "..", "public", "fonts");

const CREAM = "#f4efe6";
const OLIVE = "#4a5d3a";
const INK = "#2f2b24";
const GOLD = "#b9a06a";
const SUB = "#8a8575";

let _fonts = null;
function fonts() {
  if (_fonts) return _fonts;
  _fonts = [
    { name: "NotoSerifJP", data: fs.readFileSync(path.join(FONT_DIR, "NotoSerifJP-sb.ttf")), weight: 600, style: "normal" },
    { name: "NotoSerif", data: fs.readFileSync(path.join(FONT_DIR, "NotoSerif-md.ttf")), weight: 500, style: "normal" },
  ];
  return _fonts;
}

async function toDataUri(url, w, h) {
  // redirect:"manual" で3xxを拒否。itukiya.jp上のオープンリダイレクト経由の内部到達(SSRF)を封じる。
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "manual" });
  if (r.status >= 300 && r.status < 400) throw new Error(`redirect not allowed: ${url}`);
  if (!r.ok) throw new Error(`fetch ${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const jpg = await sharp(buf).rotate().resize(w, h, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString("base64")}`;
}

// satori が受け取る React-element 風オブジェクトを素の関数で組む
const el = (type, style, children) => ({ type, props: { style, ...(children !== undefined ? { children } : {}) } });

export async function buildCover({ beforeUrl, afterUrl, title, sub, enSub }) {
  const EN = (enSub || "RENOVATION & REFORM").toUpperCase();
  const W = 1080, H = 1080;
  const PHOTO_W = 471, PHOTO_H = 636;
  const [bImg, aImg] = await Promise.all([
    toDataUri(beforeUrl, PHOTO_W, PHOTO_H),
    toDataUri(afterUrl, PHOTO_W, PHOTO_H),
  ]);

  // 写真は satori の background だと描画が不安定なので <img> 要素で入れる。
  // sharp 側で既に PHOTO_W×PHOTO_H にcover済みなのでそのまま等倍表示。
  const photoCard = (uri) => ({
    type: "img",
    props: { src: uri, width: PHOTO_W, height: PHOTO_H, style: { borderRadius: 14, objectFit: "cover" } },
  });

  const label = (text, color) =>
    el("div", {
      display: "flex", width: PHOTO_W, justifyContent: "center",
      fontFamily: "NotoSerif", fontSize: 28, letterSpacing: 7, color,
    }, text);

  const tree = el("div", {
    display: "flex", flexDirection: "column", width: W, height: H,
    backgroundColor: CREAM, padding: 56, border: `3px solid ${GOLD}`,
  }, [
    el("div", { display: "flex", gap: 20 }, [photoCard(bImg), photoCard(aImg)]),
    el("div", { display: "flex", gap: 20, marginTop: 18 }, [label("BEFORE", SUB), label("AFTER", OLIVE)]),
    el("div", { display: "flex", flexDirection: "column", marginTop: "auto", alignItems: "center", width: "100%" }, [
      el("div", { display: "flex", fontFamily: "NotoSerifJP", fontSize: 62, color: INK, textAlign: "center" }, title),
      el("div", { display: "flex", fontFamily: "NotoSerif", fontSize: 21, letterSpacing: 7, color: GOLD, marginTop: 16 }, EN),
      el("div", { display: "flex", width: 300, height: 1, backgroundColor: GOLD, opacity: 0.5, marginTop: 30, marginBottom: 24 }),
      el("div", { display: "flex", fontFamily: "NotoSerifJP", fontSize: 25, letterSpacing: 5, color: OLIVE }, "いつき家　リフォーム施工事例"),
    ]),
  ]);

  const svg = await satori(tree, { width: W, height: H, fonts: fonts() });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng();
  return await sharp(png).jpeg({ quality: 90 }).toBuffer();
}

// サブ(エリア/様邸)は呼び出し側で組むが、英字サブは工種から出すためのヘルパ余地を残す
export function defaultSub(area, teritoryLabel) {
  return [area, teritoryLabel].filter(Boolean).join("  ");
}
