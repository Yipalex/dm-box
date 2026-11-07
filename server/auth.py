"""Protect every route, including static media and exports.

Browsers use their native HTTP Basic login (dmbox / access token).
The extension uses Bearer authentication; credentials never go in URLs.
"""
import base64
import hmac
from urllib.parse import urlsplit

from starlette.responses import JSONResponse
from . import config


def authorized(header: str) -> bool:
    scheme, _, value = header.partition(" ")
    supplied = ""
    if scheme.lower() == "bearer":
        supplied = value
    elif scheme.lower() == "basic":
        try:
            username, _, password = base64.b64decode(value, validate=True).decode().partition(":")
            if username == "dmbox":
                supplied = password
        except (ValueError, UnicodeError):
            pass
    return hmac.compare_digest(supplied.encode(), config.API_TOKEN.encode())


async def access_guard(request, call_next):
    if config.API_TOKEN and not authorized(request.headers.get("authorization", "")):
        return JSONResponse({"detail": "请填写访问密钥；管理页面用户名为 dmbox"}, 401,
                            headers={"WWW-Authenticate": 'Basic realm="DMBox", charset="UTF-8"',
                                     "Cache-Control": "no-store"})
    # Reject cross-site browser writes, including when using browser-cached Basic credentials.
    origin = request.headers.get("origin")
    if request.method not in {"GET", "HEAD", "OPTIONS"} and origin:
        parsed = urlsplit(origin)
        extension = parsed.scheme == "chrome-extension"
        same_host = parsed.netloc == request.headers.get("host")
        if not extension and not same_host:
            return JSONResponse({"detail": "Cross-site request rejected"}, 403)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    return response
