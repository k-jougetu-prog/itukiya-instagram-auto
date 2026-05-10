// Vercel Cron Endpoint: Instagram User Access Token を60日延長する
// 月初（毎月1日 朝9:00 JST = UTC 0:00）に発火する。
// 現状トークンの残り日数も併せてリマインド通知。

const VERCEL_API = "https://api.vercel.com";
const GRAPH = "https://graph.instagram.com";
const CW_API = "https://api.chatwork.com/v2";

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = process.env.IG_USER_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "Missing IG_USER_TOKEN" });
  }

  try {
    // 1. 現在のトークンのデバッグ情報を取得
    const debug = await fetch(`${GRAPH}/v21.0/debug_token?input_token=${token}&access_token=${token}`);
    let expiresAt = null;
    if (debug.ok) {
      const dj = await debug.json();
      expiresAt = dj?.data?.expires_at; // Unix秒
    }
    const daysLeft = expiresAt
      ? Math.floor((expiresAt * 1000 - Date.now()) / 86400000)
      : null;

    // 2. リフレッシュ実行
    const refreshUrl = `${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`;
    const r = await fetch(refreshUrl);
    const refreshText = await r.text();
    if (!r.ok) {
      throw new Error(`Refresh failed: HTTP ${r.status} ${refreshText.slice(0, 300)}`);
    }
    const refreshData = JSON.parse(refreshText);
    const newToken = refreshData.access_token;
    const newExpiresIn = refreshData.expires_in;
    if (!newToken) {
      throw new Error("Refresh returned no access_token");
    }

    // 3. Vercelの環境変数を更新
    const updated = await updateVercelEnv("IG_USER_TOKEN", newToken);

    // 4. Chatwork通知
    const newDaysLeft = newExpiresIn
      ? Math.floor(newExpiresIn / 86400)
      : 60; // refreshは通常60日
    const msg = [
      "[info][title]🔄 Instagramトークン自動更新[/title]",
      "",
      `更新前 残り日数: ${daysLeft ?? "不明"}日`,
      `更新後 有効期間: ${newDaysLeft}日（〜${formatExpiryDate(newDaysLeft)}）`,
      `Vercel env更新: ${updated ? "成功" : "失敗"}`,
      "",
      "次回更新: 来月1日 9:00自動",
      "[/info]",
    ].join("\n");
    await notifyChatwork(msg);

    return res.status(200).json({
      ok: true,
      daysLeftBefore: daysLeft,
      daysLeftAfter: newDaysLeft,
      vercelUpdated: updated,
    });
  } catch (e) {
    const errMsg = [
      "[info][title]⚠️ Instagramトークン更新失敗（要対応）[/title]",
      "",
      `エラー: ${e.message}`,
      "",
      "60日トークンが切れると自動投稿が停止します。",
      "Kに「トークン手動更新」と振ってください。",
      "[/info]",
    ].join("\n");
    await notifyChatwork(errMsg).catch(() => {});
    return res.status(500).json({ error: e.message });
  }
}

async function updateVercelEnv(key, value) {
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_ORG_ID;
  const apiToken = process.env.VERCEL_API_TOKEN;
  if (!projectId || !apiToken) {
    console.log("[vercel env update skipped: missing VERCEL_PROJECT_ID/VERCEL_API_TOKEN]");
    return false;
  }
  const u = `${VERCEL_API}/v10/projects/${projectId}/env${teamId ? `?teamId=${teamId}&upsert=true` : "?upsert=true"}`;
  const res = await fetch(u, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      key,
      value,
      target: ["production", "preview", "development"],
      type: "encrypted",
    }),
  });
  return res.ok;
}

async function notifyChatwork(message) {
  const token = process.env.CHATWORK_TOKEN;
  const roomId = process.env.CHATWORK_ROOM_ID;
  if (!token || !roomId) {
    console.log("[chatwork notify skipped]", message.slice(0, 200));
    return;
  }
  const params = new URLSearchParams();
  params.set("body", message);
  await fetch(`${CW_API}/rooms/${roomId}/messages`, {
    method: "POST",
    headers: {
      "X-ChatWorkToken": token,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
}

function formatExpiryDate(daysLeft) {
  const d = new Date(Date.now() + daysLeft * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
