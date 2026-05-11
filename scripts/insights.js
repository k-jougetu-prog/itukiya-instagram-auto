// Instagram Insights 取得 ＋ Claude 分析モジュール
// 対象: @itukiya_reform_official（Instagram API with Instagram Login / graph.instagram.com）
//
// 必要スコープ:
//   - instagram_business_basic         … プロフィール・メディア一覧（既に付与済み）
//   - instagram_business_manage_insights … インサイト（★要追加 → トークン再認証）
// スコープ未付与でも profile は取得でき、insights は per-metric でエラーを握りつぶして続行する。

const GRAPH = "https://graph.instagram.com/v21.0";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const ANALYSIS_MODEL = "claude-sonnet-4-6";

// ---- 共通 GET ----
async function igGet(path, params, token) {
  const usp = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${GRAPH}/${path}?${usp.toString()}`);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) {
    const e = new Error(`IG ${path}: HTTP ${r.status} ${text.slice(0, 300)}`);
    e.status = r.status;
    e.body = json;
    throw e;
  }
  return json;
}

function metricErr(e) {
  return e?.body?.error?.message || e?.message || String(e);
}

// ---- アカウント基本情報（instagram_business_basic で取れる）----
export async function fetchAccountProfile(igUserId, token) {
  return igGet(`${igUserId}`, {
    fields: "id,username,name,followers_count,follows_count,media_count,profile_picture_url,biography",
  }, token);
}

// ---- アカウントインサイト（直近28日中心）----
// 新APIでは多くのメトリクスに metric_type=total_value が必要。メトリクス毎に try。
export async function fetchAccountInsights(igUserId, token) {
  const out = {};
  const tryMetric = async (label, params) => {
    try {
      const j = await igGet(`${igUserId}/insights`, params, token);
      out[label] = { data: j.data };
    } catch (e) {
      out[label] = { error: metricErr(e) };
    }
  };
  await tryMetric("reach_28d",            { metric: "reach",               period: "days_28", metric_type: "total_value" });
  await tryMetric("profile_views_28d",    { metric: "profile_views",       period: "days_28", metric_type: "total_value" });
  await tryMetric("accounts_engaged_28d", { metric: "accounts_engaged",    period: "days_28", metric_type: "total_value" });
  await tryMetric("total_interactions_28d",{ metric: "total_interactions", period: "days_28", metric_type: "total_value" });
  await tryMetric("website_clicks_28d",   { metric: "website_clicks",      period: "days_28", metric_type: "total_value" });
  await tryMetric("follower_count_day",   { metric: "follower_count",      period: "day" });
  // フォロワー属性（市区町村）。breakdown 必須・lifetime のみ。
  await tryMetric("followers_by_city",    { metric: "follower_demographics", period: "lifetime", metric_type: "total_value", breakdown: "city" });
  return out;
}

function pickTotalValue(node) {
  if (!node || node.error || !Array.isArray(node.data) || !node.data.length) return null;
  const d = node.data[0];
  return d?.total_value?.value ?? d?.values?.[0]?.value ?? null;
}

// ---- 直近メディア ＋ 各メディアのインサイト ----
export async function fetchRecentMediaWithInsights(igUserId, token, limit = 12) {
  const media = await igGet(`${igUserId}/media`, {
    fields: "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count",
    limit: String(limit),
  }, token);
  const items = media.data || [];
  await Promise.all(items.map(async (m) => {
    const mpt = m.media_product_type; // FEED / REELS / STORY / AD
    let metrics;
    if (mpt === "REELS") {
      metrics = "reach,likes,comments,shares,saved,total_interactions,plays,ig_reels_avg_watch_time,ig_reels_video_view_total_time";
    } else if (m.media_type === "CAROUSEL_ALBUM") {
      metrics = "reach,likes,comments,shares,saved,total_interactions,profile_visits,follows";
    } else {
      metrics = "reach,likes,comments,shares,saved,total_interactions,profile_visits,follows";
    }
    try {
      const ins = await igGet(`${m.id}/insights`, { metric: metrics }, token);
      m.insights = Object.fromEntries(
        (ins.data || []).map((d) => [d.name, d?.values?.[0]?.value ?? d?.total_value?.value ?? null])
      );
    } catch (e) {
      m.insights = { error: metricErr(e) };
    }
  }));
  return items;
}

// ---- スナップショット組み立て ----
export async function buildSnapshot(igUserId, token) {
  const [profile, accountInsights, media] = await Promise.all([
    fetchAccountProfile(igUserId, token).catch((e) => ({ error: metricErr(e) })),
    fetchAccountInsights(igUserId, token),
    fetchRecentMediaWithInsights(igUserId, token, 12).catch((e) => ({ error: metricErr(e) })),
  ]);
  return { fetchedAt: new Date().toISOString(), profile, accountInsights, media };
}

// インサイトのスコープが付与されていない（or トークン失効）かどうかの判定
export function isInsightsScopeMissing(snapshot) {
  const ai = snapshot.accountInsights || {};
  const anySuccess = Object.values(ai).some((v) => v && !v.error && Array.isArray(v.data) && v.data.length);
  if (anySuccess) return false;
  const blob = JSON.stringify(ai);
  return /permission|scope|OAuth|#10\b|#100\b|#200\b|access token|insights/i.test(blob);
}

// ---- Claude 分析 ----
export async function analyzeWithClaude(snapshot) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: "ANTHROPIC_API_KEY 未設定" };

  const posts = (Array.isArray(snapshot.media) ? snapshot.media : []).map((m) => ({
    id: m.id,
    type: m.media_product_type || m.media_type,
    date: (m.timestamp || "").slice(0, 10),
    caption_head: ((m.caption || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "").slice(0, 70),
    likes: m.like_count,
    comments: m.comments_count,
    reach: m.insights?.reach ?? null,
    saved: m.insights?.saved ?? null,
    shares: m.insights?.shares ?? null,
    interactions: m.insights?.total_interactions ?? null,
    profile_visits: m.insights?.profile_visits ?? null,
    follows: m.insights?.follows ?? null,
    permalink: m.permalink,
  }));

  const userContent = [
    "あなたは、いつき家（三重県松阪市の総合リフォーム会社）の公式Instagram「@itukiya_reform_official」の運用アナリストです。",
    "前提：このアカウントは自社サイトの施工事例を週3回（月・水・金 朝9時）自動投稿しています。フォロワーは主に地元（松阪・三重）の既存顧客と見込み客。目的は『HPへの誘導』と『地域での認知・信頼づくり』で、フォロワー数の爆発的増加が目的ではありません。リール運用はまだしておらず、ほぼフィード（カルーセル）です。",
    "",
    "■ アカウント現況",
    JSON.stringify({ profile: snapshot.profile, accountInsights: snapshot.accountInsights }, null, 2),
    "",
    "■ 直近の投稿（新しい順）と数値（取得できなかった項目は null）",
    JSON.stringify(posts, null, 2),
    "",
    "上記をもとに、次の3つを日本語で出力してください。Chatworkにそのまま貼れる簡潔さで、各セクション見出しは【】付きで。",
    "1.【今週の読み取り】数値の要点と、伸びた投稿・伸びなかった投稿の差は何か（事例の工種／写真の見せ方／キャプションの切り口／曜日 などの仮説）。3〜5行。",
    "2.【次にやるべき投稿の方向性】上を踏まえた改善方針。3〜5項目の箇条書きで、それぞれ具体的に。",
    "3.【次の投稿シナリオ案】次回以降に試すべき具体案を2つ。各案ごとに『狙い／取り上げる事例タイプ／写真構成（何枚目に何を）／キャプションの方向性』を1〜2行ずつ。",
    "ルール：前置き・お世辞は不要。データが薄い／取得失敗が多いときは無理に断定せず『データ蓄積待ち（あとX週で傾向が見える）』と正直に書く。机上の一般論ではなく、この事例アカウントで実際に試せる案にする。",
  ].join("\n");

  const r = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      max_tokens: 2500,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  const text = await r.text();
  if (!r.ok) return { error: `Anthropic HTTP ${r.status}: ${text.slice(0, 400)}` };
  const j = JSON.parse(text);
  const analysis = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
  return { analysis, model: ANALYSIS_MODEL, usage: j.usage };
}

// ---- Chatwork ダイジェスト本文 ----
export function buildDigest(snapshot, analyzed) {
  const p = snapshot.profile || {};
  const ai = snapshot.accountInsights || {};
  const reach28 = pickTotalValue(ai.reach_28d);
  const pv28 = pickTotalValue(ai.profile_views_28d);
  const eng28 = pickTotalValue(ai.accounts_engaged_28d);
  const ti28 = pickTotalValue(ai.total_interactions_28d);
  const wc28 = pickTotalValue(ai.website_clicks_28d);
  const jst = new Date(snapshot.fetchedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  // 直近投稿の簡易リーチランキング（上位3 / 下位3）
  const ranked = (Array.isArray(snapshot.media) ? snapshot.media : [])
    .filter((m) => typeof m.insights?.reach === "number")
    .sort((a, b) => (b.insights.reach || 0) - (a.insights.reach || 0));
  const fmtPost = (m) => {
    const head = ((m.caption || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "").slice(0, 28);
    return `・${(m.timestamp || "").slice(0, 10)} リーチ${m.insights.reach} 保存${m.insights.saved ?? "-"} ｜ ${head}`;
  };
  const topLines = ranked.slice(0, 3).map(fmtPost);
  const botLines = ranked.length > 3 ? ranked.slice(-3).reverse().map(fmtPost) : [];

  const lines = [
    "[info][title]📊 Instagram週次レポート ＠itukiya_reform_official[/title]",
    `取得：${jst}`,
    "",
    `フォロワー：${p.followers_count ?? "—"}　投稿数：${p.media_count ?? "—"}`,
    `直近28日　リーチ：${reach28 ?? "—"}　プロフ閲覧：${pv28 ?? "—"}　反応アカウント：${eng28 ?? "—"}　反応総数：${ti28 ?? "—"}　サイト誘導：${wc28 ?? "—"}`,
  ];
  if (topLines.length) {
    lines.push("", "［リーチ上位］", ...topLines);
  }
  if (botLines.length) {
    lines.push("", "［リーチ下位］", ...botLines);
  }
  lines.push(
    "",
    "── AI分析・次の打ち手 ──",
    analyzed?.error ? `（AI分析スキップ：${analyzed.error}）` : (analyzed?.analysis || "（分析結果なし）"),
    "",
    "IG：https://www.instagram.com/itukiya_reform_official/",
    "[/info]"
  );
  return lines.join("\n");
}

// ---- スコープ未付与時の案内本文 ----
export function buildScopeMissingNotice(snapshot) {
  const f = snapshot.profile?.followers_count;
  return [
    "[info][title]📊 Instagram週次レポート（準備待ち）[/title]",
    "インサイト取得に必要な権限「instagram_business_manage_insights」がアクセストークンに付いていません。",
    "Metaアプリ（itukiya-sekou-poster）の権限に追加 → トークンを再認証すると、来週から数値＋AI分析が自動で出ます。",
    `（プロフィールは取得OK：フォロワー ${f ?? "—"}）`,
    "Kに「インサイトのトークン再認証」と振ってください（手順を出します）。",
    "[/info]",
  ].join("\n");
}

// ---- CLI（ローカル確認用）----
// 使い方: node --env-file=.env.local scripts/insights.js [--ai] [--digest]
//   --ai      … Claude分析も走らせる（APIコストが少額かかる）
//   --digest  … Chatworkに送る本文を組み立てて表示（送信はしない）
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const runAI = args.includes("--ai");
  const showDigest = args.includes("--digest");
  const igId = process.env.IG_USER_ID;
  const igTok = process.env.IG_USER_TOKEN;
  if (!igId || !igTok) {
    console.error("IG_USER_ID / IG_USER_TOKEN がありません。`node --env-file=.env.local scripts/insights.js` で実行してください。");
    process.exit(1);
  }
  const snap = await buildSnapshot(igId, igTok);
  const scopeMissing = isInsightsScopeMissing(snap);
  console.log("=== snapshot ===");
  console.log(JSON.stringify(snap, null, 2));
  console.log("\nscopeMissing:", scopeMissing);
  let analyzed = { skipped: true };
  if (runAI && !scopeMissing) {
    console.log("\n=== Claude分析中… ===");
    analyzed = await analyzeWithClaude(snap);
    console.log(analyzed.error ? `(error: ${analyzed.error})` : analyzed.analysis);
    if (analyzed.usage) console.log("\nusage:", JSON.stringify(analyzed.usage));
  }
  if (showDigest) {
    console.log("\n=== Chatwork本文プレビュー ===");
    console.log(scopeMissing ? buildScopeMissingNotice(snap) : buildDigest(snap, analyzed));
  }
}
