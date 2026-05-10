// 挨拶投稿（@itukiya_reform_official 開設のご挨拶）
// 使い方:
//   node scripts/post-intro.js --dry   # ドライラン
//   node scripts/post-intro.js         # 本番投稿

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const ENV_PATH = path.join(ROOT, ".env.local");

function loadEnv() {
  const txt = fs.readFileSync(ENV_PATH, "utf8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}
loadEnv();

const DRY = process.argv.includes("--dry");
const IG_USER_ID = process.env.IG_USER_ID;
const IG_USER_TOKEN = process.env.IG_USER_TOKEN;
const GRAPH = "https://graph.instagram.com/v21.0";

// 公開済みの画像URL（Vercel）
const HOST = "https://itukiya-instagram-auto-240u9fnpt-itukiya-jp.vercel.app";
const IMAGES = [
  `${HOST}/intro/01_staff_wave.jpg`,
  `${HOST}/intro/02_signboard.jpg`,
  `${HOST}/intro/03_philosophy.jpg`,
  `${HOST}/intro/04_content.jpg`,
];

const CAPTION = `【ご挨拶】株式会社いつき家、Instagram新公式アカウント開設しました🎉

＼はじめまして／
地元松阪市で創業29年✨
リフォーム会社「いつき家」です。

この度、地元の皆さまにもっと私たちのことを知っていただきたく、新しい公式Instagramを開設しました🏡

1枚目の写真は、個性豊かなスタッフ一同です😊
「どんな人がお家に来るんだろう…？」という不安を、私たちの笑顔で安心に変えたいと思っています。

2枚目は、松阪市の中心街にあるいつき家の看板。
おかげさまで、松阪市の皆さまに長年ご愛顧いただいています。

【私たちの想い】
🏡「松阪市民のため」のリフォーム会社
✨「ありがとう」「笑顔」が集まる会社になる

リフォームを通じて、お客様から「ありがとう」のお言葉をいただき、家族みんなが「笑顔」になれる空間をつくる。
それが、いつき家の何よりの喜びであり、使命です。

このアカウントでは
✅ 劇的Before→After 施工事例（毎週月水金更新予定）
✅ 失敗しないリフォームの豆知識
✅ 現場の裏側やスタッフの日常

など、皆さまのお役に立てる情報を発信していきます。

📞0120-939-878（営業電話は一切かけません）
🛡安心の10年間笑顔保証
🕒営業時間 10:00-18:00／水曜定休

お住まいの「困った」を「よかった」に変えるお手伝いをさせてください。

ぜひ「フォロー」や「いいね」で応援していただけると嬉しいです！
これからどうぞよろしくお願いいたします🙇‍♂️

🏡 株式会社いつき家｜創業29年
📍三重県松阪市大黒田町1799-3 三恵ビル1階
📞0120-939-878

#松阪リフォーム #松阪市リフォーム #いつき家 #三重県松阪市 #リフォーム会社 #リノベーション #初投稿 #はじめまして #公式アカウント #松阪市 #三重県 #創業29年 #地域密着 #笑顔リフォーム #10年保証`;

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
    err.body = json;
    throw err;
  }
  return json;
}

async function createMediaContainer({ imageUrl, caption, isCarouselItem, children, mediaType }) {
  const params = new URLSearchParams();
  if (imageUrl) params.set("image_url", imageUrl);
  if (caption) params.set("caption", caption);
  if (isCarouselItem) params.set("is_carousel_item", "true");
  if (children?.length) params.set("children", children.join(","));
  if (mediaType) params.set("media_type", mediaType);
  params.set("access_token", IG_USER_TOKEN);
  const res = await fetchJson(`${GRAPH}/${IG_USER_ID}/media`, { method: "POST", body: params });
  return res.id;
}

async function publish(creationId) {
  const params = new URLSearchParams();
  params.set("creation_id", creationId);
  params.set("access_token", IG_USER_TOKEN);
  const res = await fetchJson(`${GRAPH}/${IG_USER_ID}/media_publish`, { method: "POST", body: params });
  return res.id;
}

async function waitForReady(containerId, maxSec = 90) {
  for (let i = 0; i < maxSec; i += 3) {
    const r = await fetchJson(
      `${GRAPH}/${containerId}?fields=status_code,status&access_token=${IG_USER_TOKEN}`,
    );
    if (r.status_code === "FINISHED") return true;
    if (r.status_code === "ERROR" || r.status_code === "EXPIRED") {
      throw new Error(`Container failed: ${JSON.stringify(r)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Container ready timeout");
}

async function main() {
  console.log(DRY ? "🔍 DRY RUN" : "🚀 LIVE POST (挨拶投稿)");
  console.log("---");
  console.log(`🖼️  Images (${IMAGES.length}):`);
  IMAGES.forEach((u, i) => console.log(`   ${i + 1}. ${u}`));
  console.log(`\n📝 Caption (${CAPTION.length} chars):`);
  console.log(CAPTION);
  console.log("---");

  if (DRY) {
    console.log("✅ Dry run complete.");
    return;
  }

  console.log("⏳ Creating child containers...");
  const childIds = [];
  for (let i = 0; i < IMAGES.length; i++) {
    const cid = await createMediaContainer({ imageUrl: IMAGES[i], isCarouselItem: true });
    childIds.push(cid);
    console.log(`   ${i + 1}/${IMAGES.length} -> ${cid}`);
  }

  console.log("⏳ Creating carousel container...");
  const carouselId = await createMediaContainer({
    mediaType: "CAROUSEL",
    children: childIds,
    caption: CAPTION,
  });
  console.log(`   Carousel: ${carouselId}`);

  console.log("⏳ Waiting for ready...");
  await waitForReady(carouselId);

  console.log("⏳ Publishing...");
  const mediaId = await publish(carouselId);
  console.log(`✅ Published! Media ID: ${mediaId}`);
  console.log(`👀 https://www.instagram.com/itukiya_reform_official/`);
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  if (e.body) console.error(JSON.stringify(e.body, null, 2));
  process.exit(1);
});
