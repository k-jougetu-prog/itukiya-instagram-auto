// 施工事例インスタ「投稿前プレビュー承認」フローの共有ロジック。
//
// 流れ（2026-09-09 上月さん決定）:
//   1) 投稿予定日の【前日13時】に投稿内容を組み立て、写真7枚のモンタージュ＋文面を
//      通知Bot経由で「いつきや営業グループ」へ [toall] 通知（写真一覧・キャプション・✅/❌リンク付き）。
//   2) 誰かが ✅ を押す → その場で即投稿。 ❌ → 保留。
//   3) どちらも押されないまま【翌朝9時】になったら、その内容で自動投稿（黙認GO）。
//
// 状態ストア: 追加インフラ無しで回すため、通知Bot自身のマイチャット(STATE_ROOM_ID)へ
//   1行JSONの状態レコードを追記していく“append-onlyログ”。最新レコードが有効値。
// 認証: ✅/❌リンクは CRON_SECRET を鍵にした HMAC 署名トークンで保護。
//
// 選定の要: 大型複合工事(写真数十枚)で施工後を取りこぼさないよう、候補を絞らず
//   featured＋本文全枚数(重複除去)を vision(curateImages) に見せてから After 先頭で7枚に絞る。

import crypto from "node:crypto";
import {
  fetchSekouCache,
  selectNextPost,
  getPostedIds,
  curateImages,
  reorderByClassification,
  buildCaption,
  coverMeta,
  postToInstagram,
  postStory,
} from "./post.js";
import { buildMontageBuffer } from "./montage.mjs";
export { buildMontageBuffer };

const CW_API = "https://api.chatwork.com/v2";
const MAX_IMAGES = 7;            // 最終投稿枚数（post.js と揃える）
const MIN_GOOD_IMAGES = 2;
const CANDIDATE_HARD_CAP = 40;   // visionに見せる最大枚数の安全上限

// ---- 環境変数 ----
export function env() {
  return {
    NOTIFY_BOT_TOKEN: process.env.NOTIFY_BOT_TOKEN,      // 通知Bot(11503714)のCWトークン
    SALES_GROUP_ROOM_ID: process.env.SALES_GROUP_ROOM_ID, // いつき家営業グループ room_id
    OWNER_DM_ROOM_ID: process.env.OWNER_DM_ROOM_ID || "441983801", // 上月翔の通知Bот direct（✅❌ボタン送付先）
    STATE_ROOM_ID: process.env.STATE_ROOM_ID || "441983755", // 通知Botのマイチャット（状態ログ）
    APPROVE_BASE: process.env.APPROVE_BASE || "https://itukiya-instagram-auto.vercel.app",
    CRON_SECRET: process.env.CRON_SECRET,
    IG_USER_ID: process.env.IG_USER_ID,
    IG_USER_TOKEN: process.env.IG_USER_TOKEN,
  };
}

// ================= Chatwork（通知Bot） =================
function cwHeaders(token) {
  return { "X-ChatWorkToken": token };
}

