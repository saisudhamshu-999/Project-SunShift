"""Farmer messaging: send each farmer their window by SMS, and act on their replies.

Gateways
  simulated  the default: messages are composed and recorded, nothing leaves the server
  twilio     real SMS via the Twilio REST API (SMS_PROVIDER=twilio and TWILIO_* settings);
             inbound replies arrive at POST /api/sms/inbound, signed by Twilio
For SMS to Indian numbers, operators require DLT registration of the sender ID and
of each message template (TRAI rules); that registration is outside this code.

Replies
  1 / OK          confirm the window
  2 / CHANGE      ask for a time; then e.g. "14:00" = start no earlier than 14:00 today
  0 / NO          no irrigation today
A change re-plans the rest of the day and sends updated windows to every farmer whose
time moved. The SMS wording mirrors frontend/src/components/farmer/messages.ts, and
the parity fixture checks the two stay identical.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import uuid
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Protocol

import httpx
from sqlalchemy import select

from . import db, registry

log = logging.getLogger("sunshift.sms")

CROP = {
    "en": {"cotton": "Cotton", "maize": "Maize", "groundnut": "Groundnut", "chilli": "Chilli"},
    "hi": {"cotton": "कपास", "maize": "मक्का", "groundnut": "मूंगफली", "chilli": "मिर्च"},
    "te": {"cotton": "పత్తి", "maize": "మొక్కజొన్న", "groundnut": "వేరుశనగ", "chilli": "మిరప"},
}
T: dict[str, dict[str, Any]] = {
    "en": {
        "brand": "SUNSHIFT", "farm": "Farm", "today": "Irrigate TODAY", "water": "m³ of water", "why": "Why",
        "drying": "soil is drying", "needs": "crop needs water", "sun": "strong sun", "noRain": "no rain expected",
        "fairness": "your turn after yesterday", "reply": "Reply", "ok": "OK", "change": "Change time",
        "deferred": "No irrigation today. Rain expected: {mm} mm. Save water and power.",
        "notNeeded": "No irrigation needed today. Your soil has enough water.",
        "confirmed": "Confirmed. Pump window {w}. We will call 10 minutes before.",
        "changeAsk": "Reply with a time that suits you, e.g. 14:00. SunShift will re-plan the feeder and confirm.",
        "replanning": "Noted. SunShift is re-planning the feeder; your new time follows shortly.",
        "updated": "Schedule updated: pump window {w}.",
        "updatedNone": "Schedule updated: no pumping for you today.",
        "skipped": "Noted: no irrigation for you today.",
        "windowPassed": "Today's pump time is over, so it can't be changed now. Tomorrow's schedule comes in the next message.",
        "help": "Reply 1 = OK, 2 = change time, 0 = not today.",
    },
    "hi": {
        "brand": "सनशिफ्ट", "farm": "खेत", "today": "आज सिंचाई करें", "water": "घन मीटर पानी", "why": "कारण",
        "drying": "मिट्टी सूख रही है", "needs": "फसल को पानी चाहिए", "sun": "तेज़ धूप", "noRain": "बारिश की संभावना नहीं",
        "fairness": "कल के बाद आपकी बारी", "reply": "जवाब दें", "ok": "ठीक है", "change": "समय बदलें",
        "deferred": "आज सिंचाई न करें। बारिश की संभावना: {mm} मिमी। पानी और बिजली बचाएं।",
        "notNeeded": "आज सिंचाई की ज़रूरत नहीं। मिट्टी में पर्याप्त नमी है।",
        "confirmed": "पुष्टि हो गई। पंप का समय {w}। हम 10 मिनट पहले कॉल करेंगे।",
        "changeAsk": "अपना सुविधाजनक समय भेजें, जैसे 14:00। सनशिफ्ट फीडर की योजना दोबारा बनाकर पुष्टि करेगा।",
        "replanning": "ठीक है। फीडर की योजना दोबारा बन रही है; नया समय जल्द भेजेंगे।",
        "updated": "समय बदला गया: पंप का समय {w}।",
        "updatedNone": "समय बदला गया: आज आपके लिए पंप नहीं चलेगा।",
        "skipped": "ठीक है, आज आपके खेत में सिंचाई नहीं होगी।",
        "windowPassed": "आज का पंप समय समाप्त हो चुका है, इसलिए अब बदला नहीं जा सकता। कल का समय अगले संदेश में आएगा।",
        "help": "जवाब दें: 1 = ठीक है, 2 = समय बदलें, 0 = आज नहीं।",
    },
    "te": {
        "brand": "సన్‌షిఫ్ట్", "farm": "పొలం", "today": "ఈ రోజు నీరు పెట్టండి", "water": "ఘన మీటర్ల నీరు", "why": "కారణం",
        "drying": "నేల ఎండిపోతోంది", "needs": "పంటకు నీరు కావాలి", "sun": "బలమైన ఎండ", "noRain": "వర్షం సూచన లేదు",
        "fairness": "నిన్నటి తర్వాత మీ వంతు", "reply": "జవాబు", "ok": "సరే", "change": "సమయం మార్చండి",
        "deferred": "ఈ రోజు నీరు పెట్టవద్దు. వర్షం సూచన: {mm} మి.మీ. నీరు, విద్యుత్ ఆదా చేయండి.",
        "notNeeded": "ఈ రోజు నీరు అవసరం లేదు. నేలలో తగినంత తేమ ఉంది.",
        "confirmed": "నిర్ధారించబడింది. పంపు సమయం {w}. 10 నిమిషాల ముందు కాల్ చేస్తాం.",
        "changeAsk": "మీకు అనుకూలమైన సమయం పంపండి, ఉదా: 14:00. సన్‌షిఫ్ట్ ఫీడర్ ప్రణాళికను మళ్లీ రూపొందించి నిర్ధారిస్తుంది.",
        "replanning": "సరే. ఫీడర్ ప్రణాళిక మళ్లీ రూపొందిస్తున్నాం; కొత్త సమయం త్వరలో పంపుతాం.",
        "updated": "సమయం మార్చబడింది: పంపు సమయం {w}.",
        "updatedNone": "సమయం మార్చబడింది: ఈ రోజు మీకు పంపు లేదు.",
        "skipped": "సరే, ఈ రోజు మీ పొలానికి నీరు పెట్టడం లేదు.",
        "windowPassed": "ఈ రోజు పంపు సమయం ముగిసింది, కాబట్టి ఇప్పుడు మార్చలేము. రేపటి సమయం తదుపరి సందేశంలో వస్తుంది.",
        "help": "జవాబు: 1 = సరే, 2 = సమయం మార్చండి, 0 = ఈ రోజు కాదు.",
    },
}
LANGS = tuple(T)


def fmt(n: float, digits: int = 0) -> str:
    """Indian digit grouping (12,34,567), half away from zero: matches Intl en-IN in the browser."""
    q = Decimal(str(n)).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    sign, (whole, _, frac) = ("-" if q < 0 else ""), f"{abs(q):f}".partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        head = ",".join([head[max(0, i - 2):i] for i in range(len(head), 0, -2)][::-1])
        whole = f"{head},{tail}"
    return f"{sign}{whole}{'.' + frac if frac else ''}"


# --------------------------------------------------------------- composing


def first_window(farm: dict[str, Any]) -> tuple[str, str] | None:
    w = farm["schedule"]["window"].split(",")[0].strip()
    if not w:
        return None
    a, b = w.split("–")
    return a, b


def reasons_for(farm: dict[str, Any], lang: str) -> list[str]:
    t = T[lang]
    level = {r["factor"]: r["level"] for r in farm.get("reasons", [])}
    out = [t["drying"] if level.get("Soil stress") in ("HIGH", "SEVERE") else t["needs"]]
    if level.get("Solar availability") == "HIGH":
        out.append(t["sun"])
    if level.get("Rain probability") == "LOW":
        out.append(t["noRain"])
    if farm.get("servedYesterday", 1.0) < 0.98:
        out.append(t["fairness"])
    return out


def sms_lines(farm: dict[str, Any], lang: str) -> list[str]:
    """The day's SMS for one farm of a plan, line by line."""
    t = T[lang]
    head = f"{t['brand']} · {t['farm']} {farm['code'][1:]}"
    if farm["deferred"]:
        return [head, t["deferred"].format(mm=fmt(farm["rainExpectedMm"]))]
    w = first_window(farm)
    if not w:
        return [head, t["notNeeded"]]
    return [
        head,
        f"{t['today']} {w[0]}–{w[1]}",
        f"{CROP[lang][farm['crop']]} · {fmt(farm['schedule']['scheduledM3'])} {t['water']}",
        f"{t['why']}: {', '.join(reasons_for(farm, lang))}",
        f"{t['reply']} 1 = {t['ok']}   2 = {t['change']}",
    ]


