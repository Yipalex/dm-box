"""微博私信备份 · 本地服务（仅监听 127.0.0.1，数据不出本机）。

启动：./.venv/bin/uvicorn server.app:app --host 127.0.0.1 --port 8765
"""
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db, export, media_worker

app = FastAPI(title="微博私信备份本地服务")

# 请求来自浏览器扩展的 background（带 host_permissions），CORS 放开仅为兜底；服务只绑 127.0.0.1
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).resolve().parent / "static"


@app.on_event("startup")
def _startup():
    db.get_conn()
    media_worker.start()


class IngestBody(BaseModel):
    uid: str
    mode: str = "full"  # full / incremental / passive
    messages: list[dict]


class ContactBody(BaseModel):
    uid: str
    screen_name: str | None = None
    avatar_url: str | None = None


class CookieBody(BaseModel):
    cookie: str


@app.get("/api/health")
def health():
    return {"ok": True, "service": "weibo-dm-backup", "cookie_set": media_worker.has_cookie()}


@app.post("/api/cookies")
def set_cookies(body: CookieBody):
    """插件推送的登录 Cookie，仅存内存用于下载私信附件，不落盘。"""
    media_worker.set_cookie(body.cookie)
    return {"ok": True}


@app.get("/api/self")
def self_info():
    return db.get_self_info()


@app.post("/api/ingest")
def ingest(body: IngestBody):
    if not body.uid:
        raise HTTPException(400, "uid required")
    return db.ingest_messages(body.uid, body.messages, body.mode)


@app.post("/api/contacts")
def save_contact(body: ContactBody):
    db.upsert_contact(body.uid, body.screen_name, body.avatar_url)
    return {"ok": True}


@app.get("/api/sync_state")
def sync_state(uid: str):
    conn = db.get_conn()
    row = conn.execute(
        "SELECT COUNT(*) AS n, MAX(CAST(mid AS INTEGER)) AS max_mid,"
        " MIN(CAST(mid AS INTEGER)) AS min_mid FROM messages WHERE uid=?",
        (uid,),
    ).fetchone()
    return {
        "uid": uid,
        "count": row["n"],
        "max_mid": str(row["max_mid"] or 0),
        "min_mid": str(row["min_mid"] or 0),
    }


@app.get("/api/contacts")
def contacts():
    conn = db.get_conn()
    rows = conn.execute(
        """SELECT c.uid, c.screen_name, c.avatar_url, c.avatar_path, c.last_sync_at,
                  COUNT(m.mid) AS msg_count,
                  MAX(m.created_at) AS last_msg_at
           FROM contacts c LEFT JOIN messages m ON m.uid = c.uid
           GROUP BY c.uid ORDER BY last_msg_at DESC"""
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/days")
def days(uid: str):
    """该会话有消息的日期及条数，给日历组件用。"""
    conn = db.get_conn()
    rows = conn.execute(
        "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM messages"
        " WHERE uid=? AND created_at != '' GROUP BY day ORDER BY day",
        (uid,),
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/messages")
def messages(
    uid: str,
    before_mid: str | None = None,
    after_mid: str | None = None,
    from_date: str | None = None,
    limit: int = Query(100, le=500),
):
    """四种取法：默认最新一页(倒序)；before_mid 向更早(倒序)；
    after_mid 向更晚(正序)；from_date 从某天 0 点开始(正序，配合日历跳转)。"""
    conn = db.get_conn()
    base = "SELECT mid, direction, type, text, created_at FROM messages WHERE uid=?"
    if from_date:
        rows = conn.execute(
            base + " AND created_at >= ? ORDER BY CAST(mid AS INTEGER) ASC LIMIT ?",
            (uid, from_date, limit),
        ).fetchall()
    elif after_mid:
        rows = conn.execute(
            base + " AND CAST(mid AS INTEGER) > ? ORDER BY CAST(mid AS INTEGER) ASC LIMIT ?",
            (uid, int(after_mid), limit),
        ).fetchall()
    elif before_mid:
        rows = conn.execute(
            base + " AND CAST(mid AS INTEGER) < ? ORDER BY CAST(mid AS INTEGER) DESC LIMIT ?",
            (uid, int(before_mid), limit),
        ).fetchall()
    else:
        rows = conn.execute(
            base + " ORDER BY CAST(mid AS INTEGER) DESC LIMIT ?",
            (uid, limit),
        ).fetchall()
    result = []
    media_rows = conn.execute(
        "SELECT mid, local_path, type FROM media WHERE status='done' AND mid IN (%s)"
        % ",".join("?" * len(rows)),
        [r["mid"] for r in rows],
    ).fetchall() if rows else []
    media_map: dict[str, list] = {}
    for m in media_rows:
        media_map.setdefault(m["mid"], []).append({"path": m["local_path"], "type": m["type"]})
    for r in rows:
        d = dict(r)
        d["media"] = media_map.get(r["mid"], [])
        result.append(d)
    return result


@app.get("/api/search")
def search(q: str, uid: str | None = None, limit: int = Query(50, le=200)):
    conn = db.get_conn()
    like = f"%{q}%"
    if uid:
        rows = conn.execute(
            "SELECT mid, uid, direction, text, created_at FROM messages"
            " WHERE uid=? AND text LIKE ? ORDER BY created_at DESC LIMIT ?",
            (uid, like, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT mid, uid, direction, text, created_at FROM messages"
            " WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?",
            (like, limit),
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/stats")
def stats():
    conn = db.get_conn()
    msg = conn.execute("SELECT COUNT(*) AS n FROM messages").fetchone()["n"]
    contacts_n = conn.execute("SELECT COUNT(*) AS n FROM contacts").fetchone()["n"]
    media_done = conn.execute("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM media WHERE status='done'").fetchone()
    media_pending = conn.execute("SELECT COUNT(*) AS n FROM media WHERE status='pending'").fetchone()["n"]
    last_sync = conn.execute("SELECT run_at, contact_uid, mode, new_count FROM sync_log ORDER BY id DESC LIMIT 1").fetchone()
    return {
        "messages": msg,
        "contacts": contacts_n,
        "media_done": media_done["n"],
        "media_bytes": media_done["b"],
        "media_pending": media_pending,
        "last_sync": dict(last_sync) if last_sync else None,
    }


@app.get("/api/sync_log")
def sync_log(limit: int = Query(30, le=200)):
    conn = db.get_conn()
    rows = conn.execute("SELECT * FROM sync_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/export")
def do_export(
    uid: str,
    from_date: str | None = None,
    to_date: str | None = None,
):
    conn = db.get_conn()
    if not conn.execute("SELECT 1 FROM messages WHERE uid=? LIMIT 1", (uid,)).fetchone():
        raise HTTPException(404, "该联系人没有已备份的消息")
    out = export.export_contact(uid, from_date or None, to_date or None)
    return {"ok": True, "path": str(out), "name": out.name}


@app.get("/exports/{name}")
def get_export(name: str):
    path = export.EXPORT_DIR / name
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)


app.mount("/media", StaticFiles(directory=str(db.DATA_DIR / "media"), check_dir=False), name="media")
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
