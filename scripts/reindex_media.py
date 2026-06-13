"""按最新的媒体提取规则重建媒体索引（消息原始 JSON 不动，可随时重跑）。

- 重新判定每条消息的 type
- 删除不再匹配的媒体记录（如误存的头像）及其落盘文件
- 补登记新规则下新发现的附件

用法: ./.venv/bin/python scripts/reindex_media.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import db  # noqa: E402

MEDIA_DIR = db.DATA_DIR / "media"


def main():
    conn = db.get_conn()
    valid: dict[str, tuple[str, str]] = {}  # url -> (mid, type)
    type_fixed = 0

    for row in conn.execute("SELECT mid, type, raw_json FROM messages").fetchall():
        msg = json.loads(row["raw_json"])
        new_type = db.detect_type(msg)
        if new_type != row["type"]:
            conn.execute("UPDATE messages SET type=? WHERE mid=?", (new_type, row["mid"]))
            type_fixed += 1
        for url in db.extract_media_urls(msg):
            valid.setdefault(url, (row["mid"], new_type))

    removed = 0
    files_deleted = 0
    for m in conn.execute("SELECT id, orig_url, local_path FROM media").fetchall():
        if m["orig_url"] in valid:
            continue
        if m["local_path"]:
            shared = conn.execute(
                "SELECT COUNT(*) AS n FROM media WHERE local_path=? AND id!=?",
                (m["local_path"], m["id"]),
            ).fetchone()["n"]
            target = MEDIA_DIR / m["local_path"]
            if not shared and target.is_file():
                target.unlink()
                files_deleted += 1
        conn.execute("DELETE FROM media WHERE id=?", (m["id"],))
        removed += 1

    added = 0
    for url, (mid, mtype) in valid.items():
        cur = conn.execute(
            "INSERT OR IGNORE INTO media(mid, orig_url, type) VALUES(?,?,?)", (mid, url, mtype)
        )
        added += cur.rowcount

    conn.commit()
    print(f"消息类型修正: {type_fixed} 条")
    print(f"误存媒体清除: {removed} 条记录, {files_deleted} 个文件")
    print(f"新登记附件: {added} 条（将由后台队列慢速下载）")


if __name__ == "__main__":
    main()
