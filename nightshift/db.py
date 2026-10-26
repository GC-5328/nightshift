"""SQLite storage: calls, technician jobs/holds, token usage, texts, reports, safety events."""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path

from .config import DATA, RUNTIME

DB_PATH = RUNTIME / "nightshift.db"
_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT, ended_at TEXT, caller_id TEXT, sim_time TEXT,
  status TEXT DEFAULT 'active', mode TEXT DEFAULT 'ai',
  current_step TEXT, outcome TEXT, category TEXT, priority TEXT,
  notes TEXT DEFAULT '{}', summary TEXT, one_line TEXT,
  transcript TEXT DEFAULT '[]', items TEXT DEFAULT '[]', trace TEXT DEFAULT '[]',
  windows TEXT DEFAULT '[]', hold_job_id TEXT, transferred_to TEXT,
  turns INTEGER DEFAULT 0, scenario_id TEXT,
  review TEXT DEFAULT '{}', dispatch TEXT DEFAULT '{}', real_started_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY, tech_id TEXT, date TEXT, slot TEXT,
  title TEXT, customer TEXT, town TEXT, source TEXT DEFAULT 'schedule', call_id INTEGER
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, call_id INTEGER, report_id INTEGER,
  agent TEXT, input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER,
  reasoning_tokens INTEGER, cost_usd REAL, latency_ms INTEGER, simulated INTEGER DEFAULT 0, gateway_cache TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, call_id INTEGER, to_number TEXT, body TEXT, kind TEXT
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, hours INTEGER, payload TEXT, cost_usd REAL, night TEXT
);
CREATE TABLE IF NOT EXISTS safety_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, call_id INTEGER, kind TEXT, detail TEXT
);
"""

JSON_COLS = {"notes", "transcript", "items", "trace", "windows", "payload", "review", "dispatch"}


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


@contextmanager
def conn():
    """One short-lived connection per operation; commits on success, always closes."""
    with _lock:
        c = sqlite3.connect(DB_PATH, check_same_thread=False)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()


def _row(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    for k in JSON_COLS & d.keys():
        if isinstance(d[k], str):
            d[k] = json.loads(d[k] or "null")
    return d


def query(sql: str, args: tuple = ()) -> list[dict]:
    with conn() as c:
        return [_row(r) for r in c.execute(sql, args).fetchall()]


def execute(sql: str, args: tuple = ()) -> int:
    with conn() as c:
        cur = c.execute(sql, args)
        return cur.lastrowid


def init() -> None:
    fresh = not DB_PATH.exists()
    with conn() as c:
        c.executescript(SCHEMA)
        cols = {r[1] for r in c.execute("PRAGMA table_info(calls)")}
        for col, default in (("review", "'{}'"), ("dispatch", "'{}'"), ("real_started_at", "NULL")):  # older databases
            if col not in cols:
                c.execute(f"ALTER TABLE calls ADD COLUMN {col} TEXT DEFAULT {default}")
        if "night" not in {r[1] for r in c.execute("PRAGMA table_info(reports)")}:
            c.execute("ALTER TABLE reports ADD COLUMN night TEXT")
        if "gateway_cache" not in {r[1] for r in c.execute("PRAGMA table_info(usage)")}:
            c.execute("ALTER TABLE usage ADD COLUMN gateway_cache TEXT")
    if fresh or not query("SELECT 1 FROM jobs LIMIT 1"):
        reset_demo(load_sample_night=True)


# ---------- calls ----------

def create_call(caller_id: str, sim_time: str, start_step: str, scenario_id: str | None = None) -> int:
    """started_at is the (simulated) time the phone rang; real_started_at is the wall clock."""
    try:
        started = datetime.fromisoformat(sim_time).isoformat(timespec="seconds")
    except (TypeError, ValueError):
        started = now_iso()
    return execute(
        "INSERT INTO calls (started_at, real_started_at, caller_id, sim_time, current_step, scenario_id) VALUES (?,?,?,?,?,?)",
        (started, now_iso(), caller_id, sim_time, start_step, scenario_id),
    )


def call_end_time(call: dict) -> str:
    """Simulated start + real elapsed time."""
    if not call.get("real_started_at"):
        return now_iso()
    elapsed = datetime.now() - datetime.fromisoformat(call["real_started_at"])
    return (datetime.fromisoformat(call["started_at"]) + elapsed).isoformat(timespec="seconds")


def get_call(call_id: int) -> dict | None:
    rows = query("SELECT * FROM calls WHERE id=?", (call_id,))
    return rows[0] if rows else None


def update_call(call_id: int, **fields) -> None:
    if not fields:
        return
    cols, vals = [], []
    for k, v in fields.items():
        cols.append(f"{k}=?")
        vals.append(json.dumps(v) if k in JSON_COLS else v)
    execute(f"UPDATE calls SET {', '.join(cols)} WHERE id=?", (*vals, call_id))


def list_calls(limit: int = 200) -> list[dict]:
    return query("SELECT * FROM calls ORDER BY id DESC LIMIT ?", (limit,))


def calls_since(hours: int) -> list[dict]:
    since = (datetime.now() - timedelta(hours=hours)).isoformat(timespec="seconds")
    return query("SELECT * FROM calls WHERE started_at>=? AND status='completed' ORDER BY id", (since,))


# ---------- usage ledger ----------

def log_usage(agent: str, u: dict, call_id: int | None = None, report_id: int | None = None, simulated: bool = False) -> None:
    execute(
        "INSERT INTO usage (ts, call_id, report_id, agent, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_usd, latency_ms, simulated, gateway_cache) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (now_iso(), call_id, report_id, agent, u["input_tokens"], u["cached_tokens"], u["output_tokens"],
         u["reasoning_tokens"], u["cost_usd"], u["latency_ms"], int(simulated), u.get("gateway_cache", "")),
    )


def usage_for_call(call_id: int, include_simulated: bool = False) -> dict:
    sim = "" if include_simulated else "AND simulated=0"
    rows = query(
        f"SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(cached_tokens),0) AS cached_tokens, "
        f"COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens, "
        f"COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(AVG(latency_ms),0) AS avg_latency_ms FROM usage WHERE call_id=? {sim}",
        (call_id,),
    )
    return rows[0]


def spend_today() -> float:
    start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).isoformat(timespec="seconds")
    return query("SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage WHERE ts>=? AND simulated=0", (start,))[0]["s"]


# ---------- jobs & holds ----------

def jobs_between(start: date, end: date) -> list[dict]:
    return query("SELECT * FROM jobs WHERE date>=? AND date<=? ORDER BY date, slot", (start.isoformat(), end.isoformat()))


def add_hold(call_id: int, tech_id: str, day: str, slot: str, town: str, title: str, customer: str) -> str:
    job_id = f"H{call_id:04d}"
    execute("DELETE FROM jobs WHERE job_id=?", (job_id,))
    execute(
        "INSERT INTO jobs (job_id, tech_id, date, slot, title, customer, town, source, call_id) VALUES (?,?,?,?,?,?,?,?,?)",
        (job_id, tech_id, day, slot, title, customer, town, "hold", call_id),
    )
    return job_id


# ---------- texts, reports, safety ----------

def add_message(call_id: int | None, to_number: str, body: str, kind: str) -> None:
    execute("INSERT INTO messages (ts, call_id, to_number, body, kind) VALUES (?,?,?,?,?)", (now_iso(), call_id, to_number, body, kind))


def safety_event(call_id: int | None, kind: str, detail: str) -> None:
    execute("INSERT INTO safety_events (ts, call_id, kind, detail) VALUES (?,?,?,?)", (now_iso(), call_id, kind, detail))


# ---------- demo data ----------

def reset_demo(load_sample_night: bool = True) -> dict:
    """Wipe everything and re-anchor the technician schedule to today."""
    with conn() as c:
        for t in ("calls", "jobs", "usage", "messages", "reports", "safety_events"):
            c.execute(f"DELETE FROM {t}")
        c.execute("DELETE FROM sqlite_sequence")
        today = date.today()
        template = json.loads((DATA / "schedule_template.json").read_text(encoding="utf-8"))
        works = {t["id"]: set(t["work_days"]) for t in json.loads((DATA / "technicians.json").read_text(encoding="utf-8"))}
        for j in template:
            day = today + timedelta(days=j["day_offset"])
            if day.strftime("%a") not in works.get(j["tech_id"], set()):
                continue
            c.execute(
                "INSERT INTO jobs (job_id, tech_id, date, slot, title, customer, town, source) VALUES (?,?,?,?,?,?,?,?)",
                (j["job_id"], j["tech_id"], day.isoformat(), j["slot"], j["title"], j["customer"], j["town"], "schedule"),
            )
    loaded = 0
    sample = DATA / "sample_night.json"
    if load_sample_night and sample.exists():
        loaded = _load_sample_night(json.loads(sample.read_text(encoding="utf-8")))
    return {"jobs": len(template), "sample_calls": loaded}


def _load_sample_night(sample: dict) -> int:
    """Replay recorded real calls as if they happened last night (dates shifted)."""
    recorded_day = date.fromisoformat(sample["recorded_on"])
    shift = date.today() - recorded_day  # recorded "today" -> real today

    def sh(ts: str | None) -> str | None:
        if not ts:
            return ts
        return (datetime.fromisoformat(ts) + shift).isoformat(timespec="seconds")

    def sh_day(d: str) -> str:
        return (date.fromisoformat(d) + shift).isoformat()

    for call in sample["calls"]:
        u = call.pop("usage_rows", [])
        holds = call.pop("hold_rows", [])
        msgs = call.pop("message_rows", [])
        events = call.pop("safety_rows", [])
        old_id = call.pop("id")
        call["started_at"], call["ended_at"] = sh(call["started_at"]), sh(call["ended_at"])
        for w in call.get("windows") or []:
            w["date"] = sh_day(w["date"])
            w["window_id"] = f"{w['date']}_{w['slot']}"
        cols = list(call)
        vals = [json.dumps(call[k]) if k in JSON_COLS else call[k] for k in cols]
        new_id = execute(f"INSERT INTO calls ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", tuple(vals))
        for r in u:
            execute(
                "INSERT INTO usage (ts, call_id, agent, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_usd, latency_ms, simulated) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (sh(r["ts"]), new_id, r["agent"], r["input_tokens"], r["cached_tokens"], r["output_tokens"], r["reasoning_tokens"], r["cost_usd"], r["latency_ms"], r["simulated"]),
            )
        for h in holds:
            job_id = f"H{new_id:04d}"
            execute(
                "INSERT OR REPLACE INTO jobs (job_id, tech_id, date, slot, title, customer, town, source, call_id) VALUES (?,?,?,?,?,?,?,?,?)",
                (job_id, h["tech_id"], sh_day(h["date"]), h["slot"], h["title"], h["customer"], h["town"], "hold", new_id),
            )
            execute("UPDATE calls SET hold_job_id=? WHERE id=?", (job_id, new_id))
        for m in msgs:
            execute("INSERT INTO messages (ts, call_id, to_number, body, kind) VALUES (?,?,?,?,?)", (sh(m["ts"]), new_id, m["to_number"], m["body"].replace(f"#{old_id}", f"#{new_id}"), m["kind"]))
        for e in events:
            execute("INSERT INTO safety_events (ts, call_id, kind, detail) VALUES (?,?,?,?)", (sh(e["ts"]), new_id, e["kind"], e["detail"]))
    return len(sample["calls"])


def export_sample_night(call_ids: list[int]) -> dict:
    """Snapshot real calls (with their usage rows) so a fresh clone has a 'last night' to report on."""
    calls = []
    for cid in call_ids:
        call = get_call(cid)
        if not call:
            continue
        call["usage_rows"] = query("SELECT ts, agent, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_usd, latency_ms, simulated FROM usage WHERE call_id=?", (cid,))
        call["hold_rows"] = query("SELECT tech_id, date, slot, title, customer, town FROM jobs WHERE call_id=?", (cid,))
        call["message_rows"] = query("SELECT ts, to_number, body, kind FROM messages WHERE call_id=?", (cid,))
        call["safety_rows"] = query("SELECT ts, kind, detail FROM safety_events WHERE call_id=?", (cid,))
        call.pop("hold_job_id", None)
        calls.append(call)
    return {"recorded_on": date.today().isoformat(), "calls": calls}
