// 写真選び直し画面(/edit.html)の保存先。HMACトークン(a:"edit")で保護。
// 選び直した 表紙BA対＋見出し＋カルーセル写真 を受けて、該当keyのpending状態を上書きする。
// → 翌朝9時の post cron がこの内容で投稿する。営業グループ全員が使える。
import { env, verifyToken, readLatestState, appendState, cwPostMessage, readForm, getPostById } from "../scripts/preview-flow.js";
import { coverMeta } from "../scripts/post.js";

export const config = { runtime: "nodejs", maxDuration: 30 };

const ALLOW_HOST = /(^|\.)itukiya\.jp$/i;
function okImg(u) {
  try { const p = new URL(u); return p.protocol === "https:" && ALLOW_HOST.test(p.hostname); }
  catch { return false; }
}

export default async function handler(req, res) {
  if ((req.method || "GET").toUpperCase() !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const form = await readForm(req);
  const token = (form.t || req.query?.t || "").toString();
  const payload = verifyToken(token);
  if (!payload || payload.a !== "edit") {
    res.status(400).json({ error: "invalid or expired token" });
    return;
  }
  const { k: key, pid } = payload;
  try {
    const state = await readLatestState(key);
    if (state?.st === "posted") { res.status(409).json({ error: "すでに投稿済みのため変更できません" }); return; }

    // payload は JSON 文字列(form.payload)で受ける
    let data = {};
    try { data = JSON.parse(form.payload || "{}"); } catch { res.status(400).json({ error: "bad payload" }); return; }
    const before = (data.before || "").toString();
    const after = (data.after || "").toString();
    const headline = (data.headline || "").toString().slice(0, 24).trim();
    const carousel = (Array.isArray(data.carousel) ? data.carousel : []).map((u) => u.toString());

    // 全写真URLは itukiya.jp 限定（任意画像の投稿を防ぐ）
    for (const u of [before, after, ...carousel].filter(Boolean)) {
      if (!okImg(u)) { res.status(400).json({ error: "不正な画像URLが含まれています" }); return; }
    }
    if (carousel.length < 1) { res.status(400).json({ error: "カルーセル写真を1枚以上選んでください" }); return; }

    const post = await getPostById(pid);
    const { APPROVE_BASE } = env();
    const images = [];
    // 表紙(半々BA)は before/after が両方そろった時だけ1枚目に
    if (before && after) {
      const enSub = coverMeta(post || {}).enSub;
      const t = headline || coverMeta(post || {}).title;
      // 見出しに様/邸が混入しても表紙生成側では描画するだけ。念のためここでサニタイズ。
      const safeT = /様|邸/.test(t) ? "リフォーム施工事例" : t;
      const q = new URLSearchParams({ b: before, a: after, t: safeT, e: enSub || "RENOVATION & REFORM" });
      images.push(`${APPROVE_BASE}/api/cover?${q.toString()}`);
    }
    images.push(...carousel);
    const finalImgs = images.slice(0, 8);
    if (finalImgs.length < 2) { res.status(400).json({ error: "写真が少なすぎます（表紙＋1枚以上）" }); return; }

    await appendState({ k: key, pid, st: "pending", imgs: finalImgs, via: "edit", t: Date.now() });

    try {
      await cwPostMessage(env().SALES_GROUP_ROOM_ID,
        `[info]✏️ ${key} の施工事例インスタ、写真を選び直しました（全${finalImgs.length}枚）。この内容で翌朝9時に投稿されます。[/info]`);
    } catch { /* 通知失敗は本処理を止めない */ }

    res.status(200).json({ ok: true, images: finalImgs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
