// 写真選び直し画面(/edit.html)が読む元データを返す。
// HMACトークン(a:"edit")で保護。該当する投稿予定日(key)のpending状態＋記事の全候補写真を返す。
import { verifyToken, readLatestState, getPostById } from "../scripts/preview-flow.js";
import { coverMeta } from "../scripts/post.js";

export const config = { runtime: "nodejs", maxDuration: 30 };

export default async function handler(req, res) {
  const token = (req.query?.t || "").toString();
  const payload = verifyToken(token);
  if (!payload || payload.a !== "edit") {
    res.status(400).json({ error: "invalid or expired token" });
    return;
  }
  const { k: key, pid } = payload;
  try {
    const state = await readLatestState(key);
    const post = await getPostById(pid);
    if (!post) { res.status(404).json({ error: "post not found" }); return; }

    // 候補写真＝featured＋本文全枚数（サイズ違い重複を除去）
    const photos = [];
    const seen = new Set();
    for (const u of [post.featured_url, ...(post.body_images || [])]) {
      if (!u) continue;
      const base = (u.split("/").pop() || u).replace(/\.[a-z0-9]+$/i, "").replace(/-\d{2,5}x\d{2,5}$/i, "").replace(/-scaled$/i, "").toLowerCase();
      if (seen.has(base)) continue;
      seen.add(base);
      photos.push(u);
    }

    // 現在の投稿内容(pendingのimgs)を 表紙BA対 ＋ カルーセル に分解
    const cm = coverMeta(post);
    const imgs = (state && Array.isArray(state.imgs)) ? state.imgs : [];
    let before = null, after = null;
    let headline = cm.title;
    let carousel = imgs;
    if (imgs[0] && imgs[0].includes("/api/cover")) {
      try {
        const q = new URL(imgs[0]).searchParams;
        before = q.get("b"); after = q.get("a");
        headline = q.get("t") || headline;
      } catch { /* noop */ }
      carousel = imgs.slice(1);
    }
    const title = typeof post.title === "string" ? post.title : (post.title?.rendered || "");

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ key, pid, title, headline, enSub: cm.enSub, photos, before, after, carousel, staged: state?.st || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
