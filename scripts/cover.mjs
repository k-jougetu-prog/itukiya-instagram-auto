// 半々ビフォーアフター表紙(案A 額装/マット)をサーバー生成する共通ロジック。
// @napi-rs/canvas(日本語フォントをregisterして描画) + sharp(写真取得/JPEG化)。
// ※当初 satori+resvg で実装したが、satori内部の harfbuzz(wasm) が Vercel の
//   サーバーレスで初期化に失敗して500になったため、ネイティブ描画の canvas に移行。
//   フォントを registerFromPath で明示登録するので Vercel でも日本語明朝が出る。
//   ローカル生成 == 本番生成。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, "..", "public", "fonts");

const CREAM = "#f4efe6";
const OLIVE = "#4a5d3a";
const INK = "#2f2b24";
const GOLD = "#b9a06a";
const SUB = "#8a8575";

let _reg = false;
function registerFonts() {
  if (_reg) return;
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "NotoSerifJP-sb.ttf"), "NotoSerifJP");
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "NotoSerif-md.ttf"), "NotoSerifLatin");
  _reg = true;
}

async function fetchResized(url, w, h) {
  // redirect:"manual" で3xxを拒否（itukiya.jp上のオープンリダイレクト経由のSSRFを封じる）。
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "manual" });
  if (r.status >= 300 && r.status < 400) throw new Error(`redirect not allowed: ${url}`);
  if (!r.ok) throw new Error(`fetch ${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return sharp(buf).rotate().resize(w, h, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer();
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// letterSpacing 非対応環境向けに、文字間を手動で詰めて中央寄せ描画する。
function fillTextTracked(ctx, text, cx, y, letter) {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + letter * (chars.length - 1);
  let x = cx - total / 2;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x, y);
    x += widths[i] + letter;
  }
  ctx.textAlign = prevAlign;
}

export async function buildCover({ beforeUrl, afterUrl, title, sub, enSub }) {
  registerFonts();
  const W = 1080, H = 1080, M = 56, G = 20;
  const PW = Math.floor((W - M * 2 - G) / 2), PH = 636, TOP = 70;
  const EN = (enSub || "RENOVATION & REFORM").toUpperCase();

  const [bBuf, aBuf] = await Promise.all([
    fetchResized(beforeUrl, PW, PH),
    fetchResized(afterUrl, PW, PH),
  ]);
  const [bImg, aImg] = await Promise.all([loadImage(bBuf), loadImage(aBuf)]);

  const cv = createCanvas(W, H);
  const ctx = cv.getContext("2d");

  // 背景(クリーム) ＋ 金の外枠
  ctx.fillStyle = CREAM;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, W - 3, H - 3);

  // 写真2枚（角丸カードで額装）
  const drawPhoto = (img, x) => {
    ctx.save();
    roundRectPath(ctx, x, TOP, PW, PH, 14);
    ctx.clip();
    ctx.drawImage(img, x, TOP, PW, PH);
    ctx.restore();
  };
  drawPhoto(bImg, M);
  drawPhoto(aImg, M + PW + G);

  // BEFORE / AFTER（セリフ・字間広め）
  ctx.textBaseline = "alphabetic";
  ctx.font = "28px NotoSerifLatin";
  ctx.fillStyle = SUB;
  fillTextTracked(ctx, "BEFORE", M + PW / 2, TOP + PH + 52, 7);
  ctx.fillStyle = OLIVE;
  fillTextTracked(ctx, "AFTER", M + PW + G + PW / 2, TOP + PH + 52, 7);

  // 見出し（明朝・大）
  ctx.fillStyle = INK;
  ctx.font = "62px NotoSerifJP";
  fillTextTracked(ctx, title, W / 2, TOP + PH + 150, 1);

  // 英字サブ（金・字間広め）
  ctx.fillStyle = GOLD;
  ctx.font = "21px NotoSerifLatin";
  fillTextTracked(ctx, EN, W / 2, TOP + PH + 200, 7);

  // 区切り線
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 150, H - 118);
  ctx.lineTo(W / 2 + 150, H - 118);
  ctx.stroke();
  ctx.restore();

  // マーク
  ctx.fillStyle = OLIVE;
  ctx.font = "25px NotoSerifJP";
  fillTextTracked(ctx, "いつき家　リフォーム施工事例", W / 2, H - 66, 5);

  return sharp(cv.toBuffer("image/png")).jpeg({ quality: 90 }).toBuffer();
}

export function defaultSub(area, teritoryLabel) {
  return [area, teritoryLabel].filter(Boolean).join("  ");
}