# ---------------------------------------------------------------- gateways


@dataclass
class SendResult:
    status: str  # simulated | sent | failed
    provider_id: str | None = None
    error: str | None = None


class Gateway(Protocol):
    name: str

    def send(self, to: str, body: str) -> SendResult: ...


class SimulatedGateway:
    """Composes and records messages; nothing is sent. The default, and labelled as such."""

    name = "simulated"

    def send(self, to: str, body: str) -> SendResult:
        return SendResult("simulated")


class TwilioGateway:
    name = "twilio"
    API = "https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"

    def __init__(self, sid: str, token: str, sender: str, transport: httpx.BaseTransport | None = None):
        self.sid, self.token, self.sender = sid, token, sender
        self._client = httpx.Client(timeout=15, transport=transport)

    def send(self, to: str, body: str) -> SendResult:
        try:
            r = self._client.post(self.API.format(sid=self.sid), auth=(self.sid, self.token),
                                  data={"To": to, "From": self.sender, "Body": body})
            if r.status_code >= 400:
                detail = (r.json() if "json" in r.headers.get("content-type", "") else {}).get("message", r.text[:120])
                return SendResult("failed", error=f"Twilio {r.status_code}: {detail}"[:300])
            return SendResult("sent", provider_id=r.json().get("sid"))
        except httpx.HTTPError as exc:
            return SendResult("failed", error=f"Twilio unreachable: {type(exc).__name__}")

    def valid_signature(self, url: str, params: dict[str, str], signature: str | None) -> bool:
        """Twilio's request signature: base64 HMAC-SHA1 of the URL plus the sorted POST parameters."""
        if not signature:
            return False
        payload = url + "".join(k + params[k] for k in sorted(params))
        digest = hmac.new(self.token.encode(), payload.encode(), hashlib.sha1).digest()
        return hmac.compare_digest(base64.b64encode(digest).decode(), signature)


