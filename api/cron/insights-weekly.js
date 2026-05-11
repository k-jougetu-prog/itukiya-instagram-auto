// Vercel Cron Endpoint: 毎週月曜 9:00 JST に Instagram インサイトを取得 → Claude分析 → Chatwork通知
// vercel.json の crons.path = "/api/cron/insights-weekly" から呼ばれる
//
// クエリ:
//   ?dry=1     … 取得・分析だけ行い JSON で返す（Chatworkには送らない）
//   ?silent=1  … Chatwork通知をスキップ
//
// 必要スコープ: instagram_business_manage_insights（未付与なら数値は取れず「準備待ち」通知のみ）

import {
  buildSnapshot,
  isInsightsScopeMissing,
  analyzeWithClaude,
  buildDigest,
  buildScopeMissingNotice,
} from "../../scripts/insights.js";

const CW_API = "https://api.chatwork.com/v2";

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const IG_USER_ID = process.env.IG_USER_ID;
  const IG_USER_TOKEN = process.env.IG_USER_TOKEN;
  if (!IG_USER_ID || !IG_USER_TOKEN) {
    return res.status(500).json({ error: "Missing IG credentials" });
  }

  const isDry = req.query?.dry === "1" || (req.url || "").includes("dry=1");
  const silent = req.query?.silent === "1" || (req.url || "").includes("silent=1");

  try {
    const snapshot = await buildSnapshot(IG_USER_ID, IG_USER_TOKEN);
    const scopeMissing = isInsightsScopeMissing(snapshot);

    let analyzed = { skipped: true, reason: scopeMissing ? "scope-missing" : "n/a" };
    if (!scopeMissing) {
      analyzed = await analyzeWithClaude(snapshot);
    }

    const message = scopeMissing ? buildScopeMissingNotice(snapshot) : buildDigest(snapshot, analyzed);

    if (isDry) {
      return res.status(200).json({ ok: true, dryRun: true, scopeMissing, analyzed, snapshot, messagePreview: message });
    }

    if (!silent) await notifyChatwork(message);

    return res.status(200).json({
      ok: true,
      scopeMissing,
      notified: !silent,
      analyzed: analyzed?.error ? { error: analyzed.error } : { ok: !analyzed?.skipped, usage: analyzed?.usage },
      mediaCount: Array.isArray(snapshot.media) ? snapshot.media.length : 0,
    });
  } catch (e) {
    const errMsg = `❌ Instagram週次レポートエラー: ${e.message}\n${(e.body && JSON.stringify(e.body).slice(0, 400)) || ""}`;
    await notifyChatwork(errMsg).catch(() => {});
    return res.status(500).json({ error: e.message, body: e.body });
  }
}

async function notifyChatwork(message) {
  const token = process.env.CHATWORK_TOKEN;
  // 週次レポートの送り先は専用ルーム（INSIGHTS_CHATWORK_ROOM_ID）優先。
  // 未設定なら従来の CHATWORK_ROOM_ID にフォールバック。
  const roomId = process.env.INSIGHTS_CHATWORK_ROOM_ID || process.env.CHATWORK_ROOM_ID;
  if (!token || !roomId) {
    console.log("[chatwork notify skipped]", message.slice(0, 200));
    return;
  }
  const params = new URLSearchParams();
  params.set("body", message);
  await fetch(`${CW_API}/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "X-ChatWorkToken": token, "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
}
