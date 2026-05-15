// Vercel Cron Endpoint: 月水金 9:00 JST に施工事例を自動投稿
// vercel.json の crons.path = "/api/cron/post" から呼ばれる

import {
  pickPostablePost,
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

  // catch から事故時の文脈（記事ID/URL）を通知に含めるため、外側スコープに置く
  let post = null;
  let pick = null;
  try {
    // 1. 投稿済みID取得（IG自身の投稿履歴から）
    const postedIds = await getPostedIds(IG_USER_ID, IG_USER_TOKEN);

    // 2. 「次に投稿すべき & 写真が成立する」記事を選ぶ（写真が薄い記事は飛ばす）
    pick = await pickPostablePost(postedIds);
    const skippedNote = (pick.skipped || []).length
      ? `\n（写真不足でスキップ：${pick.skipped.map((s) => `#${s.id} ${s.title}`.slice(0, 60)).join(" / ")}）`
      : "";
    if (!pick.post) {
      const reasonText = pick.reason === "no-good-photos"
        ? "投稿できる写真が揃った記事が見つかりませんでした（古い記事が連続で写真不足／要確認）"
        : "対象事例なし（ストック消化完了 or 該当なし／要確認）";
      await notifyChatwork(`⚠️ Instagram自動投稿: ${reasonText}${skippedNote}`);
      return res.status(200).json({ ok: true, skipped: true, reason: pick.reason, skippedPosts: pick.skipped });
    }

    post = pick.post;
    const { reason, images, caption, qc } = pick;
    const titleStr = typeof post.title === "string" ? post.title : (post.title?.rendered || "");

    // ?dry=1 でドライラン（投稿せず結果だけ返す）
    const isDry = req.query?.dry === "1" || req.url?.includes("dry=1");
    if (isDry) {
      return res.status(200).json({
        ok: true,
        dryRun: true,
        postId: post.id,
        reason,
        title: titleStr,
        date: post.date,
        link: post.link,
        images,
        droppedImages: qc?.dropped || [],
        qcNote: qc?.note || "",
        skippedPosts: pick.skipped,
        captionLength: caption.length,
        captionPreview: caption.slice(0, 200),
        postedIdsCount: postedIds.size,
      });
    }

    // 3. 投稿実行
    const { mediaId, failedImages } = await postToInstagram({
      images,
      caption,
      igUserId: IG_USER_ID,
      igToken: IG_USER_TOKEN,
    });

    // 4. Chatwork通知
    const reasonLabel = reason === "new" ? "新着" : "ストック消化";
    const droppedNote = (qc?.dropped || []).length ? `（QCで除外：${qc.dropped.length}枚${qc.note ? " / " + qc.note : ""}）` : "";
    const failedNote = (failedImages || []).length
      ? `\n※IG取得失敗で除外：${failedImages.length}枚\n${failedImages.map((f) => `  - [${f.index + 1}枚目] ${f.originalUrl} (${f.error})`).join("\n")}`
      : "";
    const msg = [
      "[info][title]📷 Instagram投稿成功[/title]",
      `事例：${titleStr}`,
      `区分：${reasonLabel}`,
      `公開日：${(post.date || "").slice(0, 10)}`,
      `画像：${images.length - (failedImages?.length || 0)}/${images.length}枚${droppedNote}`,
      `HP：${post.link}`,
      `IG ：https://www.instagram.com/itukiya_reform_official/`,
      `MediaID：${mediaId}`,
      "[/info]",
      ...((pick.skipped || []).length ? [`※写真不足でスキップした記事：${pick.skipped.map((s) => `#${s.id} ${s.title}`).join(" / ")}`] : []),
      ...(failedNote ? [failedNote] : []),
    ].join("\n");
    await notifyChatwork(msg);

    return res.status(200).json({
      ok: true,
      mediaId,
      postId: post.id,
      reason,
      title: titleStr,
      images: images.length,
      droppedImages: qc?.dropped?.length || 0,
      failedImages: failedImages || [],
      skippedPosts: pick.skipped,
      postedIdsCount: postedIds.size,
    });
  } catch (e) {
    // 失敗時はpost情報と失敗画像も通知に含める（事後復旧の判断材料）
    const ctx = [];
    if (post) {
      ctx.push(`記事：#${post.id} ${typeof post.title === "string" ? post.title : (post.title?.rendered || "")}`);
      if (post.link) ctx.push(`HP：${post.link}`);
    }
    if (e.failedImages?.length) {
      ctx.push(`失敗画像 ${e.failedImages.length}枚：`);
      e.failedImages.forEach((f) => ctx.push(`  - [${f.index + 1}枚目] ${f.originalUrl}`));
    }
    const errMsg = [
      `❌ Instagram自動投稿エラー: ${e.message}`,
      ...ctx,
      e.body ? JSON.stringify(e.body).slice(0, 800) : "",
    ].filter(Boolean).join("\n");
    await notifyChatwork(errMsg);
    return res.status(500).json({ error: e.message, body: e.body, failedImages: e.failedImages });
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
