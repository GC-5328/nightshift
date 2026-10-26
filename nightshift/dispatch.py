"""Agent 2 - the Dispatcher. Two jobs:

1. After every logged call (hand-off from the Receptionist): suggest a technician
   and text the manager. This part is rules only - zero tokens, instant.
2. Each morning: read last night's calls and suggest a technician plan (one model
   call). Code finds every legal (tech, day, slot) option and the travel distance;
   the model picks and explains; code re-checks every pick before showing it.
   Suggestions only - nothing is ever booked.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta

from . import db, schedule
from .config import business, settings, technicians
from .llm import respond

PLAN_DAYS = 3
MAX_CANDIDATES = 10

INSTRUCTIONS = """You are the dispatch planner for a home services company. Each morning you suggest which technician should take each job that came in overnight.
Hard rules (a checker rejects violations):
- Only use a (tech_id, date, slot) option listed for that call. Never invent one.
- Never give two jobs the same tech, date and slot.
- At most one assignment per call.
Priorities, in order:
1. Emergencies and high priority first, in the earliest slot.
2. Honor the customer's held window if that option exists; otherwise match their stated availability.
3. Match skill: senior techs for complex or older equipment and panels; apprentices only for simple jobs.
4. Short travel (miles), and balance the load across technicians.
If no option fits, put the call in needs_attention with the reason. Reasons are one short sentence a manager can scan."""

PLAN_FORMAT = {
    "type": "json_schema", "name": "dispatch_plan", "strict": True,
    "schema": {
        "type": "object", "additionalProperties": False,
        "required": ["overview", "assignments", "needs_attention", "manager_tips"],
        "properties": {
            "overview": {"type": "string", "description": "3-4 sentences on last night and the plan."},
            "assignments": {"type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": ["call_id", "tech_id", "date", "slot", "reason"],
                "properties": {"call_id": {"type": "integer"}, "tech_id": {"type": "string"}, "date": {"type": "string"},
                               "slot": {"type": "string", "enum": ["AM", "MID", "PM"]}, "reason": {"type": "string"}}}},
            "needs_attention": {"type": "array", "items": {
                "type": "object", "additionalProperties": False, "required": ["call_id", "issue"],
                "properties": {"call_id": {"type": "integer"}, "issue": {"type": "string"}}}},
            "manager_tips": {"type": "array", "items": {"type": "string"}},
        },
    },
}


def plan_start() -> date:
    now = datetime.now()
    return now.date() if now.hour < 9 else now.date() + timedelta(days=1)


def _candidates(call: dict, start: date, batch_ids: set[int]) -> list[dict]:
    n = call["notes"] or {}
    trade = (n.get("trade") or "").lower()
    if trade not in ("hvac", "electrical", "solar"):
        return []
    # Tentative holds from tonight's calls are up for re-planning, so they do not block.
    free = []
    for s in schedule.free_slots(trade, start, PLAN_DAYS):
        free.append(s)
    holds = {(j["tech_id"], j["date"], j["slot"]) for j in db.jobs_between(start, start + timedelta(days=PLAN_DAYS))
             if j["source"] == "hold" and j["call_id"] in batch_ids}
    for tech_id, d, slot in holds:
        t = next((t for t in technicians() if t["id"] == tech_id), None)
        if t and trade in t["trades"]:
            free.append({"tech_id": tech_id, "tech_name": t["name"], "level": t["level"], "date": d, "slot": slot,
                         "weekday": schedule.DAY_NAMES[date.fromisoformat(d).weekday()], "home_town": t["home_town"], "prev_job_town": None})
    held = _held(call)
    out = []
    for s in free:
        m = schedule.miles(s["prev_job_town"] or s["home_town"], n.get("town"))
        out.append({"tech_id": s["tech_id"], "tech": s["tech_name"], "level": s["level"], "date": s["date"],
                    "weekday": s["weekday"], "slot": s["slot"], "miles": m,
                    "from": s["prev_job_town"] or f"{s['home_town']} (home)",
                    "is_held_window": bool(held and held == (s["date"], s["slot"]))})
    out.sort(key=lambda c: (not c["is_held_window"], c["date"], schedule.SLOT_ORDER[c["slot"]], c["miles"] if c["miles"] is not None else 99))
    return out


def _held(call: dict):
    if not call.get("hold_job_id"):
        return None
    rows = db.query("SELECT date, slot FROM jobs WHERE job_id=?", (call["hold_job_id"],))
    return (rows[0]["date"], rows[0]["slot"]) if rows else None


def validate_plan(plan: dict, legal: dict[int, set], trade_of: dict[int, str]) -> tuple[list, list]:
    techs = {t["id"]: t for t in technicians()}
    good, errors, used, assigned = [], [], set(), set()
    for a in plan.get("assignments", []):
        key = (a["tech_id"], a["date"], a["slot"])
        cid = a["call_id"]
        if cid not in legal:
            errors.append(f"call {cid} is not in tonight's dispatch list")
        elif cid in assigned:
            errors.append(f"call {cid} assigned twice")
        elif a["tech_id"] not in techs:
            errors.append(f"call {cid}: unknown tech {a['tech_id']}")
        elif trade_of[cid] not in techs[a["tech_id"]]["trades"]:
            errors.append(f"call {cid}: {techs[a['tech_id']]['name']} does not do {trade_of[cid]}")
        elif key not in legal[cid]:
            errors.append(f"call {cid}: {a['tech_id']} {a['date']} {a['slot']} is not a free option")
        elif key in used:
            errors.append(f"call {cid}: {a['tech_id']} {a['date']} {a['slot']} is double-booked")
        else:
            used.add(key)
            assigned.add(cid)
            good.append(a)
    return good, errors


def night_window(night: date) -> tuple[datetime, datetime]:
    """The night shift that ends on the morning of `night`: previous day's close -> that day's open."""
    bh = settings()["business_hours"]
    ch, cm = map(int, bh["end"].split(":"))
    oh, om = map(int, bh["start"].split(":"))
    end = datetime.combine(night, datetime.min.time()).replace(hour=oh, minute=om)
    start = datetime.combine(night - timedelta(days=1), datetime.min.time()).replace(hour=ch, minute=cm)
    return start, end


def last_completed_night() -> date:
    """Morning date of the most recent night shift that has fully ended."""
    now = datetime.now()
    _, end = night_window(now.date())
    return now.date() if now >= end else now.date() - timedelta(days=1)


def current_window() -> tuple[datetime, datetime]:
    """'Current' = from the end of the last completed night shift until now (any time of day)."""
    return night_window(last_completed_night())[1], datetime.now()


def _count(start: datetime, end: datetime) -> dict:
    r = db.query("SELECT COUNT(*) AS k, SUM(priority='emergency') AS e FROM calls WHERE started_at>=? AND started_at<? AND status='completed'",
                 (start.isoformat(timespec="seconds"), end.isoformat(timespec="seconds")))[0]
    return {"calls": r["k"] or 0, "emergencies": r["e"] or 0}


def current_entry() -> dict:
    start, end = current_window()
    rep = db.query("SELECT ts FROM reports WHERE night='current' AND cost_usd IS NOT NULL ORDER BY id DESC LIMIT 1")
    return {"night": "current", "start": start.isoformat(timespec="minutes"), "end": end.isoformat(timespec="minutes"),
            **_count(start, end + timedelta(minutes=1)), "report_at": rep[0]["ts"] if rep else None}


def build_current_report() -> dict:
    """Report on demand, outside the night-shift schedule; labelled with when it was built."""
    start, end = current_window()
    return build_report(start, end + timedelta(minutes=1), night="current")


def nights(days: int = 14) -> list[dict]:
    """One row per completed night shift, newest first, with how many calls came in and whether a report exists."""
    cur = last_completed_night()
    out = []
    for i in range(days):
        n = cur - timedelta(days=i)
        start, end = night_window(n)
        calls = db.query("SELECT COUNT(*) AS k, SUM(priority='emergency') AS e FROM calls WHERE started_at>=? AND started_at<? AND status='completed'",
                         (start.isoformat(timespec="seconds"), end.isoformat(timespec="seconds")))[0]
        rep = db.query("SELECT id, ts FROM reports WHERE night=? AND cost_usd IS NOT NULL ORDER BY id DESC LIMIT 1", (n.isoformat(),))
        out.append({"night": n.isoformat(), "start": start.isoformat(timespec="minutes"), "end": end.isoformat(timespec="minutes"),
                    "calls": calls["k"] or 0, "emergencies": calls["e"] or 0, "in_progress": False,
                    "report_at": rep[0]["ts"] if rep else None})
    return out


def report_for(night) -> dict | None:
    key = night if isinstance(night, str) else night.isoformat()
    rows = db.query("SELECT payload FROM reports WHERE night=? AND cost_usd IS NOT NULL ORDER BY id DESC LIMIT 1", (key,))
    return rows[0]["payload"] if rows and rows[0]["payload"] else None


def build_night_report(night: date) -> dict:
    start, end = night_window(night)
    return build_report(start, end, plan_day=night, night=night)


def build_report(start: datetime, end: datetime, plan_day: date | None = None, night=None) -> dict:
    """Report on completed calls whose ring time falls in [start, end)."""
    calls = db.query("SELECT * FROM calls WHERE started_at>=? AND started_at<? AND status='completed' ORDER BY id",
                     (start.isoformat(timespec="seconds"), end.isoformat(timespec="seconds")))
    hours = max(1, round((end - start).total_seconds() / 3600))
    start_dt, end_dt = start, end
    start = plan_day or plan_start()
    dispatchable = [c for c in calls if c.get("category") in ("service_request", "emergency")
                    and (c["notes"] or {}).get("trade") in ("hvac", "electrical", "solar")]
    batch_ids = {c["id"] for c in dispatchable}
    legal, trade_of, cand_view = {}, {}, {}
    for c in dispatchable:
        cands = _candidates(c, start, batch_ids)
        legal[c["id"]] = {(x["tech_id"], x["date"], x["slot"]) for x in cands}
        trade_of[c["id"]] = c["notes"]["trade"]
        cand_view[c["id"]] = cands[:MAX_CANDIDATES]

    techs = [{k: t[k] for k in ("id", "name", "trades", "level", "home_town", "notes")} for t in technicians()]
    jobs_load = {}
    for j in db.jobs_between(start, start + timedelta(days=PLAN_DAYS - 1)):
        if j["source"] == "schedule":
            jobs_load.setdefault(j["tech_id"], 0)
            jobs_load[j["tech_id"]] += 1
    job_list = []
    for c in dispatchable:
        n = c["notes"]
        held = _held(c)
        job_list.append({"call_id": c["id"], "priority": c.get("priority"), "trade": n.get("trade"), "town": n.get("town"),
                         "problem": n.get("problem_summary"), "equipment": n.get("equipment"), "urgency": n.get("urgency"),
                         "customer_availability": n.get("customer_availability"),
                         "held_window": {"date": held[0], "slot": held[1]} if held else None,
                         "transferred_overnight": bool(c.get("transferred_to")),
                         "options": cand_view[c["id"]]})

    report_id = db.execute("INSERT INTO reports (ts, hours, payload, cost_usd, night) VALUES (?,?,?,?,?)",
                           (db.now_iso(), hours, "{}", 0, night if isinstance(night, str) or night is None else night.isoformat()))
    plan, errors_log = {"overview": "No overnight jobs need a technician.", "assignments": [], "needs_attention": [], "manager_tips": []}, []
    if job_list:
        payload = {"plan_days": [(start + timedelta(days=i)).isoformat() for i in range(PLAN_DAYS)],
                   "slots": {"AM": "8-11", "MID": "11-2", "PM": "2-5"}, "technicians": techs,
                   "existing_jobs_per_tech_next_days": jobs_load, "jobs": job_list}
        messages = [{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]
        for attempt in range(2):
            resp, _ = respond(agent="dispatcher", instructions=INSTRUCTIONS, input=messages, effort="low",
                              text_format=PLAN_FORMAT, report_id=report_id, cache_key="nightshift-dispatcher")
            plan = json.loads(resp.output_text)
            good, errors = validate_plan(plan, legal, trade_of)
            errors_log.append({"attempt": attempt + 1, "errors": errors})
            if not errors:
                break
            messages += [{"role": "assistant", "content": resp.output_text},
                         {"role": "user", "content": "The checker rejected these picks. Fix them using only the listed options and return the full plan again:\n- " + "\n- ".join(errors)}]
        plan["assignments"] = good
        assigned = {a["call_id"] for a in good}
        flagged = {x["call_id"] for x in plan["needs_attention"]}
        for c in dispatchable:
            if c["id"] not in assigned and c["id"] not in flagged:
                plan["needs_attention"].append({"call_id": c["id"], "issue": "No valid technician slot was found; assign by hand."})

    report = _render(calls, dispatchable, plan, errors_log, start, report_id)
    report["range"] = {"start": start_dt.isoformat(timespec="minutes"), "end": end_dt.isoformat(timespec="minutes")}
    report["night"] = night if isinstance(night, str) or night is None else night.isoformat()
    cost = db.query("SELECT COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(cached_tokens),0) AS ca, COALESCE(SUM(output_tokens),0) AS o FROM usage WHERE report_id=?", (report_id,))[0]
    report["report_usage"] = {"cost_usd": cost["c"], "input_tokens": cost["i"], "cached_tokens": cost["ca"], "output_tokens": cost["o"]}
    db.execute("UPDATE reports SET payload=?, cost_usd=? WHERE id=?", (json.dumps(report), cost["c"], report_id))
    return report


def _render(calls, dispatchable, plan, errors_log, start, report_id) -> dict:
    techs = {t["id"]: t for t in technicians()}
    by_id = {c["id"]: c for c in calls}
    assignments = []
    for a in sorted(plan["assignments"], key=lambda a: (a["date"], schedule.SLOT_ORDER[a["slot"]])):
        c = by_id[a["call_id"]]
        n = c["notes"]
        held = _held(c)
        assignments.append({**a, "tech_name": techs[a["tech_id"]]["name"], "tech_level": techs[a["tech_id"]]["level"],
                            "window": schedule.window_label(date.fromisoformat(a["date"]), a["slot"]),
                            "customer": n.get("caller_name"), "phone": n.get("callback_number") or c.get("caller_id"),
                            "address": ", ".join(x for x in [n.get("service_address"), n.get("town")] if x),
                            "problem": n.get("problem_summary"), "priority": c.get("priority"),
                            "matches_hold": bool(held and held == (a["date"], a["slot"])),
                            "miles": schedule.miles(techs[a["tech_id"]]["home_town"], n.get("town"))})
    usage = db.query(
        f"SELECT COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(cached_tokens),0) AS cached_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd "
        f"FROM usage WHERE simulated=0 AND call_id IN ({','.join(str(c['id']) for c in calls) or 'NULL'})")[0]
    cats = {}
    for c in calls:
        cats[c.get("category") or "other"] = cats.get(c.get("category") or "other", 0) + 1
    return {
        "report_id": report_id, "generated_at": db.now_iso(), "plan_start": start.isoformat(),
        "stats": {"calls": len(calls), "by_category": cats,
                  "emergencies": sum(1 for c in calls if c.get("priority") == "emergency"),
                  "transfers": sum(1 for c in calls if c.get("transferred_to")),
                  "to_dispatch": len(dispatchable), "calls_cost_usd": usage["cost_usd"],
                  "calls_tokens": {k: usage[k] for k in ("input_tokens", "cached_tokens", "output_tokens")}},
        "overview": plan["overview"], "assignments": assignments,
        "needs_attention": [{**x, "customer": (by_id.get(x["call_id"], {}).get("notes") or {}).get("caller_name")} for x in plan["needs_attention"]],
        "manager_tips": plan.get("manager_tips", []),
        "checker": errors_log,
        "calls": [{"id": c["id"], "started_at": c["started_at"], "category": c.get("category"), "priority": c.get("priority"),
                   "one_line": c.get("one_line"), "summary": c.get("summary"), "caller": (c["notes"] or {}).get("caller_name"),
                   "transferred_to": c.get("transferred_to")} for c in calls],
        "note": "Suggestions only. Nothing is booked until the manager confirms with the customer and the technician.",
    }


# ---------------------------------------------------------------- per-call hand-off

def suggest_for_call(call: dict) -> dict:
    """Closest free tech: the one behind the held window, else the earliest good option."""
    n = call["notes"] or {}
    trade = (n.get("trade") or "").lower()
    if call.get("category") not in ("service_request", "emergency") or trade not in ("hvac", "electrical", "solar"):
        return {}
    techs = {t["id"]: t for t in technicians()}
    if call.get("hold_job_id"):
        rows = db.query("SELECT tech_id, date, slot FROM jobs WHERE job_id=?", (call["hold_job_id"],))
        if rows:
            r = rows[0]
            return {"tech_id": r["tech_id"], "tech_name": techs[r["tech_id"]]["name"], "date": r["date"], "slot": r["slot"],
                    "window": schedule.window_label(date.fromisoformat(r["date"]), r["slot"]), "basis": "window held on the call"}
    cands = _candidates(call, plan_start(), set())
    if not cands:
        return {"basis": "no free technician in the next 3 days"}
    c = cands[0]
    return {"tech_id": c["tech_id"], "tech_name": c["tech"], "date": c["date"], "slot": c["slot"],
            "window": schedule.window_label(date.fromisoformat(c["date"]), c["slot"]), "basis": "earliest free slot, shortest drive"}


def sms_body(call: dict) -> str:
    """Plain template, no model call: the manager gets the facts, not prose."""
    n = call["notes"] or {}
    tag = {"emergency": "🔴 EMERGENCY", "high": "🟠 HIGH", "normal": "🟢", "low": "⚪"}.get(call.get("priority"), "")
    parts = [f"NightShift #{call['id']} {tag}".strip(), call.get("one_line") or ""]
    who = " ".join(x for x in [n.get("caller_name"), n.get("callback_number") or call.get("caller_id")] if x)
    if who:
        parts.append(who)
    where = ", ".join(x for x in [n.get("service_address"), n.get("town")] if x)
    if where:
        parts.append(where)
    if call.get("transferred_to"):
        parts.append(f"Transferred to on-call {call['transferred_to']}")
    if n.get("held_window"):
        parts.append(f"Tentative: {n['held_window']}")
    sug = call.get("dispatch") or {}
    if sug.get("tech_name"):
        parts.append(f"Suggest: {sug['tech_name']}")
    return " | ".join(p for p in parts if p)


PRIORITY_RANK = {"emergency": 3, "high": 2, "normal": 1, "low": 0}


def should_notify(call: dict) -> bool:
    """Settings: notify_manager = all (yes) | off (no) | priority (only at or above notify_min_priority)."""
    s = settings()
    mode = s.get("notify_manager", "priority")
    if mode == "off":
        return False
    if mode in ("priority", "emergencies"):
        floor = "high" if mode == "emergencies" else s.get("notify_min_priority", "high")
        return PRIORITY_RANK.get(call.get("priority"), 0) >= PRIORITY_RANK.get(floor, 2)
    return True


def on_call_logged(call_id: int) -> None:
    call = db.get_call(call_id)
    if not call:
        return
    suggestion = suggest_for_call(call)
    call["dispatch"] = suggestion
    notified = should_notify(call)
    db.update_call(call_id, dispatch={**suggestion, "notified": notified})
    if notified:
        db.add_message(call_id, business()["manager"]["phone"], sms_body(call), "call_summary")
