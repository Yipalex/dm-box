"""媒体下载后台线程：限速（每个文件间隔 2–4 秒）、带 sinaimg 防盗链 Referer、按 sha256 落盘去重。

附加职责：
- AMR 语音自动转码为浏览器可播的 M4A（保留原始 AMR）
- 联系人/自己的头像下载到本地（微博头像 URL 带签名会过期，必须本地化）
"""
import hashlib
import mimetypes
import random
import shutil
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

import requests

from . import db

MEDIA_DIR = db.DATA_DIR / "media"
AVATAR_DIR = MEDIA_DIR / "avatars"
HEADERS = {
    "Referer": "https://weibo.com",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
}
MAX_RETRIES = 3

# 私信附件 (upload.api.weibo.com) 需要登录 Cookie，由插件推送、只存内存
UPLOAD_HOST = "upload.api.weibo.com"
_cookie = {"value": None}

_stop = threading.Event()


def set_cookie(value: str):
    _cookie["value"] = value


def has_cookie() -> bool:
    return bool(_cookie["value"])


def amr_to_m4a(amr_path: Path, m4a_path: Path) -> bool:
    """AMR → M4A。优先 ffmpeg，其次 macOS 自带 afconvert。"""
    if shutil.which("ffmpeg"):
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(amr_path), "-c:a", "aac", str(m4a_path)]
    elif shutil.which("afconvert"):
        cmd = ["afconvert", "-f", "m4af", "-d", "aac", str(amr_path), str(m4a_path)]
    else:
        return False
    try:
        ok = subprocess.run(cmd, capture_output=True, timeout=60).returncode == 0
        return ok and m4a_path.is_file()
    except Exception:
        return False


def _ext_for(url: str, content_type: str | None) -> str:
    for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".mov", ".mp3", ".amr", ".wav"):
        if ext in url.lower():
            return ".jpg" if ext == ".jpeg" else ext
    if content_type:
        guessed = mimetypes.guess_extension(content_type.split(";")[0].strip())
        if guessed:
            return guessed
    return ".bin"


def _download_one(row) -> None:
    conn = db.get_conn()
    url = row["orig_url"]
    try:
        headers = dict(HEADERS)
        if UPLOAD_HOST in url:
            headers["Cookie"] = _cookie["value"]
            headers["Referer"] = "https://api.weibo.com/chat"
        resp = requests.get(url, headers=headers, timeout=60)
        resp.raise_for_status()
        ctype = (resp.headers.get("Content-Type") or "").lower()
        # 返回 JSON/HTML 说明拿到的是错误页（如 Cookie 失效），按失败处理
        if "json" in ctype or "html" in ctype:
            raise ValueError(f"unexpected content-type: {ctype}")
        data = resp.content
        sha = hashlib.sha256(data).hexdigest()
        ext = _ext_for(url, resp.headers.get("Content-Type"))
        if data[:5] == b"#!AMR":
            ext = ".amr"
        MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        rel_path = f"{sha[:2]}/{sha}{ext}"
        target = MEDIA_DIR / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.write_bytes(data)
        if ext == ".amr":
            # 浏览器播不了 AMR：转出一份 M4A 作为展示文件，AMR 原件保留
            m4a = target.with_suffix(".m4a")
            if m4a.is_file() or amr_to_m4a(target, m4a):
                rel_path = f"{sha[:2]}/{sha}.m4a"
        conn.execute(
            "UPDATE media SET sha256=?, local_path=?, status='done', bytes=?, downloaded_at=? WHERE id=?",
            (sha, rel_path, len(data), datetime.now().isoformat(timespec="seconds"), row["id"]),
        )
    except Exception:
        retries = (row["retries"] or 0) + 1
        status = "failed" if retries >= MAX_RETRIES else "pending"
        conn.execute("UPDATE media SET retries=?, status=? WHERE id=?", (retries, status, row["id"]))
    conn.commit()


# 每次服务运行期间，每个头像只尝试下载一次（签名 URL 可能过期，失败标记 failed，
# 下次「加载联系人」推来新签名 URL 后会再试）
_avatar_attempted: set[str] = set()


def _fetch_avatar(url: str) -> tuple[bytes, str]:
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    ctype = (resp.headers.get("Content-Type") or "").lower()
    if not ctype.startswith("image/"):
        raise ValueError(f"not an image: {ctype}")
    return resp.content, (_ext_for(url.split("?")[0], ctype) or ".jpg")


def _sync_avatars():
    conn = db.get_conn()
    rows = conn.execute(
        "SELECT uid, avatar_url FROM contacts WHERE avatar_url IS NOT NULL AND avatar_url != ''"
        " AND (avatar_path IS NULL OR avatar_path='' OR avatar_path='failed')"
    ).fetchall()
    for r in rows:
        uid = r["uid"]
        if uid in _avatar_attempted or _stop.is_set():
            continue
        _avatar_attempted.add(uid)
        try:
            data, ext = _fetch_avatar(r["avatar_url"])
            AVATAR_DIR.mkdir(parents=True, exist_ok=True)
            (AVATAR_DIR / f"{uid}{ext}").write_bytes(data)
            conn.execute("UPDATE contacts SET avatar_path=? WHERE uid=?", (f"avatars/{uid}{ext}", uid))
        except Exception:
            conn.execute("UPDATE contacts SET avatar_path='failed' WHERE uid=?", (uid,))
        conn.commit()
        _stop.wait(random.uniform(1, 2))
    # 自己的头像（从最近一条发出消息提取）
    if "self" not in _avatar_attempted:
        info = db.get_self_info()
        url = info.get("avatar_url")
        if url and not (AVATAR_DIR.is_dir() and list(AVATAR_DIR.glob("self.*"))):
            _avatar_attempted.add("self")
            try:
                data, ext = _fetch_avatar(url)
                AVATAR_DIR.mkdir(parents=True, exist_ok=True)
                (AVATAR_DIR / f"self{ext}").write_bytes(data)
            except Exception:
                pass


def _worker_loop():
    while not _stop.is_set():
        _sync_avatars()
        conn = db.get_conn()
        # 没拿到 Cookie 前，跳过需要登录态的附件，只下公开的 sinaimg 资源
        if has_cookie():
            row = conn.execute(
                "SELECT * FROM media WHERE status='pending' ORDER BY id LIMIT 1"
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM media WHERE status='pending' AND orig_url NOT LIKE ?"
                " ORDER BY id LIMIT 1",
                (f"%{UPLOAD_HOST}%",),
            ).fetchone()
        if row is None:
            _stop.wait(10)
            continue
        _download_one(row)
        _stop.wait(random.uniform(2, 4))


def start():
    t = threading.Thread(target=_worker_loop, name="media-worker", daemon=True)
    t.start()
    return t
