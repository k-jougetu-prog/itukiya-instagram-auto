// 画像プロキシ：itukiya.jp の画像を Vercel 経由でクリーンに再配信。
// Instagram Graph API が「メディアURIが要件を満たしていません」(code 9004 / subcode 2207052)
// を返すケースの回避用。Meta側のfetcherがオリジナルでコケる
// （EXIF orientation異常 / nginxヘッダ等の組合せ）を、Vercel の素直なレスポンスで包み直す。
//
// 使い方:
//   GET /api/img?u=<encoded-https://itukiya.jp/...画像URL>
// 動作:
//   - itukiya.jp 配下のhttps画像のみ許可（オープンリレー防止）
//   - 画像バイト列はそのまま透過配信（パススルー版）
//   - Content-Type は上流のものを採用。なければ拡張子から推定
//   - キャッシュは1日

export const config = { runtime: "nodejs", maxDuration: 30 };

const ALLOW_HOST = /^itukiya\.jp$/i;

function guessTypeFromExt(url) {
  const m = url.toLowerCase().match(/\.(jpe?g|png|webp|gif)(?:\?|$)/);
  if (!m) return "image/jpeg";
  const ext = m[1];
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

export default async function handler(req, res) {
  const u = (req.query?.u || "").toString();
  if (!u) {
    res.status(400).json({ error: "missing u" });
    return;
  }

  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    res.status(400).json({ error: "invalid url" });
    return;
  }
  if (parsed.protocol !== "https:" || !ALLOW_HOST.test(parsed.hostname)) {
    res.status(400).json({ error: "host not allowed" });
    return;
  }

  try {
    const upstream = await fetch(parsed.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/*,*/*;q=0.8",
      },
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `upstream ${upstream.status}` });
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ctype = upstream.headers.get("content-type") || guessTypeFromExt(u);
    res.setHeader("Content-Type", ctype);
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).end(buf);
  } catch (e) {
    res.status(502).json({ error: e?.message || "fetch failed" });
  }
}
