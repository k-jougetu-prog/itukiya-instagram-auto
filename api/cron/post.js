// Vercel Cron Endpoint: 月水金 9:00 JST に施工事例を自動投稿
// vercel.json の crons.path = "/api/cron/post" から呼ばれる

import {
  selectNextPost,
  buildPostPayload,
  postToInstagram,
  getPostedIds,
} from "../../scripts/post.js";

export default async function handler(req, res) {
  // Vercel Cron からの認証チェック（CRON_SECRET環境変数）
  const auth = req.headers.authorization || "";
  const expected = `Bearer ${process.env.CRON_SECRET || ""}`;
  if (process.env.CRON_SECRET && auth !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const IG_USER_ID = process.env.IG_USER_ID;
  const IG_USER_TOKEN = process.env.IG_USER_TOKEN;
  if (!IG_USER_ID || !IG_USER_TOKEN) {
    return res.status(500).json({ error: "Missing IG credentials" });
  }

  try {
    // 1. 投稿済みID取得（IG自身の投稿履歴から）
    const postedIds = await getPostedIds(IG_USER_ID, IG_USER_TOKEN);

    // 2. 投稿対象を選ぶ
    const sel = await selectNextPost(postedIds);
    if (!sel.post) {
      const message = "対象事例なし（3年以内ストック消化完了）";
      await notifyChatwork(`⚠️ Instagram自動投稿: ${message}`);
      return res.status(200).json({ ok: true, skipped: true, reason: message });
    }

    // 3. ペイロード組み立て
    const { images, caption } = await buildPostPayload(sel.post);

    // ?dry=1 でドライラン（投稿せず結果だけ返す）
    const isDry = req.query?.dry === "1" || req.url?.includes("dry=1");
    if (isDry) {
      return res.status(200).json({
        ok: true,
        dryRun: true,
        postId: sel.post.id,
        reason: sel.reason,
        title: sel.post.title.rendered,
        date: sel.post.date,
        link: sel.post.link,
        images,
        captionLength: caption.length,
        captionPreview: caption.slice(0, 200),
        postedIdsCount: postedIds.size,
      });
    }

    // 4. 投稿実行
    const mediaId = await postToInstagram({
      images,
      caption,
      igUserId: IG_USER_ID,
      igToken: IG_USER_TOKEN,
    });

    // 5. Chatwork通知
    const reasonLabel = sel.reason === "new" ? "新着" : "ストック消化";
    const msg = [
      "[info][title]📷 Instagram投稿成功[/title]",
      `事例：${sel.post.title.rendered}`,
      `区分：${reasonLabel}`,
      `公開日：${sel.post.date.slice(0, 10)}`,
      `画像：${images.length}枚`,
      `HP：${sel.post.link}`,
      `IG ：https://www.instagram.com/itukiya_reform_official/`,
      `MediaID：${mediaId}`,
      "[/info]",
    ].join("\n");
    await notifyChatwork(msg);

    return res.status(200).json({
      ok: true,
      mediaId,
      postId: sel.post.id,
      reason: sel.reason,
      title: sel.post.title.rendered,
      images: images.length,
      postedIdsCount: postedIds.size,
    });
  } catch (e) {
    const errMsg = `❌ Instagram自動投稿エラー: ${e.message}\n${(e.body && JSON.stringify(e.body)) || ""}`;
    await notifyChatwork(errMsg);
    return res.status(500).json({ error: e.message, body: e.body });
  }
}

async function notifyChatwork(message) {
  const token = process.env.CHATWORK_TOKEN;
  const roomId = process.env.CHATWORK_ROOM_ID;
  if (!token || !roomId) {
    console.log("[chatwork未設定 skipped]", message.slice(0, 200));
    return;
  }
  try {
    const params = new URLSearchParams();
    params.set("body", message);
    await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
      method: "POST",
      headers: {
        "X-ChatWorkToken": token,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
  } catch (err) {
    console.error("Chatwork notify failed:", err.message);
  }
}
