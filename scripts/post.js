// 施工事例の自動Instagramカルーセル投稿
// CLI:
//   node scripts/post.js                    # WPの最新事例を本番投稿（投稿済み管理なし）
//   node scripts/post.js --dry              # 最新事例をドライラン
//   node scripts/post.js --post-id=54210    # 指定IDの事例を投稿
//   node scripts/post.js --post-id=54210 --dry
//
// 関数として import すると:
//   import { selectNextPost, postToInstagram } from "./post.js";

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const ENV_PATH = path.join(ROOT, ".env.local");

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  const txt = fs.readFileSync(ENV_PATH, "utf8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}
loadEnv();

const WP_BASE = "https://itukiya.jp/wp-json/wp/v2";
const SEKOU_CATEGORY = 7;
const GRAPH = "https://graph.instagram.com/v21.0";
const MAX_IMAGES = 5; // インスタは最大10だがHP誘導を優先して5枚に制限
const NEW_DAYS = 14; // 「新着」判定の日数（公開からの日数）
// ストック消化の対象開始日。新着がない時はこの日以降の未投稿事例を古い順に投げる。
// 2023年初頭の物件にもまだ魅力的なものが多いので固定日にしている（ローリング3年窓だと
// 時間が経つと2023年前半が対象外に落ちてしまうため）。さらに古いものまで遡りたくなったら
// 環境変数 STOCK_SINCE で前倒しできる（例 "2022-01-01"）。
const STOCK_SINCE = process.env.STOCK_SINCE || "2023-01-01";

// 写真の品質チェック（昔の自作記事は写真が少なかったり質が粗いことがあるため、
// 「中途半端な写真は採用しない／そういう記事は飛ばす」を AI で機械的にやる）
const MIN_GOOD_IMAGES = 2; // 選別後この枚数を下回ったらその記事はスキップして次へ
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const PHOTO_QC_MODEL = process.env.PHOTO_QC_MODEL || "claude-sonnet-4-6"; // 写真の良し悪し判定
const PHOTO_QC_MAX_TRIES = 12; // ストック消化時、写真が薄い記事を最大何件まで読み飛ばすか
const PHOTO_QC = process.env.PHOTO_QC !== "0"; // "0" で品質チェック無効化（フォールバック用）

// XSERVER WAFがVercel Functions経由のWP直叩きを403でブロックするため、
// GitHub Actionsで定期キャッシュしたJSONを使う
const CACHE_URL = "https://raw.githubusercontent.com/k-jougetu-prog/itukiya-instagram-auto/main/data/sekou.json";

// 「投稿してIGから削除した」記事は再投稿しない（IG履歴からは消えてるため自動再投稿を防ぐ）
const IGNORE_POST_IDS = new Set([
  54210, // O様邸 外構補修工事（2026-05-10 テスト投稿→削除）
]);

export async function fetchJson(url, init) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    ...(init?.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * GitHub raw URL から施工事例キャッシュJSONを取得
 */
export async function fetchSekouCache() {
  const data = await fetchJson(CACHE_URL);
  return data.posts || [];
}

/**
 * 投稿対象を選択
 * @param {Set<number>} postedIds - 投稿済みのpost_idセット
 * @returns {Promise<{post: object|null, reason: string}>}
 */
export async function selectNextPost(postedIds = new Set(), extraExcludes = new Set()) {
  const all = await fetchSekouCache();
  const now = new Date();
  const newCutoff = now.getTime() - NEW_DAYS * 86400000;
  const stockSince = new Date(`${STOCK_SINCE}T00:00:00+09:00`);

  const isExcluded = (p) =>
    postedIds.has(p.id) || IGNORE_POST_IDS.has(p.id) || extraExcludes.has(p.id);

  // ステップ1: 新着14日以内、未投稿、新しい順
  const newUnposted = all
    .filter((p) => new Date(p.date).getTime() >= newCutoff)
    .filter((p) => !isExcluded(p))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  if (newUnposted.length > 0) {
    return { post: newUnposted[0], reason: "new" };
  }

  // ステップ2: STOCK_SINCE以降の未投稿を「古い順」から消化（＝2023年初頭の物件から順番に）
  const stockUnposted = all
    .filter((p) => new Date(p.date) >= stockSince)
    .filter((p) => !isExcluded(p))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (stockUnposted.length === 0) {
    return { post: null, reason: "exhausted" };
  }
  return { post: stockUnposted[0], reason: "stock" };
}

/**
 * Instagramの自分の投稿一覧から、キャプションのHP URLを抽出して
 * 「投稿済みのWP post-id」セットを返す。外部ストレージ不要のシンプル方式。
 */
export async function getPostedIds(igUserId, igToken) {
  const ids = new Set();
  let url = `${GRAPH}/${igUserId}/media?fields=caption,timestamp&limit=100&access_token=${igToken}`;
  // ページング対応（最大3ページまで）
  for (let i = 0; i < 3; i++) {
    const data = await fetchJson(url);
    for (const m of data.data || []) {
      const caption = m.caption || "";
      // 旧形式：キャプション内HP URL、新形式：#postXXXXX ハッシュタグ
      const urlMatches = caption.matchAll(/itukiya\.jp\/works\/post-(\d+)/g);
      for (const match of urlMatches) ids.add(parseInt(match[1], 10));
      const tagMatches = caption.matchAll(/#post(\d+)/g);
      for (const match of tagMatches) ids.add(parseInt(match[1], 10));
    }
    if (data.paging?.next) {
      url = data.paging.next;
    } else {
      break;
    }
  }
  return ids;
}

function buildCaption(post) {
  // titleはJSONキャッシュ時点で post.title.rendered or post.title (string)
  const titleRaw = typeof post.title === "string" ? post.title : (post.title?.rendered || "");
  const title = titleRaw
    .replace(/&#8211;/g, "–")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, "")
    .replace(/&#8221;/g, "")
    .replace(/[“”]/g, "")
    .replace(/"/g, "")
    .replace(/&amp;/g, "&");
  return [
    title,
    "",
    "詳しい施工内容と費用感はプロフィールのリンクからどうぞ🔗",
    "気になるところがあれば、お気軽にコメントやDMでもOKです💬",
    "",
    "──────────",
    "松阪市の地域密着リフォーム屋「いつき家」🌿",
    "29年、松阪のおうちのお悩みに寄り添ってきました。",
    "ご相談・お見積もりはお気軽に！",
    "",
    "☎ 0120-939-878（営業電話は一切しません🙅‍♂️）",
    "🕐 10〜18時／🚫水曜定休",
    "",
    `#松阪リフォーム #松阪市リフォーム #いつき家 #三重県松阪市 #リフォーム #リフォーム会社 #リノベーション #施工事例 #松阪市 #三重県 #創業29年 #地域密着 #笑顔リフォーム #10年保証 #post${post.id}`,
  ].join("\n");
}

// 同じ写真のサイズ違い（…-900x675.jpg / …-scaled.jpg 等）を同一視するためのキー。
// 例: IMG_0674.jpg と IMG_0674-900x675.jpg → 同じ「IMG_0674」 → カルーセルで重複させない
function imageDedupKey(url) {
  try {
    let name = new URL(url).pathname.split("/").pop() || url;
    name = name.replace(/\.[a-z0-9]+$/i, "");          // 拡張子除去
    name = name.replace(/-scaled$/i, "");               // WordPressの -scaled
    name = name.replace(/-\d{2,5}x\d{2,5}$/i, "");      // -900x675 等のサイズ接尾辞
    return name.toLowerCase();
  } catch {
    return url;
  }
}

/**
 * 画像をafter優先で並び替える。サイズ違いの重複は除去する。
 * - 1枚目: featured（アイキャッチ＝メイン完成カット）
 * - 2枚目以降: after優先で並べつつ、before も対比として混ぜる
 */
function reorderImages(featuredUrl, bodyImages, max) {
  const seenKeys = new Set();
  const result = [];
  const tryPush = (u) => {
    if (!u || result.length >= max) return;
    const k = imageDedupKey(u);
    if (seenKeys.has(k)) return;
    seenKeys.add(k);
    result.push(u);
  };
  tryPush(featuredUrl);

  const isAfter = (u) => /[\/\-_.]after[\/\-_.]/i.test(u);
  const isBefore = (u) => /[\/\-_.]before[\/\-_.]/i.test(u);
  const remaining = bodyImages.filter((u) => !seenKeys.has(imageDedupKey(u)));
  const afters = remaining.filter(isAfter);
  const befores = remaining.filter(isBefore);
  const others = remaining.filter((u) => !isAfter(u) && !isBefore(u));

  const queue = (afters.length > 0 || befores.length > 0)
    // ファイル名に before/after が含まれる事例 → After2枚 → Before2枚 → 残りafter → その他 → 残りbefore
    ? [...afters.slice(0, 2), ...befores.slice(0, 2), ...afters.slice(2), ...others, ...befores.slice(2)]
    // before/after判定なしの事例 → 本文順（従来動作）
    : bodyImages;
  for (const u of queue) tryPush(u);
  return result.slice(0, max);
}

/**
 * 候補画像を Claude（vision）に見せて「施工事例カルーセルに出して見栄えする写真」だけ残す。
 * 昔の自作記事の粗い写真・何だかわからない写真を機械的に弾くのが目的。迷ったら落とす方針。
 * API失敗時は「落とさない（元のまま）」でフォールバック（パイプラインを止めない）。
 * @returns {Promise<{kept: string[], dropped: string[], note: string}>}
 */
export async function curateImages(images, post) {
  if (!PHOTO_QC || !images.length) return { kept: images, dropped: [], note: "QCスキップ" };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { kept: images, dropped: [], note: "ANTHROPIC_API_KEY未設定→QCスキップ" };

  const titleStr = (typeof post?.title === "string" ? post.title : post?.title?.rendered || "").slice(0, 80);
  const content = [
    {
      type: "text",
      text: [
        "あなたはリフォーム会社の公式Instagram（施工事例カルーセル）の品質チェック担当です。",
        `記事「${titleStr}」の投稿候補写真を 1枚目から ${images.length} 枚見せます。各写真の直前に【写真N】と番号を付けています。`,
        "やることは『明らかにダメな写真を取り除く』だけです。キュレーション（ベストを選ぶ）ではありません。",
        "■ 原則：基本は全部 keep。少しでも施工箇所（外壁・屋根・水廻り・内装・外構・玄関・サッシ等）や完成の様子が普通に見て取れるなら採用。迷ったら必ず keep。",
        "■ drop（落とす）に入れるのは次のような明白なNGだけ：ブレている／ピンボケ／極端に暗い・白飛びで内容が見えない／何を撮ったのか本当に判別できない／施工と無関係（人物のスナップ・車・看板・室内で人が主役、書類や図面のスクショ、PC/スマホ画面のキャプチャ等）／画質が極端に粗く投稿に耐えない。",
        "■ 次の程度の理由では drop しない：『他にもっと良い写真がある』『似た構図がある』『ディテールに寄りすぎ』『画角がやや狭い』『生活感が少し写る』『プロのライターが撮ったものではなさそう』など。素人写真でも内容が分かれば keep。",
        "■ 1枚目はアイキャッチ（記事のメイン完成カット）。よほど崩れていない限り keep。",
        '出力は JSON のみ・前置きや解説は一切なし。形式: {"keep":[採用する写真番号を昇順],"drop":[落とす写真番号],"note":"dropした理由を一言・無ければ空文字（40字以内）"}',
      ].join("\n"),
    },
    ...images.map((url, i) => ([
      { type: "text", text: `【写真${i + 1}】` },
      { type: "image", source: { type: "url", url } },
    ])).flat(),
  ];

  let parsed;
  try {
    const r = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: PHOTO_QC_MODEL, max_tokens: 300, messages: [{ role: "user", content }] }),
    });
    const text = await r.text();
    if (!r.ok) return { kept: images, dropped: [], note: `QC失敗(HTTP ${r.status})→全採用` };
    const j = JSON.parse(text);
    const out = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    const m = out.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch (e) {
    return { kept: images, dropped: [], note: `QC例外(${e.message})→全採用` };
  }
  if (!parsed || !Array.isArray(parsed.keep)) return { kept: images, dropped: [], note: "QC応答不正→全採用" };

  const keepIdx = new Set(parsed.keep.map((n) => Number(n) - 1).filter((i) => Number.isInteger(i) && i >= 0 && i < images.length));
  const kept = images.filter((_, i) => keepIdx.has(i));
  const dropped = images.filter((_, i) => !keepIdx.has(i));
  return { kept, dropped, note: (parsed.note || "").toString().slice(0, 60) };
}

export async function buildPostPayload(post) {
  // キャッシュJSONから来た場合は featured_url, body_images が既に展開済み
  // CLI で WP API直叩き（--post-id）の場合は content.rendered + featured_media なので fallback
  const featuredUrl = post.featured_url
    ?? (post.featured_media ? await getMediaUrlFallback(post.featured_media) : null);
  const bodyImages = post.body_images
    ?? extractBodyImages(post.content?.rendered || "");
  const candidates = reorderImages(featuredUrl, bodyImages, MAX_IMAGES);
  const qc = await curateImages(candidates, post);
  const images = qc.kept;
  const caption = buildCaption(post);
  return { images, caption, candidates, qc };
}

/**
 * 「次に投稿すべき、かつ写真が成立する」記事を選ぶ。
 * 選んだ記事の写真が選別後 MIN_GOOD_IMAGES 未満なら、その記事は飛ばして次の候補へ（最大 PHOTO_QC_MAX_TRIES 回）。
 * @returns {Promise<{post:object, reason:string, images:string[], caption:string, qc:object, skipped:Array}|{post:null, reason:string, skipped:Array}>}
 */
export async function pickPostablePost(postedIds = new Set()) {
  const extraExcludes = new Set();
  const skipped = [];
  for (let i = 0; i < PHOTO_QC_MAX_TRIES; i++) {
    const sel = await selectNextPost(postedIds, extraExcludes);
    if (!sel.post) return { post: null, reason: sel.reason, skipped };
    const payload = await buildPostPayload(sel.post);
    if (payload.images.length >= MIN_GOOD_IMAGES) {
      return { post: sel.post, reason: sel.reason, images: payload.images, caption: payload.caption, qc: payload.qc, skipped };
    }
    // 写真が薄い → この記事は今回スキップして次へ
    const titleStr = typeof sel.post.title === "string" ? sel.post.title : (sel.post.title?.rendered || "");
    skipped.push({ id: sel.post.id, title: titleStr, date: (sel.post.date || "").slice(0, 10), kept: payload.images.length, dropped: payload.qc?.dropped?.length ?? 0 });
    extraExcludes.add(sel.post.id);
  }
  return { post: null, reason: "no-good-photos", skipped };
}

// CLI から --post-id 指定時用のフォールバック（ローカル実行のみ）
async function getMediaUrlFallback(mediaId) {
  if (!mediaId) return null;
  const m = await fetchJson(`${WP_BASE}/media/${mediaId}?_fields=source_url`);
  return m.source_url;
}

function extractBodyImages(html) {
  const imgs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  return imgs.filter((u) => {
    if (!u.includes("wp-content/uploads")) return false;
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

async function createMediaContainer(igUserId, igToken, opts) {
  const { imageUrl, caption, isCarouselItem, children, mediaType } = opts;
  const params = new URLSearchParams();
  if (imageUrl) params.set("image_url", imageUrl);
  if (caption) params.set("caption", caption);
  if (isCarouselItem) params.set("is_carousel_item", "true");
  if (children?.length) params.set("children", children.join(","));
  if (mediaType) params.set("media_type", mediaType);
  params.set("access_token", igToken);
  const res = await fetchJson(`${GRAPH}/${igUserId}/media`, {
    method: "POST",
    body: params,
  });
  return res.id;
}

async function publishMedia(igUserId, igToken, creationId) {
  const params = new URLSearchParams();
  params.set("creation_id", creationId);
  params.set("access_token", igToken);
  const res = await fetchJson(`${GRAPH}/${igUserId}/media_publish`, {
    method: "POST",
    body: params,
  });
  return res.id;
}

async function waitForReady(igToken, containerId, maxSec = 90) {
  for (let i = 0; i < maxSec; i += 3) {
    const r = await fetchJson(
      `${GRAPH}/${containerId}?fields=status_code,status&access_token=${igToken}`,
    );
    if (r.status_code === "FINISHED") return true;
    if (r.status_code === "ERROR" || r.status_code === "EXPIRED") {
      throw new Error(`Container failed: ${JSON.stringify(r)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Container ready timeout");
}

/**
 * Instagram投稿実行
 */
export async function postToInstagram({ images, caption, igUserId, igToken }) {
  if (!images.length) throw new Error("No images");

  if (images.length === 1) {
    const cid = await createMediaContainer(igUserId, igToken, {
      imageUrl: images[0],
      caption,
    });
    await waitForReady(igToken, cid);
    return await publishMedia(igUserId, igToken, cid);
  }

  // カルーセル
  const childIds = [];
  for (const u of images) {
    const cid = await createMediaContainer(igUserId, igToken, {
      imageUrl: u,
      isCarouselItem: true,
    });
    childIds.push(cid);
  }
  const carouselId = await createMediaContainer(igUserId, igToken, {
    mediaType: "CAROUSEL",
    children: childIds,
    caption,
  });
  await waitForReady(igToken, carouselId);
  return await publishMedia(igUserId, igToken, carouselId);
}

// ===== CLIエントリポイント =====
async function mainCli() {
  const argv = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] ?? true] : [a, true];
    }),
  );
  const DRY = !!argv.dry;
  const POST_ID = argv["post-id"] || null;
  const IG_USER_ID = process.env.IG_USER_ID;
  const IG_USER_TOKEN = process.env.IG_USER_TOKEN;
  if (!IG_USER_ID || !IG_USER_TOKEN) {
    console.error("Missing IG_USER_ID / IG_USER_TOKEN in .env.local");
    process.exit(1);
  }

  console.log(DRY ? "🔍 DRY RUN" : "🚀 LIVE POST");

  let post;
  let reason = "manual";
  let images, caption, qc, candidates;
  if (POST_ID) {
    post = await fetchJson(`${WP_BASE}/posts/${POST_ID}`);
    ({ images, caption, qc, candidates } = await buildPostPayload(post));
  } else {
    const postedIds = await getPostedIds(IG_USER_ID, IG_USER_TOKEN);
    console.log(`📌 既投稿: ${postedIds.size}件`);
    const pick = await pickPostablePost(postedIds);
    if (pick.skipped?.length) {
      console.log(`⏭️  写真不足でスキップ: ${pick.skipped.map((s) => `#${s.id}(${s.date}) ${s.title}`).join(" / ")}`);
    }
    if (!pick.post) {
      console.log(`⚠️  投稿対象なし（${pick.reason}）`);
      return;
    }
    post = pick.post;
    reason = pick.reason;
    images = pick.images;
    caption = pick.caption;
    qc = pick.qc;
  }

  const titleStr = typeof post.title === "string" ? post.title : (post.title?.rendered || "");
  console.log(`📰 #${post.id} (${reason}): ${titleStr}`);
  console.log(`📅 ${post.date}`);
  console.log(`🔗 ${post.link}`);

  if (qc?.dropped?.length) {
    console.log(`🧹 QC除外 ${qc.dropped.length}枚${qc.note ? " (" + qc.note + ")" : ""}:`);
    qc.dropped.forEach((u) => console.log(`   ✗ ${u}`));
  }
  console.log(`🖼️  Images (${images.length}/${MAX_IMAGES}):`);
  images.forEach((u, i) => console.log(`   ${i + 1}. ${u}`));
  if (!images.length) {
    console.log("⚠️  採用画像0枚。投稿しません。");
    return;
  }
  console.log(`\n📝 Caption (${caption.length} chars):`);
  console.log(caption);
  console.log("---");

  if (DRY) {
    console.log("✅ Dry run complete.");
    return;
  }

  const mediaId = await postToInstagram({
    images,
    caption,
    igUserId: IG_USER_ID,
    igToken: IG_USER_TOKEN,
  });
  console.log(`✅ Published! Media ID: ${mediaId}`);
  console.log(`👀 https://www.instagram.com/itukiya_reform_official/`);
}

const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  mainCli().catch((e) => {
    console.error("❌ Error:", e.message);
    if (e.body) console.error(JSON.stringify(e.body, null, 2));
    process.exit(1);
  });
}
