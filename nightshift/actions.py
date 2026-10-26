"""Action items: what the office should do about each call. Nothing is sent to the office
automatically; the manager reviews the list, changes or removes items, and pushes them.

kind 'visit'  - a visit window was held on the call (someone must confirm it and assign a tech)
kind 'alert'  - the manager was texted about the call (someone must follow up)
"""

from __future__ import annotations

from . import db

ACTIONS = {
    "confirm_visit": "Confirm visit & assign technician",
    "call_back_first": "Call customer back first thing",
    "follow_up_emergency": "Follow up on emergency",
    "reschedule": "Offer a different time",
    "send_quote": "Send a quote / estimate",
    "review": "Review the call",
    "none": "No action needed",
}
OFFICE = "Office front desk (receptionist & dispatcher)"


def _ensure_table() -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS action_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, call_id INTEGER, kind TEXT, action TEXT, status TEXT DEFAULT 'open',
        assignee TEXT, created_at TEXT, updated_at TEXT, pushed_at TEXT, UNIQUE(call_id, kind))""")


def default_action(call: dict, kind: str) -> str:
    n = call.get("notes") or {}
    if kind == "visit":
        return "confirm_visit"
    if call.get("priority") == "emergency" or call.get("transferred_to"):
        return "follow_up_emergency"
    if n.get("service_needed") in ("replace", "upgrade") or "quote" in (call.get("one_line") or "").lower():
        return "send_quote"
    if call.get("priority") == "high":
        return "call_back_first"
    return "review"


def sync(calls: list[dict]) -> None:
    """Make sure every held visit and every alert in these calls has an action item."""
    _ensure_table()
    if not calls:
        return
    ids = ",".join(str(c["id"]) for c in calls)
    have = {(r["call_id"], r["kind"]) for r in db.query(f"SELECT call_id, kind FROM action_items WHERE call_id IN ({ids})")}
    alerted = {r["call_id"] for r in db.query(f"SELECT DISTINCT call_id FROM messages WHERE call_id IN ({ids})")}
    for c in calls:
        if c.get("status") != "completed":
            continue
        kinds = []
        if (c.get("notes") or {}).get("held_window"):
            kinds.append("visit")
        if c["id"] in alerted:
            kinds.append("alert")
        for k in kinds:
            if (c["id"], k) not in have:
                db.execute("INSERT OR IGNORE INTO action_items (call_id, kind, action, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                           (c["id"], k, default_action(c, k), "open", db.now_iso(), db.now_iso()))


def items(call_ids: list[int], kind: str | None = None) -> list[dict]:
    _ensure_table()
    if not call_ids:
        return []
    ids = ",".join(str(i) for i in call_ids)
    where = f"a.call_id IN ({ids})" + (" AND a.kind=?" if kind else "")
    rows = db.query(f"SELECT a.*, c.notes, c.priority, c.one_line, c.started_at, c.caller_id, c.dispatch, c.transferred_to "
                    f"FROM action_items a JOIN calls c ON c.id=a.call_id WHERE {where} ORDER BY c.started_at DESC", (kind,) if kind else ())
    out = []
    for r in rows:
        n = r.pop("notes") or {}
        if isinstance(n, str):
            import json
            n = json.loads(n)
        d = r.pop("dispatch") or {}
        if isinstance(d, str):
            import json
            d = json.loads(d or "{}")
        out.append({**r, "customer": n.get("caller_name"), "phone": n.get("callback_number") or r.get("caller_id"),
                    "address": ", ".join(x for x in [n.get("service_address"), n.get("town")] if x),
                    "held_window": n.get("held_window"), "suggested_tech": d.get("tech_name"),
                    "action_label": ACTIONS.get(r["action"], r["action"])})
    return out


def counts(call_ids: list[int]) -> dict:
    out = {k: {"total": 0, "open": 0, "pushed": 0, "removed": 0} for k in ("visit", "alert")}
    for it in items(call_ids):
        out[it["kind"]]["total"] += 1
        out[it["kind"]][it["status"]] = out[it["kind"]].get(it["status"], 0) + 1
    return out


def update(item_id: int, action: str | None = None, status: str | None = None) -> None:
    _ensure_table()
    if action and action in ACTIONS:
        db.execute("UPDATE action_items SET action=?, updated_at=? WHERE id=?", (action, db.now_iso(), item_id))
    if status in ("open", "removed"):
        db.execute("UPDATE action_items SET status=?, updated_at=?, pushed_at=CASE WHEN ?='open' THEN NULL ELSE pushed_at END, "
                   "assignee=CASE WHEN ?='open' THEN NULL ELSE assignee END WHERE id=?", (status, db.now_iso(), status, status, item_id))


def push(item_ids: list[int]) -> int:
    """The manager's button: hand the chosen open items to the office front desk."""
    _ensure_table()
    if not item_ids:
        return 0
    ids = ",".join(str(int(i)) for i in item_ids)
    now = db.now_iso()
    n = db.query(f"SELECT COUNT(*) AS k FROM action_items WHERE id IN ({ids}) AND status='open' AND action<>'none'")[0]["k"]
    db.execute(f"UPDATE action_items SET status='pushed', assignee=?, pushed_at=?, updated_at=? "
               f"WHERE id IN ({ids}) AND status='open' AND action<>'none'", (OFFICE, now, now))
    return n
