"""API-key protection for endpoints that change data (the farm registry).

Planning stays open (and rate limited) so the public site works without credentials.
Writes need ``X-API-Key`` to match ``SUNSHIFT_API_KEY``; with no key configured the
server refuses writes altogether, so a fresh deployment is read-only by default.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, Request


def require_api_key(request: Request, x_api_key: str | None = Header(default=None, alias="X-API-Key")) -> None:
    expected: str | None = request.app.state.settings.api_key
    if not expected:
        raise HTTPException(status_code=403, detail="Registry writes are disabled on this server: set SUNSHIFT_API_KEY to enable them")
    if not x_api_key or not hmac.compare_digest(x_api_key.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Missing or invalid API key", headers={"WWW-Authenticate": "ApiKey"})
