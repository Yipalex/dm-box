"""把已下载的 AMR 语音批量转码为 M4A（AMR 原件保留），并更新数据库路径。

用法: ./.venv/bin/python scripts/convert_voice.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import db  # noqa: E402
from server.media_worker import MEDIA_DIR, amr_to_m4a  # noqa: E402


def main():
    conn = db.get_conn()
    rows = conn.execute(
        "SELECT id, local_path FROM media WHERE status='done' AND local_path IS NOT NULL"
    ).fetchall()
    converted = skipped = failed = 0
    for r in rows:
        path = MEDIA_DIR / r["local_path"]
        if path.suffix in (".m4a", ".jpg", ".png", ".gif", ".webp", ".mp4"):
            continue
        if not path.is_file():
            continue
        with open(path, "rb") as f:
            if f.read(5) != b"#!AMR":
                skipped += 1
                continue
        amr = path if path.suffix == ".amr" else path.rename(path.with_suffix(".amr"))
        m4a = amr.with_suffix(".m4a")
        if m4a.is_file() or amr_to_m4a(amr, m4a):
            rel = str(m4a.relative_to(MEDIA_DIR))
            conn.execute("UPDATE media SET local_path=? WHERE id=?", (rel, r["id"]))
            converted += 1
        else:
            # 转码失败：至少把数据库路径改成 .amr 原件
            conn.execute(
                "UPDATE media SET local_path=? WHERE id=?",
                (str(amr.relative_to(MEDIA_DIR)), r["id"]),
            )
            failed += 1
    conn.commit()
    print(f"转码成功: {converted}，非语音跳过: {skipped}，转码失败: {failed}")


if __name__ == "__main__":
    main()