def gateway_for(settings) -> Gateway:
    if settings.sms_provider == "twilio":
        if not (settings.twilio_sid and settings.twilio_token and settings.twilio_from):
            raise RuntimeError("SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM")
        return TwilioGateway(settings.twilio_sid, settings.twilio_token, settings.twilio_from)
    return SimulatedGateway()


# ------------------------------------------------------------------ storage


def dedupe_key(farm_id: int, day: str, slots: list[int], deferred: bool) -> str:
    """What makes two schedule messages the same: farm, day and the exact pump slots."""
    return hashlib.sha256(f"{farm_id}|{day}|{','.join(map(str, sorted(slots)))}|{int(deferred)}".encode()).hexdigest()


def _already_sent(key: str) -> bool:
    with db.session() as s:
        if s is None:
            return False
        return s.scalars(
            select(db.Message.id).where(db.Message.dedupe_key == key, db.Message.status.in_(("sent", "simulated"))).limit(1)
        ).first() is not None


def _record(*, direction: str, farm_id: int | None, phone: str, language: str, body: str, result: SendResult | None,
            provider: str, dispatch_id: str | None = None, plan_date: str | None = None,
            key: str | None = None) -> dict[str, Any]:
    row = {
        "id": uuid.uuid4().hex[:16], "dispatch_id": dispatch_id, "farm_id": farm_id, "direction": direction,
        "phone_masked": registry.mask_phone(phone) or "", "language": language, "body": body[:1000],
        "status": "received" if result is None else result.status, "provider": provider,
        "provider_id": None if result is None else result.provider_id, "error": None if result is None else result.error,
        "created_at": db.utcnow(), "plan_date": plan_date, "dedupe_key": key,
    }
    with db.session() as s:
        if s is not None:
            s.add(db.Message(**row))
    return row


def recent_messages(limit: int = 30) -> list[dict[str, Any]]:
    """Recent messages without phone numbers: farm, direction, status and text only."""
    with db.session() as s:
        if s is None:
            return []
        rows = s.scalars(select(db.Message).order_by(db.Message.created_at.desc()).limit(limit)).all()
        return [{
            "id": m.id, "farmId": m.farm_id, "code": f"F{m.farm_id:02d}" if m.farm_id else None, "direction": m.direction,
            "language": m.language, "body": m.body, "status": m.status, "provider": m.provider, "error": m.error,
            "createdAt": db.aware(m.created_at).isoformat(),
        } for m in rows]


def _save_dispatch(feeder_id: str, day: str, plan: dict[str, Any], reason: str) -> str:
    dispatch_id = uuid.uuid4().hex[:16]
    schedule = {str(f["id"]): f["schedule"]["slots"] for f in plan["farms"]}
    with db.session() as s:
        if s is not None:
            s.add(db.Dispatch(id=dispatch_id, feeder_id=feeder_id, plan_date=day, created_at=db.utcnow(),
                              schedule=schedule, reason=reason[:40]))
    return dispatch_id


