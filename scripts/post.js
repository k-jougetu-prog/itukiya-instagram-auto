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
const RECENT_YEARS = 3; // フォールバック対象期間（年）

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
export async function selectNextPost(postedIds = new Set()) {
  const all = await fetchSekouCache();
  const now = new Date();
  const newCutoff = now.getTime() - NEW_DAYS * 86400000;
  const recentCutoff = new Date(now);
  recentCutoff.setFullYear(recentCutoff.getFullYear() - RECENT_YEARS);

  const isExcluded = (p) => postedIds.has(p.id) || IGNORE_POST_IDS.has(p.id);

  // ステップ1: 新着14日以内、未投稿、新しい順
  const newUnposted = all
    .filter((p) => new Date(p.date).getTime() >= newCutoff)
    .filter((p) => !isExcluded(p))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  if (newUnposted.length > 0) {
    return { post: newUnposted[0], reason: "new" };
  }

  // ステップ2: 3年以内、未投稿、古い順から消化
  const recentUnposted = all
    .filter((p) => new Date(p.date) >= recentCutoff)
    .filter((p) => !isExcluded(p))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (recentUnposted.length === 0) {
    return { post: null, reason: "exhausted" };
  }
  return { post: recentUnposted[0], reason: "stock" };
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
    "詳しい施工内容と費用感はプロフィールリンクからどうぞ🔗",
    "",
    "松阪市の地域密着リフォーム屋「いつき家」です。",
    "創業29年、地元一筋でやってきました。",
    "ご相談・お見積もりはお気軽に。",
    "☎ 0120-939-878（営業電話は一切しません）",
    "10〜18時／水曜定休",
    "",
    `#松阪リフォーム #松阪市リフォーム #いつき家 #三重県松阪市 #リフォーム #リフォーム会社 #リノベーション #施工事例 #松阪市 #三重県 #創業29年 #地域密着 #笑顔リフォーム #10年保証 #post${post.id}`,
  ].join("\n");
}

/**
 * 画像をafter優先で並び替える。
 * - 1枚目: featured（アイキャッチ＝メイン完成カット）
 * - 2枚目以降: after優先で並べつつ、before も対比として混ぜる
 */
function reorderImages(featuredUrl, bodyImages, max) {
  const seen = new Set();
  const result = [];
  if (featuredUrl) {
    result.push(featuredUrl);
    seen.add(featuredUrl);
  }
  const isAfter = (u) => /[\/\-_.]after[\/\-_.]/i.test(u);
  const isBefore = (u) => /[\/\-_.]before[\/\-_.]/i.test(u);

  const afters = bodyImages.filter((u) => isAfter(u) && !seen.has(u));
  const befores = bodyImages.filter((u) => isBefore(u) && !seen.has(u));
  const others = bodyImages.filter((u) => !isAfter(u) && !isBefore(u) && !seen.has(u));

  // ファイル名に before/after が含まれる事例 → after優先＋before少量で対比
  if (afters.length > 0 || befores.length > 0) {
    // After 2枚 → Before 2枚 → 残りafter → その他、の順
    const queue = [
      ...afters.slice(0, 2),
      ...befores.slice(0, 2),
      ...afters.slice(2),
      ...others,
      ...befores.slice(2),
    ];
    for (const u of queue) {
      if (result.length >= max) break;
      if (!seen.has(u)) {
        result.push(u);
        seen.add(u);
      }
    }
  } else {
    // before/after判定なしの事例 → 本文順（従来動作）
    for (const u of bodyImages) {
      if (result.length >= max) break;
      if (!seen.has(u)) {
        result.push(u);
        seen.add(u);
      }
    }
  }
  return result.slice(0, max);
}

export async function buildPostPayload(post) {
  // キャッシュJSONから来た場合は featured_url, body_images が既に展開済み
  // CLI で WP API直叩き（--post-id）の場合は content.rendered + featured_media なので fallback
  const featuredUrl = post.featured_url
    ?? (post.featured_media ? await getMediaUrlFallback(post.featured_media) : null);
  const bodyImages = post.body_images
    ?? extractBodyImages(post.content?.rendered || "");
  const images = reorderImages(featuredUrl, bodyImages, MAX_IMAGES);
  const caption = buildCaption(post);
  return { images, caption };
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
  if (POST_ID) {
    post = await fetchJson(`${WP_BASE}/posts/${POST_ID}`);
  } else {
    const postedIds = await getPostedIds(IG_USER_ID, IG_USER_TOKEN);
    console.log(`📌 既投稿: ${postedIds.size}件`);
    const sel = await selectNextPost(postedIds);
    if (!sel.post) {
      console.log("⚠️  対象事例なし（3年以内ストック消化完了 or 該当なし）");
      return;
    }
    post = sel.post;
    reason = sel.reason;
  }

  const titleStr = typeof post.title === "string" ? post.title : (post.title?.rendered || "");
  console.log(`📰 #${post.id} (${reason}): ${titleStr}`);
  console.log(`📅 ${post.date}`);
  console.log(`🔗 ${post.link}`);

  const { images, caption } = await buildPostPayload(post);
  console.log(`🖼️  Images (${images.length}/${MAX_IMAGES}):`);
  images.forEach((u, i) => console.log(`   ${i + 1}. ${u}`));
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
