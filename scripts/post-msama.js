// M様邸 まるっとピカピカ手動投稿（写真5枚を指定）
import fs from "node:fs";
import path from "node:path";
import { postToInstagram } from "./post.js";

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

const IMAGES = [
  "https://itukiya.jp/wordpress/wp-content/uploads/2026/04/IMG_4649.jpg", // 外観完成
  "https://itukiya.jp/wordpress/wp-content/uploads/2026/04/IMG_4634.jpg", // LDK完成
  "https://itukiya.jp/wordpress/wp-content/uploads/2026/04/IMG_4629.jpg", // LDK別アングル
  "https://itukiya.jp/wordpress/wp-content/uploads/2026/04/IMG_4635.jpg", // キッチン
  "https://itukiya.jp/wordpress/wp-content/uploads/2026/04/IMG_4646.jpg", // 浴室
];

const CAPTION = `まるっとピカピカ！内外装フルリフォームで新築のように生まれ変わった家／松阪市／M様邸

詳しい施工内容と費用感はプロフィールリンクからどうぞ🔗

松阪市の地域密着リフォーム屋「いつき家」です。
創業29年、地元一筋でやってきました。
ご相談・お見積もりはお気軽に。
☎ 0120-939-878（営業電話は一切しません）
10〜18時／水曜定休

#松阪リフォーム #松阪市リフォーム #いつき家 #三重県松阪市 #リフォーム #リフォーム会社 #リノベーション #フルリフォーム #施工事例 #松阪市 #三重県 #創業29年 #地域密着 #笑顔リフォーム #10年保証 #post53777`;

console.log(DRY ? "🔍 DRY RUN" : "🚀 LIVE POST");
console.log(`Images (${IMAGES.length}):`);
IMAGES.forEach((u, i) => console.log(`  ${i + 1}. ${u.split("/").pop()}`));
console.log(`\nCaption (${CAPTION.length} chars):\n${CAPTION}`);
console.log("---");

if (DRY) {
  console.log("✅ Dry run complete.");
  process.exit(0);
}

const mediaId = await postToInstagram({
  images: IMAGES,
  caption: CAPTION,
  igUserId: process.env.IG_USER_ID,
  igToken: process.env.IG_USER_TOKEN,
});
console.log(`✅ Published! Media ID: ${mediaId}`);
console.log(`👀 https://www.instagram.com/itukiya_reform_official/`);
