"""Technician schedule: free arrival windows, service area and travel distances.

All of this is plain code, not the model, so the agent can only offer windows
that really exist on the schedule.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta

from . import db
from .config import business, technicians

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
SLOT_ORDER = {"AM": 0, "MID": 1, "PM": 2}


def town_lookup(name: str | None) -> dict | None:
    if not name:
        return None
    key = name.strip().lower().replace("city of ", "")
    for t in business()["service_towns"]:
        if t["name"].lower() == key or key.startswith(t["name"].lower()):
            return t
    return None


def miles(a: str | None, b: str | None) -> float | None:
    ta, tb = town_lookup(a), town_lookup(b)
    if not ta or not tb:
        return None
    r = 3958.8
    p1, p2 = math.radians(ta["lat"]), math.radians(tb["lat"])
    dp, dl = p2 - p1, math.radians(tb["lon"] - ta["lon"])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(2 * r * math.asin(math.sqrt(h)) * 1.25, 1)  # x1.25: road vs straight line


def slot_label(slot_id: str) -> str:
    for s in business()["slots"]:
        if s["id"] == slot_id:
            return s["label"]
    return slot_id


def day_label(d: date, ref: date | None = None) -> str:
    ref = ref or date.today()
    base = d.strftime("%A, %b ") + str(d.day)
    if d == ref + timedelta(days=1):
        return "tomorrow, " + base
    if d == ref:
        return "today, " + base
    return base


def window_label(d: date, slot_id: str, ref: date | None = None) -> str:
    return f"{day_label(d, ref)}, {slot_label(slot_id)}"


def free_slots(trade: str, start: date, days: int, exclude_call_id: int | None = None) -> list[dict]:
    """Every (tech, date, slot) that is free for a tech with this trade."""
    techs = [t for t in technicians() if trade in t["trades"]]
    end = start + timedelta(days=days - 1)
    booked = {}
    for j in db.jobs_between(start, end):
        if exclude_call_id is not None and j.get("call_id") == exclude_call_id:
            continue
        booked[(j["tech_id"], j["date"], j["slot"])] = j
    out = []
    for i in range(days):
        d = start + timedelta(days=i)
        dn = DAY_NAMES[d.weekday()]
        for t in techs:
            if dn not in t["work_days"]:
                continue
            for s in business()["slots"]:
                if (t["id"], d.isoformat(), s["id"]) in booked:
                    continue
                # the job before this one that day (for travel distance)
                prev = None
                for other in ("PM", "MID", "AM"):
                    if SLOT_ORDER[other] < SLOT_ORDER[s["id"]] and (t["id"], d.isoformat(), other) in booked:
                        prev = booked[(t["id"], d.isoformat(), other)]
                        break
                out.append({"tech_id": t["id"], "tech_name": t["name"], "level": t["level"], "date": d.isoformat(),
                            "weekday": dn, "slot": s["id"], "home_town": t["home_town"],
                            "prev_job_town": prev["town"] if prev else None})
    return out


def _matches(day: date, slot: str, prefs: dict) -> bool:
    days = [x.lower()[:3] for x in prefs.get("preferred_days") or []]
    slots = [x.upper() for x in prefs.get("preferred_slots") or []]
    if days and "any" not in days:
        wanted = set()
        for x in days:
            if x == "tom":
                wanted.add(DAY_NAMES[(date.today() + timedelta(days=1)).weekday()].lower())
            else:
                wanted.add(x)
        if DAY_NAMES[day.weekday()].lower() not in wanted:
            return False
    if slots and "ANY" not in slots and slot not in slots:
        return False
    return True


def check_availability(trade: str, town: str | None, urgency: str, preferred_days: list[str] | None,
                       preferred_slots: list[str] | None, call_id: int | None = None) -> dict:
    """Tool for the call agent. Returns rough arrival windows, never tech names or other customers."""
    trade = (trade or "").lower()
    if trade not in business()["trades"]:
        return {"ok": False, "error": f"trade must be one of {business()['trades']}"}
    if town and not town_lookup(town):
        return {"ok": True, "in_service_area": False, "town": town,
                "service_towns": [t["name"] for t in business()["service_towns"]], "windows": []}
    start = date.today() + timedelta(days=1)
    slots = free_slots(trade, start, days=5, exclude_call_id=call_id)
    prefs = {"preferred_days": preferred_days, "preferred_slots": preferred_slots}
    by_window: dict[tuple, list[dict]] = {}
    for s in slots:
        by_window.setdefault((s["date"], s["slot"]), []).append(s)
    keys = sorted(by_window, key=lambda k: (k[0], SLOT_ORDER[k[1]]))
    matching = [k for k in keys if _matches(date.fromisoformat(k[0]), k[1], prefs)]
    chosen = (matching or keys)[: 2 if urgency == "urgent" else 3]
    windows = [{"window_id": f"{d}_{s}", "date": d, "slot": s, "label": window_label(date.fromisoformat(d), s),
                "techs_free": len(by_window[(d, s)])} for d, s in chosen]
    return {
        "ok": True,
        "in_service_area": True if town else None,
        "matched_preferences": bool(matching),
        "windows": windows,
        "note": "Rough arrival windows only. Offer at most two. A technician calls to confirm before dispatch.",
    }


def best_tech_for(trade: str, day: str, slot: str, town: str | None, exclude_call_id: int | None = None) -> dict | None:
    """Pick the closest free tech for a held window (the manager can change it in the morning)."""
    d = date.fromisoformat(day)
    cands = [s for s in free_slots(trade, d, 1, exclude_call_id) if s["slot"] == slot]
    if not cands:
        return None

    def dist(c):
        m = miles(c["prev_job_town"] or c["home_town"], town)
        return m if m is not None else 99

    return sorted(cands, key=dist)[0]


def schedule_grid(days: int = 4, start: date | None = None) -> dict:
    start = start or date.today()
    end = start + timedelta(days=days - 1)
    jobs = db.jobs_between(start, end)
    return {
        "dates": [(start + timedelta(days=i)).isoformat() for i in range(days)],
        "slots": business()["slots"],
        "technicians": technicians(),
        "jobs": jobs,
    }


def parse_sim_time(s: str | None) -> datetime:
    if not s:
        return datetime.now()
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return datetime.now()