export async function cwPostMessage(roomId, body, token = env().NOTIFY_BOT_TOKEN) {
  const r = await fetch(`${CW_API}/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { ...cwHeaders(token), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ body }),
  });
  if (!r.ok) throw new Error(`CW post ${r.status}: ${await r.text()}`);
  return r.json();
}

/** モンタージュ(PNG Buffer)＋本文を1メッセージとしてアップロード */
export async function cwUploadImage(roomId, buffer, filename, message, token = env().NOTIFY_BOT_TOKEN) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "image/png" }), filename);
  if (message) form.append("message", message);
  const r = await fetch(`${CW_API}/rooms/${roomId}/files`, {
    method: "POST",
    headers: cwHeaders(token), // Content-Typeはfetchがmultipart境界付きで自動設定
    body: form,
  });
  if (!r.ok) throw new Error(`CW upload ${r.status}: ${await r.text()}`);
  return r.json();
}

/** 最新最大100件のメッセージ本文を取得（force=1で未読状態に依らず取得） */
export async function cwGetMessages(roomId, token = env().NOTIFY_BOT_TOKEN) {
  const r = await fetch(`${CW_API}/rooms/${roomId}/messages?force=1`, { headers: cwHeaders(token) });
  if (r.status === 204) return []; // メッセージ無し
  if (!r.ok) throw new Error(`CW get messages ${r.status}: ${await r.text()}`);
  return r.json();
}

// ================= 状態ログ（append-only） =================
const STATE_TAG = "IGSTATE";

/** 状態レコードを1行JSONで STATE_ROOM に追記 */
export async function appendState(rec) {
  const { STATE_ROOM_ID } = env();
  const line = `${STATE_TAG} ${JSON.stringify(rec)}`;
  return cwPostMessage(STATE_ROOM_ID, line);
}

/** STATE_ROOMの全メッセージを状態レコード配列に変換し、記録時刻 t の昇順に並べる
 *  （Chatwork APIの返却順に依存せず「後勝ち」を正しく判定するため t でソート） */
async function readAllStates() {
  const { STATE_ROOM_ID } = env();
  const msgs = await cwGetMessages(STATE_ROOM_ID);
  const out = [];
  for (const msg of msgs) {
    const body = msg.body || "";
    const idx = body.indexOf(STATE_TAG);
    if (idx < 0) continue;
    try { out.push(JSON.parse(body.slice(idx + STATE_TAG.length).trim())); } catch { /* skip */ }
  }
  out.sort((a, b) => (a?.t || 0) - (b?.t || 0)); // 古い→新しい（t基準）
  return out;
}

/** 指定key(投稿予定日 YYYY-MM-DD)の状態を返す（無ければnull）。
 *  同一keyの複数レコードをt昇順にマージする＝stは最新レコード優先、
 *  imgs/pid/caption等のペイロードは「それを持つ最新レコード」から補完する。
 *  （承認/保留レコードはst等の差分しか書かないため、pending時に確定した
 *   画像ペイロードをマージで引き継がないと post cron が投稿できなくなる。） */
export async function readLatestState(key) {
  const all = await readAllStates();
  const recs = all.filter((r) => r && r.k === key); // 既にt昇順
  if (!recs.length) return null;
  const merged = {};
  for (const r of recs) for (const [k, v] of Object.entries(r)) {
    if (v !== undefined && v !== null) merged[k] = v; // 後勝ち＝最新値が勝つ、欠損は上書きしない
  }
  return merged;
}

/** 直近で「保留(rejected)のまま」の記事IDセットを返す（プレビュー再提示を防ぐ） */
export async function readRejectedPids() {
  const all = await readAllStates();
  const lastByPid = new Map(); // pid → 最新st（古い→新しい順に上書き）
  for (const r of all) if (r && r.pid != null) lastByPid.set(r.pid, r.st);
  const set = new Set();
  for (const [pid, st] of lastByPid) if (st === "rejected") set.add(Number(pid));
  return set;
}

// ================= 署名トークン =================
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}
export function signToken(payload) {
  const { CRON_SECRET } = env();
  if (!CRON_SECRET) throw new Error("CRON_SECRET未設定：署名できません");
  const data = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", CRON_SECRET).update(data).digest();
  return `${data}.${b64url(sig)}`;
}
export function verifyToken(token) {
  const { CRON_SECRET } = env();
  if (!CRON_SECRET) return null; // 鍵が無ければ全て無効（偽造トークン受理を防ぐ）
  if (!token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", CRON_SECRET || "").update(data).digest();
  let ok = false;
  try {
    const got = b64urlDecode(sig);
    ok = got.length === expect.length && crypto.timingSafeEqual(got, expect);
  } catch { ok = false; }
  if (!ok) return null;
  try { return JSON.parse(b64urlDecode(data).toString("utf8")); } catch { return null; }
}

// ================= 選定（複合工事対応・全写真をvisionへ） =================
function imageDedupKey(url) {
  try {
    let name = new URL(url).pathname.split("/").pop() || url;
    name = name.replace(/\.[a-z0-9]+$/i, "").replace(/-scaled$/i, "").replace(/-\d{2,5}x\d{2,5}$/i, "");
    return name.toLowerCase();
  } catch { return url; }
}

/** 1記事 → {images(最大7・After先頭), caption, qc} を全写真ベースで構築 */
export async function buildWidePayload(post) {
  const featured = post.featured_url ?? null;
  const body = post.body_images ?? [];
  const seen = new Set();
  const candidates = [];
  for (const u of [featured, ...body]) {
    if (!u) continue;
    const k = imageDedupKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    candidates.push(u);
    if (candidates.length >= CANDIDATE_HARD_CAP) break;
  }
  const qc = await curateImages(candidates, post);
  let images = reorderByClassification(qc.kept, qc, MAX_IMAGES);
  // 半々BA表紙を1枚目に差す（同一箇所のBA対が取れた時のみ）。表紙＋本文7＝最大8枚。
  let coverUrl = null;
  if (qc.coverAfter && qc.coverBefore) {
    const { APPROVE_BASE } = env();
    const { title, enSub } = coverMeta(post);
    const q = new URLSearchParams({ b: qc.coverBefore, a: qc.coverAfter, t: title, e: enSub });
    coverUrl = `${APPROVE_BASE}/api/cover?${q.toString()}`;
    images = [coverUrl, ...images].slice(0, MAX_IMAGES + 1);
  }
  const caption = buildCaption(post);
  return { images, caption, qc, candidates, coverUrl };
}

/** 次に投稿すべき「写真が成立する」記事を選ぶ（除外考慮・薄い記事はスキップ） */
export async function selectPostable(postedIds, extraExcludes = new Set(), maxTries = 12) {
  for (let i = 0; i < maxTries; i++) {
    const sel = await selectNextPost(postedIds, extraExcludes);
    if (!sel.post) return { post: null, reason: sel.reason };
    const payload = await buildWidePayload(sel.post);
    if (payload.images.length >= MIN_GOOD_IMAGES) {
      return { post: sel.post, reason: sel.reason, ...payload };
    }
    extraExcludes.add(sel.post.id);
  }
  return { post: null, reason: "no-good-photos" };
}

/** postIdから記事を引く（キャプション再構築・publish用） */
export async function getPostById(postId) {
  const all = await fetchSekouCache();
  return all.find((p) => p.id === Number(postId)) || null;
}

// ================= 投稿実行 =================
/** 与えられた画像配列＋記事で本投稿し、告知ストーリーも投げる（storyは失敗しても無視） */
export async function publishSelection({ images, post }) {
  const { IG_USER_ID, IG_USER_TOKEN } = env();
  const caption = buildCaption(post);
  const { mediaId, failedImages } = await postToInstagram({
    images, caption, igUserId: IG_USER_ID, igToken: IG_USER_TOKEN,
  });
  let storyId = null;
  try {
    // 告知ストーリーのheroは本文のApp写真(After)を使う。1枚目が半々BA表紙(/api/cover)の時は
    // 二重加工になるので避け、表紙でない最初の写真を選ぶ。
    const heroForStory = images.find((u) => !u.includes("/api/cover")) || images[0];
    if (heroForStory) ({ storyId } = await postStory({ heroImageUrl: heroForStory, igUserId: IG_USER_ID, igToken: IG_USER_TOKEN }));
  } catch { /* ストーリー失敗はフィード投稿を壊さない */ }
  return { mediaId, storyId, failedImages };
}

// ================= 日付・文面 =================
/** JSTの日付文字列(YYYY-MM-DD)。offsetDays日ずらし可（Vercelは UTC 実行なので+9h） */
export function jstDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
}

function cleanTitle(post) {
  const raw = typeof post.title === "string" ? post.title : (post.title?.rendered || "");
  return raw
    .replace(/&#8211;/g, "–").replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, "").replace(/&#8221;/g, "")
    .replace(/[“”]/g, "").replace(/"/g, "").replace(/&amp;/g, "&");
}

/**
 * プレビュー文面を組む。
 * @param {"group"|"owner"} variant  group=営業グループ(ボタン無し・意見募集) / owner=上月さん(✅❌ボタン付き)
 * @returns {{body:string, filename:string}}
 */
export function buildPreviewMessage({ post, images, qc, key, variant = "group" }) {
  const { APPROVE_BASE } = env();
  // 1枚目が半々BA表紙(/api/cover)なら、施工後/施工前カウントからは除外して数える。
  const hasCover = typeof images[0] === "string" && images[0].includes("/api/cover");
  const photoImgs = hasCover ? images.slice(1) : images;
  const beforeSet = new Set(qc?.before || []);
  const offset = hasCover ? 2 : 1; // 表示番号(1始まり)。表紙がある時は本文が2番から。
  const beforeNums = photoImgs.map((u, i) => (beforeSet.has(u) ? i + offset : null)).filter(Boolean);
  const afterCount = photoImgs.length - beforeNums.length;
  const [, m, d] = key.split("-");
  const dateLabel = `${Number(m)}/${Number(d)}`;
  const title = cleanTitle(post);
  const coverLine = hasCover ? "1枚目=ビフォーアフター表紙／" : "";
  const composition = beforeNums.length
    ? `・${coverLine}施工後 ${afterCount}枚／施工前 ${beforeNums.length}枚（写真${beforeNums.join("・")}番＝施工前・対比用）`
    : `・${coverLine}全${photoImgs.length}枚すべて施工後`;

  // vision品質チェックが効いていない時は承認者に必ず知らせる（施工前ばっか再発を見逃さない）。
  const qcFailed = qc?.note && /失敗|全採用|未設定|スキップ|不正|例外/.test(qc.note);
  const head = [
    "[info][title]📷 施工事例インスタ 投稿プレビュー[/title]",
    `🗓 ${dateLabel}(あす)朝9時に投稿予定`,
    `🏠 ${title}`,
    "",
    `📸 この${images.length}枚を、番号の順でカルーセル投稿します（写真は添付）`,
    composition,
    ...(qcFailed ? ["", `⚠️ 写真の自動チェックが効いていません（${qc.note}）。並び順・表紙は簡易判定なので目視確認をお願いします。`] : []),
    "",
  ];

  let body;
  if (variant === "owner") {
    const approveUrl = `${APPROVE_BASE}/api/approve?t=${signToken({ k: key, pid: post.id, a: "approve" })}`;
    const rejectUrl = `${APPROVE_BASE}/api/reject?t=${signToken({ k: key, pid: post.id, a: "reject" })}`;
    body = [
      ...head,
      "▼ 最終確認をお願いします（スマホからワンタップ）",
      "",
      "✅ これでOK（あす朝9時に投稿します）",
      approveUrl,
      "",
      "❌ 保留・直したい（投稿を止めます）",
      rejectUrl,
      "",
      "※何もしなければ、あす朝9時にこの内容で投稿されます。",
      "[/info]",
    ].join("\n");
  } else {
    body = [
      "[toall]",
      ...head,
      "▼ お気づきの点があれば【本日17時まで】にこのチャットで返信ください🙏",
      "（例：この写真もう少しこうしたい／順番を入れ替えたい 等）",
      "",
      "最終OK・保留は上月さんが判断します。特に意見が無ければ、あす朝9時にこの内容で投稿されます。",
      "[/info]",
    ].join("\n");
  }

  return { body, filename: `プレビュー_${key}_post${post.id}.png` };
}

/**
 * POSTフォーム(application/x-www-form-urlencoded)を安全に読む。
 * Vercel Node Functions は body を自動パースして req.body に入れ、生ストリームを消費済みにする。
 * そのため req.body（オブジェクト/文字列）を最優先し、無い時だけストリームにフォールバックする。
 * @returns {Promise<Object>} フォーム値のプレーンオブジェクト
 */
export async function readForm(req) {
  const b = req.body;
  if (b && typeof b === "object") return b;                       // Vercelがパース済み
  if (typeof b === "string" && b.length) return Object.fromEntries(new URLSearchParams(b));
  const raw = await new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", () => resolve(""));
  });
  return Object.fromEntries(new URLSearchParams(raw));
}

export const constants = { MAX_IMAGES, MIN_GOOD_IMAGES, CANDIDATE_HARD_CAP, STATE_TAG };
