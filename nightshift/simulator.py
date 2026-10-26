"""Load test / demo: run many simulated callers at once, paced like real phone calls,
so the manager can watch (and listen to) them live.

Each call runs in its own thread: simulated caller line -> pause for speaking time ->
Receptionist turn -> pause for speaking time -> ... The caller's line is published
before the agent answers, so live listeners hear the conversation in order.
"""

from __future__ import annotations

import random
import threading
import time
import uuid
from datetime import datetime

from . import autocaller, caller_gen, db, receptionist

MAX_CONCURRENT = 25          # most calls one test batch can queue
LINES = 3                    # simulated calls on the line at the same time
WORDS_PER_SEC = 2.6
_slots = threading.BoundedSemaphore(LINES)

_lock = threading.Lock()
LIVE: dict[int, dict] = {}       # call_id -> {"batch", "scenario", "pending": caller line being spoken}
BATCHES: dict[str, dict] = {}    # batch_id -> {"stop": Event, "n", "started", "call_ids"}


def speaking_time(text: str, pace: str) -> float:
    if pace == "fast":
        return 0.3
    return min(12.0, 0.6 + len(text.split()) / WORDS_PER_SEC)


def active_count() -> int:
    with _lock:
        return len(LIVE)


QUEUED = {"n": 0}


def start_batch(n: int, scenario_ids: list[str] | None, pace: str = "realistic", spread_s: int = 20,
                mode: str = "invent") -> dict:
    """mode 'invent': every call gets a brand-new invented caller. mode 'cards': reuse data/scenarios.json."""
    pool = [s for s in autocaller.scenarios() if not scenario_ids or s["id"] in scenario_ids]
    if mode == "invent":
        pool = [None]  # placeholder: each call invents its own caller once a line is free
    if not pool:
        raise ValueError("no scenarios selected")
    n = max(1, min(n, MAX_CONCURRENT))
    bid = uuid.uuid4().hex[:8]
    stop = threading.Event()
    BATCHES[bid] = {"id": bid, "stop": stop, "n": n, "started": db.now_iso(), "call_ids": [], "pace": pace}
    rnd = random.Random()
    for i in range(n):
        sc = pool[i % len(pool)] if n <= len(pool) else rnd.choice(pool)  # None = invent
        delay = 0 if i < LINES else rnd.uniform(0, min(spread_s, 5))  # queued calls ring soon after a line frees
        threading.Thread(target=_run_call, args=(bid, sc, delay, pace), daemon=True).start()
    return {"batch_id": bid, "launched": n}


def stop_all() -> int:
    for b in BATCHES.values():
        b["stop"].set()
    with _lock:
        ids = list(LIVE)
    for cid in ids:
        receptionist.hang_up(cid)
    return len(ids)


def _run_call(bid: str, sc: dict, delay: float, pace: str) -> None:
    batch = BATCHES[bid]
    with _lock:
        QUEUED["n"] += 1
    try:
        # wait for one of the 3 lines to free up (checking for "Stop all" while waiting)
        while not _slots.acquire(timeout=0.5):
            if batch["stop"].is_set():
                return
    finally:
        with _lock:
            QUEUED["n"] -= 1
    try:
        if batch["stop"].wait(delay):
            return
        _call(bid, batch, sc, pace)
    finally:
        _slots.release()


def _call(bid: str, batch: dict, sc: dict | None, pace: str) -> None:
    if sc is None:
        sc = caller_gen.invent()          # a new person and situation every time
        caller_id = sc["caller_id"]
    else:  # fixed card: vary caller ID a little so copies look like different people
        caller_id = sc["caller_id"] if random.random() < .5 else sc["caller_id"][:-4] + f"{random.randint(0, 9999):04d}"
    r = receptionist.start_call(caller_id, datetime.now().isoformat(timespec="minutes"), sc["id"], force_ai=True)
    cid = r["call_id"]
    if sc.get("gen_id"):
        caller_gen.link_call(sc["gen_id"], cid)
    batch["call_ids"].append(cid)
    with _lock:
        LIVE[cid] = {"batch": bid, "scenario": sc["id"], "title": sc["title"], "pending": None}
    try:
        time.sleep(speaking_time(r["reply"], pace))
        for _ in range(24):
            if batch["stop"].is_set():
                receptionist.hang_up(cid)
                return
            line = autocaller.next_line(cid, sc)
            if autocaller.HANGUP in line:
                receptionist.hang_up(cid)
                return
            with _lock:
                LIVE[cid]["pending"] = line          # live listeners hear the caller first
            time.sleep(speaking_time(line, pace))
            out = receptionist.handle_turn(cid, line)
            with _lock:
                LIVE[cid]["pending"] = None
            if out.get("error") or out.get("ended"):
                return
            time.sleep(speaking_time(out.get("reply", ""), pace))
        receptionist.hang_up(cid)
    except Exception as exc:  # one broken call must not stop the batch
        db.safety_event(cid, "simulator_error", str(exc)[:200])
        receptionist.hang_up(cid)
    finally:
        time.sleep(1.5)
        with _lock:
            LIVE.pop(cid, None)


def live_calls() -> list[dict]:
    """Every call on the line right now (simulated or a person testing), newest first."""
    rows = db.query("SELECT * FROM calls WHERE status IN ('active','finalizing') ORDER BY id DESC LIMIT 60")
    with _lock:
        live = {k: dict(v) for k, v in LIVE.items()}
    out = []
    for c in rows:
        n = c.get("notes") or {}
        meta = live.get(c["id"], {})
        tr = c.get("transcript") or []
        flags = [e.get("guard") for e in c.get("trace") or [] if e.get("kind") == "guard"]
        out.append({
            "id": c["id"], "caller_id": c["caller_id"], "caller_name": n.get("caller_name"), "town": n.get("town"),
            "trade": n.get("trade"), "step": c["current_step"], "status": c["status"], "turns": c["turns"],
            "started_at": c["started_at"], "real_started_at": c.get("real_started_at"),
            "simulated": bool(meta), "scenario": meta.get("title"), "pending": meta.get("pending"),
            "last": tr[-1] if tr else None, "lines": len(tr) + (1 if meta.get("pending") else 0),
            "emergency": "emergency_override" in flags or c["current_step"] in ("emergency", "transfer_oncall"),
            "attack": "prompt_injection" in flags or "provider_filter" in flags,
            "held_window": n.get("held_window"),
        })
    return out


def live_transcript(call_id: int, since: int = 0) -> dict:
    c = db.get_call(call_id)
    if not c:
        return {"error": "not found"}
    lines = list(c.get("transcript") or [])
    with _lock:
        pending = (LIVE.get(call_id) or {}).get("pending")
    if pending and not (lines and lines[-1]["role"] == "caller" and lines[-1]["text"] == pending):
        lines.append({"role": "caller", "text": pending, "step": c["current_step"], "pending": True})
    return {"id": call_id, "status": c["status"], "step": c["current_step"], "notes": c.get("notes") or {},
            "lines": lines[since:], "total": len(lines), "caller_id": c["caller_id"]}
