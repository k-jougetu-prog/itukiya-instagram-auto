// 半々ビフォーアフター表紙(案A)を生成して返すエンドポイント。
// カルーセルの1枚目の image_url として Instagram Graph API に渡し、Meta にfetchさせる。
// 合成ロジックは scripts/cover.mjs（ローカルプレビューと共通）。
//
// 使い方: GET /api/cover?b=<before画像URL>&a=<after画像URL>&t=<見出し>&e=<英字サブ>
// - b / a は itukiya.jp 配下のhttps画像のみ許可（オープンリレー防止）
import { buildCover } from "../scripts/cover.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

const ALLOW_HOST = /(^|\.)itukiya\.jp$/i;

function checkUrl(u) {
  const p = new URL(u);
  if (p.protocol !== "https:" || !ALLOW_HOST.test(p.hostname)) throw new Error("host not allowed");
  return u;
}

export default async function handler(req, res) {
  const b = (req.query?.b || "").toString();
  const a = (req.query?.a || "").toString();
  const t = (req.query?.t || "").toString().slice(0, 40);
  const e = (req.query?.e || "").toString().slice(0, 48);
  if (!b || !a) { res.status(400).json({ error: "missing b/a" }); return; }
  try { checkUrl(b); checkUrl(a); } catch (err) { res.status(400).json({ error: err.message }); return; }
  try {
    const jpg = await buildCover({ beforeUrl: b, afterUrl: a, title: t || "リフォーム施工事例", enSub: e });
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.status(200).send(jpg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
