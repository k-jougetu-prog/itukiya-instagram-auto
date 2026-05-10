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

async function getWpPostsBatch({ after, before, perPage = 100, page = 1 }) {
  const params = new URLSearchParams({
    categories: String(SEKOU_CATEGORY),
    per_page: String(perPage),
    page: String(page),
    orderby: "date",
    order: "desc",
    _fields: "id,date,title,link,featured_media,content,categories",
  });
  if (after) params.set("after", after);
  if (before) params.set("before", before);
  return fetchJson(`${WP_BASE}/posts?${params}`);
}

/**
 * 投稿対象を選択
 * @param {Set<number>} postedIds - 投稿済みのpost_idセット
 * @returns {Promise<object|null>} - 選ばれたWP記事 or null
 */
export async function selectNextPost(postedIds = new Set()) {
  const now = new Date();
  const newCutoff = new Date(now.getTime() - NEW_DAYS * 86400000).toISOString();
  const recentCutoff = new Date(now);
  recentCutoff.setFullYear(recentCutoff.getFullYear() - RECENT_YEARS);
  const recentCutoffStr = recentCutoff.toISOString();

  // ステップ1: 新着14日以内に未投稿があるか
  const newPosts = await getWpPostsBatch({ after: newCutoff, perPage: 50 });
  const newUnposted = newPosts.filter((p) => !postedIds.has(p.id));
  if (newUnposted.length > 0) {
    // 新着優先（最新）
    return { post: newUnposted[0], reason: "new" };
  }

  // ステップ2: 3年以内のフォールバック（古い順から消化）
  // 全件まとめて取って、未投稿のうち最も古いものを返す
  let allPosts = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await getWpPostsBatch({
      after: recentCutoffStr,
      before: now.toISOString(),
      perPage: 100,
      page,
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    allPosts = allPosts.concat(batch);
    if (batch.length < 100) break;
  }
  const recentUnposted = allPosts.filter((p) => !postedIds.has(p.id));
  if (recentUnposted.length === 0) {
    return { post: null, reason: "exhausted" };
  }
  // 古い順
  recentUnposted.sort((a, b) => new Date(a.date) - new Date(b.date));
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
      const matches = caption.matchAll(/itukiya\.jp\/works\/post-(\d+)/g);
      for (const match of matches) {
        ids.add(parseInt(match[1], 10));
      }
    }
    if (data.paging?.next) {
      url = data.paging.next;
    } else {
      break;
    }
  }
  return ids;
}

async function getMediaUrl(mediaId) {
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

function buildCaption(post) {
  const title = post.title.rendered
    .replace(/&#8211;/g, "–")
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, "&");
  return [
    title,
    "",
    "📷 詳しい施工内容と費用感はプロフィールリンクから🔗",
    `${post.link}`,
    "",
    "─────────",
    "🏡 株式会社いつき家｜創業29年",
    "📍三重県松阪市の地域密着リフォーム会社",
    "📞0120-939-878（営業電話一切なし）",
    "🛡安心の10年間笑顔保証",
    "🕒10-18時／水曜定休",
    "",
    "#松阪リフォーム #松阪市リフォーム #いつき家 #三重県松阪市 #リフォーム #リフォーム会社 #リノベーション #施工事例 #松阪市 #三重県 #創業29年 #地域密着 #笑顔リフォーム #10年保証",
  ].join("\n");
}

export async function buildPostPayload(post) {
  const featuredUrl = await getMediaUrl(post.featured_media);
  const bodyImages = extractBodyImages(post.content.rendered);
  const ordered = [];
  if (featuredUrl) ordered.push(featuredUrl);
  for (const u of bodyImages) {
    if (!ordered.includes(u)) ordered.push(u);
  }
  const images = ordered.slice(0, MAX_IMAGES);
  const caption = buildCaption(post);
  return { images, caption };
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

  console.log(`📰 #${post.id} (${reason}): ${post.title.rendered}`);
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