def latest_dispatch(day: str) -> db.Dispatch | None:
    with db.session() as s:
        if s is None:
            return None
        return s.scalars(select(db.Dispatch).where(db.Dispatch.plan_date == day).order_by(db.Dispatch.created_at.desc())).first()


# ------------------------------------------------------------------- sending


def _recipients(feeder_id: str) -> dict[int, db.FarmRow]:
    with db.session() as s:
        if s is None:
            return {}
        rows = s.scalars(select(db.FarmRow).where(db.FarmRow.feeder_id == feeder_id, db.FarmRow.active.is_(True))).all()
        return {r.id: r for r in rows}


def send_plan(plan: dict[str, Any], gateway: Gateway, *, reason: str = "morning", only: set[int] | None = None,
              dry_run: bool = False, updates_from: dict[str, list[int]] | None = None) -> dict[str, Any]:
    """Send each opted-in farmer their part of ``plan``.

    ``updates_from``: the previously sent schedule; only farms whose slots changed get an
    "updated" message instead of the full morning SMS.

    Idempotent: a farmer who already received this exact schedule for this day is not
    messaged again, however often the dispatch or the re-plan runs. Callers serialise
    concurrent sends for a feeder and day with ``jobs.distributed_job_lock``.
    """
    feeder_id, day = plan["feeder"]["id"], plan["meta"]["date"]
    farms = _recipients(feeder_id)
    dispatch_id = None if dry_run else _save_dispatch(feeder_id, day, plan, reason)
    out: dict[str, Any] = {"dispatchId": dispatch_id, "date": day, "provider": gateway.name, "dryRun": dry_run, "messages": [],
                           "counts": {"sent": 0, "simulated": 0, "failed": 0, "noPhone": 0, "optedOut": 0, "unchanged": 0,
                                      "duplicate": 0}}
    for f in plan["farms"]:
        if only is not None and f["id"] not in only:
            continue
        row = farms.get(f["id"])
        if updates_from is not None and updates_from.get(str(f["id"]), []) == f["schedule"]["slots"]:
            out["counts"]["unchanged"] += 1
            continue
        if row is None or not row.phone:
            out["counts"]["noPhone"] += 1
            continue
        if not row.sms_opt_in:
            out["counts"]["optedOut"] += 1
            continue
        lang = row.language if row.language in LANGS else "te"
        key = dedupe_key(f["id"], day, f["schedule"]["slots"], f["deferred"])
        if not dry_run and _already_sent(key):
            out["counts"]["duplicate"] += 1
            out["messages"].append({"farmId": f["id"], "code": f["code"], "language": lang, "status": "duplicate",
                                    "error": None, "body": None})
            continue
        if updates_from is None:
            body = "\n".join(sms_lines(f, lang))
        else:
            w = f["schedule"]["window"]
            body = T[lang]["updated"].format(w=w) if w else T[lang]["updatedNone"]
        result = SendResult("simulated") if dry_run else gateway.send(row.phone, body)
        if not dry_run:
            _record(direction="out", farm_id=f["id"], phone=row.phone, language=lang, body=body, result=result,
                    provider=gateway.name, dispatch_id=dispatch_id, plan_date=day, key=key)
        out["counts"][result.status] = out["counts"].get(result.status, 0) + 1
        out["messages"].append({"farmId": f["id"], "code": f["code"], "language": lang, "status": result.status,
                                "error": result.error, "body": body})
    return out


# ------------------------------------------------------------------ replies

TIME = re.compile(r"^\s*([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\s*$")
CONFIRM = {"1", "ok", "yes", "y", "haan", "ha", "సరే", "ठीक", "हाँ", "हां"}
CHANGE = {"2", "change", "badlo", "మార్చండి", "बदलें"}
SKIP = {"0", "no", "skip", "nahi", "కాదు", "नहीं"}


@dataclass
class Reply:
    kind: str  # confirm | change | time | skip | unknown
    hour: float | None = None


def parse_reply(text: str) -> Reply:
    t = text.strip().lower()
    if t in CONFIRM:
        return Reply("confirm")
    if t in CHANGE:
        return Reply("change")
    if t in SKIP:
        return Reply("skip")
    m = TIME.match(t)
    if m:
        hour = int(m.group(1)) + (int(m.group(2) or 0) / 60)
        if 6 <= hour <= 17.75:
            return Reply("time", hour)
    return Reply("unknown")
