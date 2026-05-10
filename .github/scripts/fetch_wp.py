"""WP REST APIから施工事例とお知らせを取得して JSON にキャッシュ。

GitHub Actions上で実行されるので XSERVER に弾かれずに通る。
出力先: data/sekou.json, data/news.json
"""
import json
import os
import urllib.request
import urllib.parse
from datetime import datetime, timezone

WP_BASE = "https://itukiya.jp/wp-json/wp/v2"
SEKOU_CATEGORY = 7    # 施工事例
NEWS_CATEGORY = 663   # お知らせ
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

OUT_DIR = "data"
os.makedirs(OUT_DIR, exist_ok=True)


def fetch_json(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_posts(category, per_page=100, max_pages=5):
    """指定カテゴリの投稿を取得。複数ページ対応。"""
    all_posts = []
    for page in range(1, max_pages + 1):
        params = urllib.parse.urlencode({
            "categories": category,
            "per_page": per_page,
            "page": page,
            "orderby": "date",
            "order": "desc",
            "_fields": "id,date,title,link,featured_media,content,categories",
        })
        url = f"{WP_BASE}/posts?{params}"
        try:
            posts = fetch_json(url)
        except Exception as e:
            print(f"  page {page} error: {e}")
            break
        if not isinstance(posts, list) or not posts:
            break
        all_posts.extend(posts)
        if len(posts) < per_page:
            break
    return all_posts


def fetch_media_url(media_id):
    if not media_id:
        return None
    url = f"{WP_BASE}/media/{media_id}?_fields=source_url"
    try:
        m = fetch_json(url)
        return m.get("source_url")
    except Exception:
        return None


def extract_body_images(html):
    import re
    imgs = re.findall(r'<img[^>]+src="([^"]+)"', html or "")
    seen = set()
    out = []
    for u in imgs:
        if "wp-content/uploads" not in u:
            continue
        if u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def enrich_post(post):
    """投稿に featured_url, body_images を付加して画像URLを保持する形にする。"""
    featured_url = fetch_media_url(post.get("featured_media"))
    body_images = extract_body_images(post.get("content", {}).get("rendered", ""))
    return {
        "id": post["id"],
        "date": post["date"],
        "title": post.get("title", {}).get("rendered", ""),
        "link": post.get("link"),
        "categories": post.get("categories", []),
        "featured_url": featured_url,
        "body_images": body_images,
    }


def main():
    print("📥 施工事例（cat=7）取得中...")
    sekou_raw = fetch_posts(SEKOU_CATEGORY)
    print(f"   {len(sekou_raw)}件")
    sekou = [enrich_post(p) for p in sekou_raw]

    print("📥 お知らせ（cat=663）取得中...")
    news_raw = fetch_posts(NEWS_CATEGORY, max_pages=2)
    print(f"   {len(news_raw)}件")
    news = [enrich_post(p) for p in news_raw]

    timestamp = datetime.now(timezone.utc).isoformat()

    sekou_out = os.path.join(OUT_DIR, "sekou.json")
    news_out = os.path.join(OUT_DIR, "news.json")

    with open(sekou_out, "w", encoding="utf-8") as f:
        json.dump({"updated_at": timestamp, "count": len(sekou), "posts": sekou},
                  f, ensure_ascii=False, indent=2)
    with open(news_out, "w", encoding="utf-8") as f:
        json.dump({"updated_at": timestamp, "count": len(news), "posts": news},
                  f, ensure_ascii=False, indent=2)

    print(f"✅ {sekou_out} ({len(sekou)})")
    print(f"✅ {news_out} ({len(news)})")


if __name__ == "__main__":
    main()
