// 施工事例インスタ「投稿プレビュー」用モンタージュ画像を1枚合成する。
// カルーセルに出す写真（最大7枚）を投稿順に番号付きグリッドで並べ、
// Chatworkにアップロードして営業グループが一目でチェックできるようにする。
// Vercel(sharp)でフォントが使えない前提のため、番号は事前に焼いた public/badges/{n}.png を合成する
// （テキスト描画はしない。工種ラベル等の日本語はChatworkメッセージ本文側に書く）。
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const BADGE_DIR = path.join(__dir, "..", "public", "badges");

const COLS = 2;
const CELL_W = 620;
const CELL_H = 465; // 4:3
const GAP = 16;
const MARGIN = 16;
const BG = "#f3eee3";     // ブランドのクリーム地
const CELL_BG = "#ffffff";
const BADGE = 96;          // バッジ表示サイズ
const BADGE_OFF = 14;

async function fetchBuf(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`fetch photo ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 1枚を「白地セル(contain)＋左上に番号バッジ」に仕上げる。
 *  1枚でも失敗すると Promise.all でプレビュー全体が飛ぶため、取得/変換失敗は
 *  プレースホルダセルにフォールバックして他の写真のプレビューは必ず出す
 *  （表紙=/api/cover の生成失敗でその日の投稿確認が丸ごと消えるのを防ぐ）。 */
async function makeCell(url, n) {
  let photo;
  try {
    const raw = await fetchBuf(url);
    photo = await sharp(raw)
      .rotate() // EXIF orientation 正規化
      .resize(CELL_W, CELL_H, { fit: "contain", background: CELL_BG })
      .toBuffer();
  } catch {
    photo = await sharp({ create: { width: CELL_W, height: CELL_H, channels: 3, background: "#e7e0d2" } })
      .png().toBuffer();
  }
  const badgePath = path.join(BADGE_DIR, `${n}.png`);
  const composites = [];
  if (fs.existsSync(badgePath)) {
    const badge = await sharp(badgePath).resize(BADGE, BADGE).toBuffer();
    composites.push({ input: badge, top: BADGE_OFF, left: BADGE_OFF });
  }
  return sharp(photo).composite(composites).png().toBuffer();
}

/**
 * 画像URL配列 → 番号付きグリッドモンタージュ(PNG Buffer)
 * @param {string[]} urls 投稿順の画像URL（最大7枚想定）
 */
export async function buildMontageBuffer(urls) {
  const list = urls.slice(0, 8);
  const rows = Math.ceil(list.length / COLS);
  const W = MARGIN * 2 + COLS * CELL_W + (COLS - 1) * GAP;
  const H = MARGIN * 2 + rows * CELL_H + (rows - 1) * GAP;

  const cells = await Promise.all(list.map((u, i) => makeCell(u, i + 1)));
  const composites = cells.map((buf, i) => {
    const r = Math.floor(i / COLS);
    const c = i % COLS;
    return {
      input: buf,
      left: MARGIN + c * (CELL_W + GAP),
      top: MARGIN + r * (CELL_H + GAP),
    };
  });

  return sharp({ create: { width: W, height: H, channels: 3, background: BG } })
    .composite(composites)
    .png()
    .toBuffer();
}

// CLI: node scripts/montage.mjs <out.png> <url1> <url2> ...
if (process.argv[1] && process.argv[1].endsWith("montage.mjs")) {
  const [, , out, ...urls] = process.argv;
  if (!out || !urls.length) {
    console.error("usage: montage.mjs <out.png> <url1> [url2 ...]");
    process.exit(1);
  }
  const buf = await buildMontageBuffer(urls);
  fs.writeFileSync(out, buf);
  console.log("saved", out, buf.length, "bytes");
}
