"""Storage and authentication settings shared by local and Docker deployments."""
import os
import tempfile
from pathlib import Path

_default_data = Path(__file__).resolve().parent.parent / "data"
DATA_DIR = Path(os.environ.get("DMBOX_DATA_DIR", str(_default_data))).expanduser().resolve()
API_TOKEN = os.environ.get("DMBOX_API_TOKEN", "")
REQUIRE_AUTH = os.environ.get("DMBOX_REQUIRE_AUTH", "false").lower() in {"1", "true", "yes"}


def validate():
    if REQUIRE_AUTH and not API_TOKEN:
        raise RuntimeError("DMBOX_API_TOKEN is required for remote deployment")
    if API_TOKEN and len(API_TOKEN) < 32:
        raise RuntimeError("DMBOX_API_TOKEN must contain at least 32 characters")
    # Explicit paths must already exist: do not silently create data on an absent mount.
    if "DMBOX_DATA_DIR" in os.environ:
        configured = os.environ["DMBOX_DATA_DIR"]
        if not configured or not Path(configured).expanduser().is_absolute() or not DATA_DIR.is_dir():
            raise RuntimeError("DMBOX_DATA_DIR must be an existing absolute mounted directory")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryFile(dir=DATA_DIR):
        pass
    for name in ("media", "exports"):
        (DATA_DIR / name).mkdir(exist_ok=True)
