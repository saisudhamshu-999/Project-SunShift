"""Operator alerts: tell a person when something goes wrong, without anyone watching logs.

Set ``ALERT_WEBHOOK_URL`` to any of
  - an ntfy topic, e.g. ``https://ntfy.sh/sunshift-<something-unguessable>``: free push
    notifications to the ntfy phone app, no account needed;
  - a Slack or Discord incoming-webhook URL;
  - any other URL, which receives JSON ``{"event", "title", "text", "details", "service"}``.

Alerts are sent from a background thread and never raise or slow a request down. Each
event (plus an optional key, such as the day) is sent at most once per
``ALERT_COOLDOWN_S``, so an outage produces one alert rather than one per request. Alert
text never contains phone numbers or message bodies: counts, farm codes and dates only.

A server that is down or asleep cannot alert anyone: the daily-dispatch GitHub workflow
fails in that case, and GitHub emails the repository owner.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any
from urllib.parse import urlparse

import httpx

log = logging.getLogger("sunshift.alerts")

_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="alerts")
_pending: list[Future] = []
_url: str | None = None
_cooldown_s = 1800.0
_last: dict[str, float] = {}
_transport: httpx.BaseTransport | None = None  # tests


def configure(url: str | None, cooldown_s: float = 1800.0, transport: httpx.BaseTransport | None = None) -> None:
    global _url, _cooldown_s, _transport
    with _lock:
        _url = (url or "").strip() or None
        _cooldown_s = cooldown_s
        _transport = transport
        _last.clear()


def enabled() -> bool:
    return _url is not None


def kind() -> str:
    """Where alerts go, for /api/health (never the URL itself: it is a secret)."""
    return _kind(_url)


def _kind(url: str | None) -> str:
    if url is None:
        return "off"
    host = urlparse(url).hostname or ""
    if host.endswith("slack.com"):
        return "slack"
    if "discord" in host:
        return "discord"
    if "ntfy" in host:
        return "ntfy"
    return "webhook"


def alert(event: str, title: str, text: str, *, key: str = "", details: dict[str, Any] | None = None,
          priority: str = "high") -> bool:
    """Queue an alert. Returns False when alerts are off or this event is cooling down."""
    with _lock:
        if _url is None:
            return False
        now = time.monotonic()
        k = f"{event}:{key}"
        if now - _last.get(k, -1e18) < _cooldown_s:
            return False
        _last[k] = now
        url, transport = _url, _transport
        log.warning("alert %s: %s. %s", event, title, text)
        _pending[:] = [f for f in _pending if not f.done()]
        _pending.append(_pool.submit(_send, url, transport, event, title, text, details or {}, priority))
    return True


def drain(timeout_s: float = 10.0) -> None:
    """Wait for queued alerts to be sent (tests, shutdown)."""
    with _lock:
        pending = list(_pending)
    for f in pending:
        try:
            f.result(timeout=timeout_s)
        except Exception:  # pragma: no cover - _send never raises
            pass


def _request(url: str, event: str, title: str, text: str, details: dict[str, Any], priority: str) -> dict[str, Any]:
    k = _kind(url)
    if k == "slack":
        return {"json": {"text": f"*{title}*\n{text}"}}
    if k == "discord":
        return {"json": {"content": f"**{title}**\n{text}"[:2000]}}
    if k == "ntfy":
        return {"content": text.encode("utf-8"),
                "headers": {"Title": title.encode("ascii", "ignore").decode(), "Priority": priority, "Tags": "warning"}}
    return {"json": {"service": "sunshift", "event": event, "title": title, "text": text, "details": details}}


def _send(url: str, transport: httpx.BaseTransport | None, event: str, title: str, text: str,
          details: dict[str, Any], priority: str) -> None:
    try:
        with httpx.Client(timeout=httpx.Timeout(8.0, connect=4.0), transport=transport) as client:
            r = client.post(url, **_request(url, event, title, text, details, priority))
            if r.status_code >= 400:
                log.warning("alert %s was not accepted: HTTP %s", event, r.status_code)
    except Exception as exc:
        log.warning("alert %s could not be sent: %s", event, type(exc).__name__)
