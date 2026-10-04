// ❌ プレビューの「やめる・直したい」リンクの着地点。
// 2タップ式：GET=確認ページ（prefetchで誤保留しない）、POST=保留確定。
// 保留すると翌9時の自動投稿を止め、その事例は今後の自動候補からも外れる。
import { env, verifyToken, signToken, readLatestState, appendState, cwPostMessage, readForm } from "../scripts/preview-flow.js";

export const config = { runtime: "nodejs", maxDuration: 30 };

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function shell(res, code, emoji, title, bodyHtml, color) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(code).send(`<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;background:#f3eee3;color:#222;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box">
<div style="max-width:460px;width:100%;background:#fff;border-radius:18px;padding:32px 24px;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center">
<div style="font-size:52px;line-height:1">${emoji}</div>
<h1 style="font-size:20px;margin:14px 0 10px;color:${color}">${esc(title)}</h1>
${bodyHtml}
<p style="font-size:12px;color:#999;margin-top:22px">いつき家 施工事例インスタ</p>
</div></body></html>`);
}
function msgP(text) { return `<p style="font-size:15px;line-height:1.7;color:#444;margin:0;white-space:pre-wrap">${esc(text)}</p>`; }

export default async function handler(req, res) {
  const e = env();
  const method = (req.method || "GET").toUpperCase();
  let token = (req.query?.t || "").toString();
  let confirmed = false;
  if (method === "POST") {
    const form = await readForm(req);
    token = (form.t || token).toString();
    confirmed = form.go === "1" || form.go === 1;
  }
  const payload = verifyToken(token);
  if (!payload || payload.a !== "reject") {
    return shell(res, 400, "⚠️", "リンクが無効です", msgP("このリンクは無効か期限切れです。最新のプレビュー通知から操作してください。"), "#b03a37");
  }
  const { k: key, pid } = payload;
  const editUrl = `${e.APPROVE_BASE}/edit?t=${signToken({ k: key, pid, a: "edit" })}`;
  const editBtn = `<a href="${esc(editUrl)}" style="display:inline-block;min-width:220px;min-height:48px;line-height:48px;margin-top:14px;padding:0 24px;border-radius:12px;background:#4a5d3a;color:#fff;font-size:17px;font-weight:700;text-decoration:none">✏️ 写真を選び直す</a>`;

  try {
    const state = await readLatestState(key);
    if (state?.st === "posted") {
      return shell(res, 200, "ℹ️", "すでに投稿済みです", msgP("この事例はすでに投稿されているため、保留できませんでした。"), "#3a6e4b");
    }
    if (state?.st === "rejected") {
      return shell(res, 200, "🛑", "すでに保留しています", msgP("この事例はすでに保留済みです（自動投稿は止まっています）。"), "#b0803a");
    }

    // GET：確認ページ（保留しない）
    if (method !== "POST" || !confirmed) {
      const form = `<form method="POST" action="/api/reject" style="margin:0">
<input type="hidden" name="t" value="${esc(token)}">
<button type="submit" name="go" value="1" style="min-width:220px;min-height:48px;margin-top:8px;padding:0 24px;border:0;border-radius:12px;background:#b0803a;color:#fff;font-size:17px;font-weight:700">はい、保留します</button>
</form>
<p style="font-size:12px;color:#999;margin-top:12px">この事例は自動投稿を止め、今後の自動候補からも外れます（載せ直しは担当・上月翔へ）</p>`;
      return shell(res, 200, "🤔", "この投稿を保留しますか？", msgP("保留すると、あす朝9時の自動投稿を止めます。") + form + `<div style="font-size:13px;color:#888;margin-top:18px">または、止めずに写真だけ選び直せます👇</div>` + editBtn, "#b0803a");
    }

    // POST：保留確定
    await appendState({ k: key, pid, st: "rejected", via: "reject", t: Date.now() });
    await cwPostMessage(e.SALES_GROUP_ROOM_ID,
      "[info]❌ この事例は保留にしました（自動投稿を止めました）。\n載せ直し・修正が必要なら担当（上月翔）にお知らせください。[/info]");
    return shell(res, 200, "🛑", "保留しました", msgP("自動投稿を止めました。\nこのまま写真を選び直して投稿し直すこともできます👇") + editBtn, "#b0803a");
  } catch (err) {
    return shell(res, 500, "⚠️", "処理に失敗しました", msgP(`エラーが出ました。担当（上月翔）に連絡してください。\n\n(${err.message})`), "#b03a37");
  }
}
