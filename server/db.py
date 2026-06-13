"""SQLite 存储层：messages / contacts / media / sync_log。

- mid 用 TEXT 主键，避免 64 位整数精度问题
- 原始 JSON 整条入库（raw_json），保证未来可重建任意导出格式
- 媒体二进制不入库，只存相对路径 + sha256
"""
import json
import re
import sqlite3
import threading
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "weibo_dm.db"

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS contacts(
    uid TEXT PRIMARY KEY,
    screen_name TEXT,
    avatar_url TEXT,
    avatar_path TEXT,
    last_sync_mid TEXT,
    last_sync_at TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS messages(
    mid TEXT PRIMARY KEY,
    uid TEXT NOT NULL,
    sender_id TEXT,
    recipient_id TEXT,
    direction TEXT,
    type TEXT,
    text TEXT,
    created_at TEXT,
    raw_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_uid_created ON messages(uid, created_at);
CREATE TABLE IF NOT EXISTS media(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mid TEXT,
    orig_url TEXT UNIQUE,
    sha256 TEXT,
    type TEXT,
    local_path TEXT,
    status TEXT DEFAULT 'pending',
    bytes INTEGER,
    downloaded_at TEXT,
    retries INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_media_status ON media(status);
CREATE TABLE IF NOT EXISTS sync_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at TEXT,
    contact_uid TEXT,
    mode TEXT,
    new_count INTEGER,
    dup_count INTEGER,
    status TEXT
);
"""

WEIBO_TIME_FMT = "%a %b %d %H:%M:%S %z %Y"  # "Fri Jul 08 15:48:42 +0800 2011"

MEDIA_URL_RE = re.compile(
    r"https?://[\w.\-]+\.sinaimg\.cn/[^\s\"'\\<>]+|"
    r"https?://[\w.\-]*(?:weibocdn|sinajs|video\.weibo)\.(?:com|cn)/[^\s\"'\\<>]+\.(?:mp4|mov|mp3|amr|wav)[^\s\"'\\<>]*",
    re.IGNORECASE,
)


def get_conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.executescript(SCHEMA)
        _local.conn = conn
    return conn


def parse_created_at(value) -> str:
    """微博时间 → ISO8601；解析失败原样返回字符串。"""
    if not value:
        return ""
    try:
        return datetime.strptime(str(value), WEIBO_TIME_FMT).isoformat()
    except ValueError:
        return str(value)


# 这些字段是完整的 user 对象，里面的头像 URL 不是消息附件
USER_OBJECT_KEYS = {"sender", "recipient", "user", "from_user", "to_user", "users"}
# 字段名带这些特征的也是头像/用户资料，不是附件（可能嵌套在任意层级）
AVATARISH_KEY_RE = re.compile(r"avatar|profile_image|portrait|head_?url|usericon|icon_url", re.I)
# 微博头像专用域名（tva1/tvax1 等）及典型头像路径，整体排除
AVATAR_URL_RE = re.compile(r"//tva[^.]*\.sinaimg\.cn|/crop\.|/default/", re.I)


def _without_user_objects(obj):
    """递归剔除 user 对象和头像类字段，只留真正可能是附件的内容。"""
    if isinstance(obj, dict):
        return {
            k: _without_user_objects(v)
            for k, v in obj.items()
            if k not in USER_OBJECT_KEYS and not AVATARISH_KEY_RE.search(k)
        }
    if isinstance(obj, list):
        return [_without_user_objects(v) for v in obj]
    return obj


# 实抓样本核实：私信附件通过 media_type + att_ids（附件 fid）表示，
# 文件需带登录 Cookie 从 upload.api.weibo.com 取
MEDIA_TYPE_MAP = {1: "image", 4: "voice", 10: "video"}
ATT_URL_TMPL = "https://upload.api.weibo.com/2/mss/msget?fid={fid}&source=209678993"


def detect_type(msg: dict) -> str:
    mt = msg.get("media_type")
    if mt in MEDIA_TYPE_MAP:
        return MEDIA_TYPE_MAP[mt]
    if msg.get("att_ids"):
        return "file"
    if "sinaimg.cn" in json.dumps(_without_user_objects(msg), ensure_ascii=False):
        return "image"
    if msg.get("text"):
        return "text"
    return "other"


def extract_media_urls(msg: dict) -> list[str]:
    urls = []
    for fid in msg.get("att_ids") or []:
        urls.append(ATT_URL_TMPL.format(fid=fid))
    raw = json.dumps(_without_user_objects(msg), ensure_ascii=False).replace("\\/", "/")
    for u in MEDIA_URL_RE.findall(raw):
        u = u.rstrip(").,;")
        if AVATAR_URL_RE.search(u):
            continue
        if u not in urls:
            urls.append(u)
    return urls


def get_self_info() -> dict:
    """从最近一条自己发出的消息里取自己的昵称和头像（raw_json 里有完整 sender 对象）。"""
    conn = get_conn()
    row = conn.execute(
        "SELECT raw_json FROM messages WHERE direction='out'"
        " ORDER BY CAST(mid AS INTEGER) DESC LIMIT 1"
    ).fetchone()
    if not row:
        return {}
    sender = json.loads(row["raw_json"]).get("sender") or {}
    avatar_dir = DATA_DIR / "media" / "avatars"
    local = next(iter(sorted(avatar_dir.glob("self.*"))), None) if avatar_dir.is_dir() else None
    return {
        "screen_name": sender.get("screen_name") or sender.get("name") or "我",
        "avatar_url": sender.get("avatar_large") or sender.get("profile_image_url") or "",
        "avatar_local": f"avatars/{local.name}" if local else "",
    }


def upsert_contact(uid: str, screen_name: str | None = None, avatar_url: str | None = None):
    conn = get_conn()
    now = datetime.now().isoformat(timespec="seconds")
    row = conn.execute("SELECT uid FROM contacts WHERE uid=?", (uid,)).fetchone()
    if row:
        if screen_name or avatar_url:
            conn.execute(
                "UPDATE contacts SET screen_name=COALESCE(?,screen_name),"
                " avatar_url=COALESCE(?,avatar_url), updated_at=? WHERE uid=?",
                (screen_name, avatar_url, now, uid),
            )
    else:
        conn.execute(
            "INSERT INTO contacts(uid, screen_name, avatar_url, updated_at) VALUES(?,?,?,?)",
            (uid, screen_name, avatar_url, now),
        )
    conn.commit()


def ingest_messages(uid: str, messages: list[dict], mode: str) -> dict:
    """逐条 upsert，返回 {new, dup, hit_known}。hit_known=本批中出现了库里已有的 mid。"""
    conn = get_conn()
    new = dup = 0
    hit_known = False
    contact_name = None
    contact_avatar = None
    for msg in messages:
        mid = str(msg.get("mid") or msg.get("idstr") or msg.get("id") or "").strip()
        if not mid:
            continue
        exists = conn.execute("SELECT 1 FROM messages WHERE mid=?", (mid,)).fetchone()
        if exists:
            dup += 1
            hit_known = True
            continue
        sender_id = str(msg.get("sender_id") or "")
        recipient_id = str(msg.get("recipient_id") or "")
        direction = "in" if sender_id == str(uid) else "out"
        # 顺手从消息体里取联系人昵称/头像
        partner = msg.get("sender") if direction == "in" else msg.get("recipient")
        if isinstance(partner, dict):
            contact_name = partner.get("screen_name") or contact_name
            contact_avatar = partner.get("avatar_large") or partner.get("profile_image_url") or contact_avatar
        conn.execute(
            "INSERT INTO messages(mid, uid, sender_id, recipient_id, direction, type, text, created_at, raw_json)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (
                mid, str(uid), sender_id, recipient_id, direction,
                detect_type(msg),
                msg.get("text") or "",
                parse_created_at(msg.get("created_at")),
                json.dumps(msg, ensure_ascii=False),
            ),
        )
        for url in extract_media_urls(msg):
            conn.execute(
                "INSERT OR IGNORE INTO media(mid, orig_url, type) VALUES(?,?,?)",
                (mid, url, detect_type(msg)),
            )
        new += 1
    upsert_contact(str(uid), contact_name, contact_avatar)
    row = conn.execute("SELECT MAX(CAST(mid AS INTEGER)) AS m FROM messages WHERE uid=?", (str(uid),)).fetchone()
    if row and row["m"]:
        conn.execute(
            "UPDATE contacts SET last_sync_mid=?, last_sync_at=? WHERE uid=?",
            (str(row["m"]), datetime.now().isoformat(timespec="seconds"), str(uid)),
        )
    conn.execute(
        "INSERT INTO sync_log(run_at, contact_uid, mode, new_count, dup_count, status) VALUES(?,?,?,?,?,?)",
        (datetime.now().isoformat(timespec="seconds"), str(uid), mode, new, dup, "ok"),
    )
    conn.commit()
    return {"new": new, "dup": dup, "hit_known": hit_known}
