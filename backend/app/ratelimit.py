"""Per-client token-bucket rate limits for the API.

Plain ASGI middleware, so streamed responses (the season simulation) pass through
untouched. Limits are per process; behind several workers the effective limit is
proportionally higher, which is acceptable for abuse protection.
"""

from __future__ import annotations

import json
import math
import threading
import time
from dataclasses import dataclass

COMPUTE_PATHS = ("/api/jobs", "/api/plan", "/api/sensitivity", "/api/fairness", "/api/rain-event")
ADMIN_PREFIXES = ("/api/feeders", "/api/farms", "/api/dispatch", "/api/sms")
WRITE_METHODS = ("POST", "PUT", "PATCH", "DELETE")


@dataclass
class Rule:
    name: str
    per_minute: float
    burst: int


class _Bucket:
    __slots__ = ("tokens", "updated")

    def __init__(self, burst: int):
        self.tokens = float(burst)
        self.updated = time.monotonic()


class RateLimiter:
    def __init__(self, compute: tuple[float, int], season: tuple[float, int], admin: tuple[float, int], read: tuple[float, int]):
        self.rules = {
            "compute": Rule("compute", *compute),
            "season": Rule("season", *season),
            "admin": Rule("admin", *admin),
            "read": Rule("read", *read),
        }
        self._buckets: dict[tuple[str, str], _Bucket] = {}
        self._lock = threading.Lock()

    def classify(self, method: str, path: str) -> Rule | None:
        if not path.startswith("/api/"):
            return None  # the site itself is static
        if method == "POST" and path == "/api/season":
            return self.rules["season"]
        if method == "POST" and path in COMPUTE_PATHS:
            return self.rules["compute"]
        if method in WRITE_METHODS and path.startswith(ADMIN_PREFIXES):
            return self.rules["admin"]
        return self.rules["read"]

    def take(self, rule: Rule, client: str) -> float:
        """Spend one token. Returns 0 if allowed, else the seconds until the next token."""
        now = time.monotonic()
        rate = rule.per_minute / 60.0
        with self._lock:
            if len(self._buckets) > 20000:
                self._evict(now)
            bucket = self._buckets.get((rule.name, client))
            if bucket is None:
                bucket = self._buckets[(rule.name, client)] = _Bucket(rule.burst)
            bucket.tokens = min(rule.burst, bucket.tokens + (now - bucket.updated) * rate)
            bucket.updated = now
            if bucket.tokens >= 1:
                bucket.tokens -= 1
                return 0.0
            return (1 - bucket.tokens) / rate if rate > 0 else 60.0

    def _evict(self, now: float) -> None:
        # Buckets idle for 10 minutes are full again: forgetting them changes nothing.
        for key in [k for k, b in self._buckets.items() if now - b.updated > 600]:
            del self._buckets[key]


class RateLimitMiddleware:
    def __init__(self, app, limiter: RateLimiter, enabled: bool = True):
        self.app = app
        self.limiter = limiter
        self.enabled = enabled

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not self.enabled:
            return await self.app(scope, receive, send)
        rule = self.limiter.classify(scope["method"], scope["path"])
        if rule is not None:
            client = (scope.get("client") or ("unknown", 0))[0]
            wait = self.limiter.take(rule, client)
            if wait > 0:
                retry = max(1, math.ceil(wait))
                body = json.dumps({"detail": "Too many requests. Please slow down.", "retryAfterS": retry}).encode()
                await send({
                    "type": "http.response.start", "status": 429,
                    "headers": [(b"content-type", b"application/json"), (b"retry-after", str(retry).encode()),
                                (b"content-length", str(len(body)).encode())],
                })
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)
