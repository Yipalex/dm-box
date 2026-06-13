"""导出只读 HTML 阅读视图（按日期分组、对话气泡、引用本地媒体）。"""
import re
from datetime import datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from . import db

EXPORT_DIR = db.DATA_DIR / "exports"
TEMPLATE_DIR = Path(__file__).resolve().parent / "templates"

_env = Environment(
    loader=FileSystemLoader(TEMPLATE_DIR),
    autoescape=select_autoescape(["html"]),
)

TAG_RE = re.compile(r"<[^>]+>")


def export_contact(uid: str, from_date: str | None = None, to_date: str | None = None) -> Path:
    """导出某联系人聊天为 HTML。可选 from_date/to_date（YYYY-MM-DD，含端点）按日期范围导出。"""
    conn = db.get_conn()
    contact = conn.execute("SELECT * FROM contacts WHERE uid=?", (uid,)).fetchone()
    sql = "SELECT * FROM messages WHERE uid=?"
    params: list = [uid]
    if from_date:
        sql += " AND created_at >= ?"
        params.append(from_date)
    if to_date:
        sql += " AND created_at < ?"  # 到 to_date 当天 23:59 → 用次日 0 点做上界
        params.append(to_date + "T99")  # ISO 字符串比较：'...T99' 大于当天任何时刻
    sql += " ORDER BY CAST(mid AS INTEGER) ASC"
    rows = conn.execute(sql, params).fetchall()
    media_map = {}
    for m in conn.execute(
        "SELECT mid, local_path, type, orig_url FROM media WHERE status='done' AND mid IN "
        "(SELECT mid FROM messages WHERE uid=?)",
        (uid,),
    ):
        media_map.setdefault(m["mid"], []).append(dict(m))

    days: list[dict] = []
    current = None
    for r in rows:
        day = (r["created_at"] or "")[:10] or "未知日期"
        if current is None or current["day"] != day:
            current = {"day": day, "messages": []}
            days.append(current)
        current["messages"].append(
            {
                "direction": r["direction"],
                "text": TAG_RE.sub("", r["text"] or ""),
                "time": (r["created_at"] or "")[11:16],
                "type": r["type"],
                "media": media_map.get(r["mid"], []),
            }
        )

    name = (contact["screen_name"] if contact and contact["screen_name"] else uid)
    self_info = db.get_self_info()
    html = _env.get_template("export.html").render(
        contact_name=name,
        uid=uid,
        days=days,
        total=len(rows),
        generated_at=datetime.now().strftime("%Y-%m-%d %H:%M"),
        ava_in=(
            f"../media/{contact['avatar_path']}"
            if contact and contact["avatar_path"] and contact["avatar_path"] != "failed"
            else (contact["avatar_url"] if contact else "") or ""
        ),
        ava_out=(
            f"../media/{self_info['avatar_local']}"
            if self_info.get("avatar_local")
            else self_info.get("avatar_url", "")
        ),
        name_in=name,
        name_out=self_info.get("screen_name", "我"),
    )
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = re.sub(r"[^\w一-鿿-]", "_", name)
    if from_date or to_date:
        span = f"{(from_date or '起始')}_{(to_date or '至今')}".replace("-", "")
        fname = f"weibo_dm_{safe_name}_{span}.html"
    else:
        fname = f"weibo_dm_{safe_name}_全部_{datetime.now():%Y%m%d_%H%M%S}.html"
    out = EXPORT_DIR / fname
    out.write_text(html, encoding="utf-8")
    return out
