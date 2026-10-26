"""Numbers for the manager's overview and the call analysis page (plain SQL, no model)."""

from __future__ import annotations

from collections import Counter
from datetime import date, datetime, timedelta

from . import db, schedule
from .config import settings, technicians


def shift_start(now: datetime | None = None) -> datetime:
    """Start of 'last night': the most recent business close (e.g. 5 PM)."""
    now = now or datetime.now()
    h, m = map(int, settings()["business_hours"]["end"].split(":"))
    close_today = now.replace(hour=h, minute=m, second=0, microsecond=0)
    return close_today if now >= close_today else close_today - timedelta(days=1)


def _dur(c: dict) -> float | None:
    if c.get("started_at") and c.get("ended_at"):
        return (datetime.fromisoformat(c["ended_at"]) - datetime.fromisoformat(c["started_at"])).total_seconds()
    return None


def _usage(call_ids: list[int]) -> dict:
    if not call_ids:
        return {"requests": 0, "input_tokens": 0, "cached_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "latency_ms": 0}
    ids = ",".join(str(i) for i in call_ids)
    return db.query(
        f"SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(cached_tokens),0) AS cached_tokens, "
        f"COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(latency_ms),0) AS latency_ms "
        f"FROM usage WHERE simulated=0 AND call_id IN ({ids})")[0]


def _calls_between(start: datetime, end: datetime | None = None) -> list[dict]:
    end = end or datetime.now() + timedelta(days=1)
    return db.query("SELECT * FROM calls WHERE started_at>=? AND started_at<? ORDER BY id",
                    (start.isoformat(timespec="seconds"), end.isoformat(timespec="seconds")))


def summarize(calls: list[dict]) -> dict:
    done = [c for c in calls if c["status"] == "completed"]
    service = [c for c in done if c.get("category") == "service_request"]
    held = [c for c in done if (c.get("notes") or {}).get("held_window")]
    ai = [c for c in done if c.get("mode") != "forwarded"]
    attention = [c for c in done if (c.get("review") or {}).get("missing_info")
                 or (c.get("category") == "service_request" and not (c.get("notes") or {}).get("held_window"))]
    durs = [d for d in (_dur(c) for c in ai) if d is not None]
    u = _usage([c["id"] for c in ai])
    rec = db.query(
        f"SELECT COALESCE(SUM(latency_ms),0) AS ms FROM usage WHERE agent='receptionist' AND simulated=0 AND call_id IN ({','.join(str(c['id']) for c in ai) or 'NULL'})")[0]["ms"]
    turns = sum(c["turns"] or 0 for c in ai)
    ids = ",".join(str(c["id"]) for c in calls) or "NULL"
    safety = Counter(r["kind"] for r in db.query(f"SELECT kind FROM safety_events WHERE call_id IN ({ids})"))
    alerts = db.query(f"SELECT COUNT(*) AS n FROM messages WHERE call_id IN ({ids})")[0]["n"]
    return {
        "calls": len(calls), "in_progress": len(calls) - len(done), "answered_by_ai": len(ai),
        "forwarded": sum(1 for c in done if c.get("mode") == "forwarded"),
        "emergencies": sum(1 for c in done if c.get("priority") == "emergency"),
        "transferred": sum(1 for c in done if c.get("transferred_to")),
        "service_requests": len(service), "windows_held": len(held),
        "booking_rate": round(len(held) / len(service), 3) if service else None,
        "messages": sum(1 for c in done if c.get("category") == "message"),
        "out_of_area": sum(1 for c in done if c.get("category") == "out_of_area"),
        "spam": sum(1 for c in done if c.get("category") == "spam"),
        "needs_attention": len(attention),
        "attacks_blocked": safety.get("prompt_injection", 0) + safety.get("provider_filter", 0) + safety.get("output_redacted", 0),
        "emergency_overrides": safety.get("emergency_override", 0),
        "alerts_sent": alerts,
        "avg_call_s": round(sum(durs) / len(durs)) if durs else None,
        "avg_reply_s": round(rec / 1000 / turns, 2) if turns else None,
        "cost_usd": u["cost_usd"], "tokens": {k: u[k] for k in ("input_tokens", "cached_tokens", "output_tokens")},
        "cost_per_call": u["cost_usd"] / len(ai) if ai else 0,
    }


def call_row(c: dict) -> dict:
    n = c.get("notes") or {}
    return {"id": c["id"], "started_at": c["started_at"], "status": c["status"], "caller_name": n.get("caller_name"),
            "caller_id": c.get("caller_id"), "town": n.get("town"), "trade": n.get("trade"), "category": c.get("category"),
            "priority": c.get("priority"), "one_line": c.get("one_line"), "held_window": n.get("held_window"),
            "transferred_to": c.get("transferred_to"), "mode": c.get("mode"), "duration_s": _dur(c),
            "suggested_tech": (c.get("dispatch") or {}).get("tech_name"),
            "missing": (c.get("review") or {}).get("missing_info") or []}


def windows(now: datetime | None = None) -> dict:
    """Last night = the most recent completed night shift (close -> open).
    Current = from the end of that shift until now, at any time of day."""
    from .dispatch import last_completed_night, night_window
    now = now or datetime.now()
    last = night_window(last_completed_night())
    return {"current": (last[1], now + timedelta(minutes=1)), "last_night": last,
            "7d": (now - timedelta(days=7), now + timedelta(minutes=1))}


def overview(window: str | None = None) -> dict:
    s = settings()
    wins = windows()
    if window not in wins or wins.get(window) is None:
        window = "current" if _calls_between(*wins["current"]) else "last_night"
    start, end = wins[window]
    calls = _calls_between(start, end)
    hours = Counter()
    for c in calls:
        hours[datetime.fromisoformat(c["started_at"]).strftime("%Y-%m-%d %H")] += 1
    span = []
    if window == "7d":
        for i in range(7, -1, -1):
            d = (datetime.now() - timedelta(days=i)).date()
            n = sum(1 for c in calls if c["started_at"][:10] == d.isoformat())
            span.append({"hour": d.isoformat(), "label": d.strftime("%a"), "calls": n})
    else:  # one bar per hour: close -> open for last night; shift end -> now for current
        h = start.replace(minute=0)
        stop = start + timedelta(hours=15) if window == "last_night" else max(datetime.now(), start + timedelta(hours=6))
        if (stop - h) > timedelta(hours=24):
            h = stop - timedelta(hours=23)
        while h <= stop:
            span.append({"hour": h.strftime("%H"), "label": h.strftime("%I %p").lstrip("0").lower(),
                         "calls": hours.get(h.strftime("%Y-%m-%d %H"), 0)})
            h += timedelta(hours=1)
    techs = {t["id"]: t for t in technicians()}
    holds = db.query("SELECT j.*, c.notes AS cnotes, c.priority FROM jobs j LEFT JOIN calls c ON c.id=j.call_id "
                     "WHERE j.source='hold' AND j.date>=? ORDER BY j.date, j.slot", (date.today().isoformat(),))
    upcoming = [{"call_id": j["call_id"], "date": j["date"], "slot": j["slot"],
                 "window": schedule.window_label(date.fromisoformat(j["date"]), j["slot"]),
                 "tech_name": techs.get(j["tech_id"], {}).get("name"), "customer": j["customer"], "town": j["town"],
                 "title": j["title"], "priority": j.get("priority")} for j in holds]
    from . import actions
    actions.sync(calls)
    latest = db.query("SELECT ts FROM reports WHERE cost_usd>0 ORDER BY id DESC LIMIT 1")
    return {
        "agent": {"enabled": s.get("agent_enabled", True), "answering_mode": s["answering_mode"], "name": s["agent_name"],
                  "business_hours": s["business_hours"], "forward_number": s["forward_number"]},
        "window": window, "available": {k: v is not None for k, v in wins.items()},
        "since": start.isoformat(timespec="minutes"), "until": min(end, datetime.now()).isoformat(timespec="minutes"),
        "metrics": summarize(calls),
        "by_hour": span,
        "recent": [call_row(c) for c in reversed(calls)][:8],
        "attention": [call_row(c) for c in calls if c["status"] == "completed" and (
            (c.get("review") or {}).get("missing_info") or c.get("priority") == "emergency"
            or (c.get("category") == "service_request" and not (c.get("notes") or {}).get("held_window")))][:6],
        "upcoming": upcoming[:8],
        "last_report_at": latest[0]["ts"] if latest else None,
        "spend_today": db.spend_today(),
        "actions": actions.counts([c["id"] for c in calls]), "call_ids": [c["id"] for c in calls],
    }


def analysis(days: int = 7) -> dict:
    start = datetime.now() - timedelta(days=days)
    calls = [c for c in _calls_between(start) if c["status"] == "completed"]
    by = lambda f: dict(Counter(f(c) or "unknown" for c in calls).most_common())  # noqa: E731
    by_day = Counter(datetime.fromisoformat(c["started_at"]).strftime("%a %b %d") for c in calls)
    by_hour = Counter(int(datetime.fromisoformat(c["started_at"]).strftime("%H")) for c in calls)
    per_agent = db.query(
        "SELECT agent, COUNT(*) AS requests, SUM(input_tokens) AS input_tokens, SUM(cached_tokens) AS cached_tokens, "
        "SUM(output_tokens) AS output_tokens, SUM(reasoning_tokens) AS reasoning_tokens, SUM(cost_usd) AS cost_usd, "
        "AVG(latency_ms) AS avg_latency_ms FROM usage WHERE simulated=0 AND ts>=? GROUP BY agent ORDER BY cost_usd DESC",
        (start.isoformat(timespec="seconds"),))
    reports = db.query("SELECT COUNT(*) AS n, COALESCE(AVG(cost_usd),0) AS avg_cost FROM reports WHERE cost_usd>0")[0]
    safety = db.query("SELECT s.ts, s.call_id, s.kind, s.detail FROM safety_events s WHERE s.ts>=? ORDER BY s.id DESC LIMIT 30",
                      (start.isoformat(timespec="seconds"),))
    m = summarize(calls)
    return {
        "days": days, "metrics": m,
        "by_category": by(lambda c: c.get("category")),
        "by_trade": by(lambda c: (c.get("notes") or {}).get("trade")),
        "by_town": by(lambda c: (c.get("notes") or {}).get("town")),
        "by_priority": by(lambda c: c.get("priority")),
        "by_day": [{"day": k, "calls": v} for k, v in sorted(by_day.items(), key=lambda kv: datetime.strptime(kv[0] + f" {date.today().year}", "%a %b %d %Y"))],
        "by_hour": [{"hour": h, "calls": by_hour.get(h, 0)} for h in range(24)],
        "funnel": [{"stage": "Calls answered by AI", "n": m["answered_by_ai"]},
                   {"stage": "Service requests", "n": m["service_requests"]},
                   {"stage": "Window held on the call", "n": m["windows_held"]}],
        "per_agent": per_agent, "reports": reports, "safety_events": safety,
        "avg_per_call": {k: (v / m["answered_by_ai"] if m["answered_by_ai"] else 0) for k, v in m["tokens"].items()},
    }
