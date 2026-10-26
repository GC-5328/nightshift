"""NightShift - after-hours call agent for trades businesses.

Run:  python app.py   then open http://127.0.0.1:5050
"""

from __future__ import annotations

import os
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from nightshift import autocaller, db, dispatch, metrics, receptionist, schedule, simulator
from nightshift.config import (MODEL, ROOT, business, key_status, note_fields, save_settings, settings, technicians)
from nightshift.tree import load_tree, reset_tree, save_tree, validate

app = Flask(__name__, static_folder=str(ROOT / "static"), static_url_path="/static")
db.init()


def body() -> dict:
    return request.get_json(silent=True) or {}


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/health")
def health():
    return {"ok": True, "model": MODEL, "keys": key_status()}


@app.get("/api/bootstrap")
def bootstrap():
    return {"settings": settings(), "business": business(), "tree": load_tree(), "note_fields": note_fields(),
            "technicians": technicians(), "model": MODEL, "keys": key_status(),
            "scenarios": [{k: s[k] for k in ("id", "title", "caller_id")} for s in autocaller.scenarios()],
            "max_concurrent": simulator.MAX_CONCURRENT}


# ---------------- calls

@app.post("/api/calls")
def start_call():
    b = body()
    return receptionist.start_call(b.get("caller_id") or "(203) 555-0100", b.get("sim_time"), b.get("scenario_id"))


@app.post("/api/calls/<int:call_id>/turn")
def turn(call_id: int):
    text = (body().get("text") or "").strip()
    if not text:
        return {"error": "empty"}, 400
    try:
        return receptionist.handle_turn(call_id, text)
    except RuntimeError as exc:  # missing API key etc.
        return {"error": str(exc)}, 500


@app.post("/api/calls/<int:call_id>/autocaller")
def auto_line(call_id: int):
    call = db.get_call(call_id)
    sid = body().get("scenario_id") or (call or {}).get("scenario_id") or ""
    sc = autocaller.scenario(sid)
    if not call or not sc:
        return {"error": "pick a scenario"}, 400
    return {"text": autocaller.next_line(call_id, sc)}


@app.post("/api/calls/<int:call_id>/hangup")
def hangup(call_id: int):
    return receptionist.hang_up(call_id)


@app.get("/api/calls")
def calls():
    out = []
    for c in db.list_calls(500):
        row = metrics.call_row(c)
        u = db.usage_for_call(c["id"])
        row.update(cost_usd=u["cost_usd"], tokens=u["input_tokens"] + u["output_tokens"], turns=c["turns"])
        out.append(row)
    return jsonify(out)


@app.get("/api/overview")
def overview():
    return metrics.overview(request.args.get("window"))


@app.get("/api/analysis")
def analysis():
    return metrics.analysis(int(request.args.get("days", 7)))


@app.get("/api/actions")
def action_list():
    """Action items for the calls in an overview window (tonight / last night / 7d)."""
    from nightshift import actions
    o = metrics.overview(request.args.get("window"))
    return {"items": actions.items(o["call_ids"], request.args.get("kind")), "choices": actions.ACTIONS,
            "office": actions.OFFICE, "window": o["window"]}


@app.post("/api/actions/<int:item_id>")
def action_update(item_id: int):
    from nightshift import actions
    b = body()
    actions.update(item_id, b.get("action"), b.get("status"))
    return {"ok": True}


@app.post("/api/actions/push")
def action_push():
    from nightshift import actions
    return {"pushed": actions.push(body().get("ids") or []), "office": actions.OFFICE}


@app.post("/api/agent")
def agent_switch():
    """The manager's on/off switch for the AI agent."""
    return save_settings({"agent_enabled": bool(body().get("enabled"))})


@app.get("/api/calls/<int:call_id>")
def call_detail(call_id: int):
    c = db.get_call(call_id)
    if not c:
        return {"error": "not found"}, 404
    c.pop("items", None)
    c["usage"] = db.usage_for_call(call_id)
    c["usage_rows"] = db.query("SELECT agent, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_usd, latency_ms, simulated FROM usage WHERE call_id=? ORDER BY id", (call_id,))
    c["safety_events"] = db.query("SELECT ts, kind, detail FROM safety_events WHERE call_id=?", (call_id,))
    c["messages"] = db.query("SELECT ts, to_number, body FROM messages WHERE call_id=?", (call_id,))
    return c


@app.get("/api/live")
def live():
    return {"calls": simulator.live_calls(), "simulated_running": simulator.active_count(),
            "queued": simulator.QUEUED["n"], "lines": simulator.LINES}


@app.get("/api/live/<int:call_id>")
def live_call(call_id: int):
    return simulator.live_transcript(call_id, int(request.args.get("since", 0)))


@app.post("/api/simulate")
def simulate():
    """Test button: launch many simulated callers at once."""
    b = body()
    try:
        return simulator.start_batch(int(b.get("n") or 3), b.get("scenarios") or None, b.get("pace") or "realistic",
                                     int(b["spread_s"]) if b.get("spread_s") is not None else 20, b.get("mode") or "invent")
    except ValueError as exc:
        return {"error": str(exc)}, 400


@app.get("/api/generated")
def generated():
    from nightshift import caller_gen
    return {"callers": caller_gen.recent(100), "log_file": str(caller_gen.LOG_FILE.relative_to(ROOT))}


@app.post("/api/simulate/stop")
def simulate_stop():
    return {"stopped": simulator.stop_all()}


@app.get("/api/messages")
def messages():
    return jsonify(db.query("SELECT * FROM messages ORDER BY id DESC LIMIT 100"))


# ---------------- morning report

@app.get("/api/reports/nights")
def report_nights():
    return {"current": dispatch.current_entry(), "nights": dispatch.nights(14)}


@app.get("/api/reports/night/<night>")
def report_night(night: str):
    from datetime import date as _d
    return {"report": dispatch.report_for(night if night == "current" else _d.fromisoformat(night))}


@app.post("/api/reports/night/<night>")
def build_night(night: str):
    """Build (or rebuild) the morning report for one night shift."""
    from datetime import date as _d
    try:
        if night == "current":
            return dispatch.build_current_report()
        return dispatch.build_night_report(_d.fromisoformat(night))
    except RuntimeError as exc:
        return {"error": str(exc)}, 500


# ---------------- settings, tree, schedule

@app.route("/api/settings", methods=["GET", "POST"])
def settings_route():
    if request.method == "POST":
        return save_settings(body())
    return settings()


# ---------------- customer knowledge base (upload only; not read by the agent yet)

KB_DIR = ROOT / "runtime" / "knowledge_base"
KB_TYPES = {".pdf", ".docx", ".doc", ".txt", ".md", ".csv", ".xlsx", ".xls", ".json"}
KB_MAX_BYTES = 10 * 1024 * 1024


def kb_list():
    KB_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(KB_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if f.is_file():
            st = f.stat()
            out.append({"name": f.name, "bytes": st.st_size, "type": f.suffix.lower().lstrip("."),
                        "uploaded_at": __import__("datetime").datetime.fromtimestamp(st.st_mtime).isoformat(timespec="minutes")})
    return out


@app.get("/api/kb")
def kb_get():
    return {"files": kb_list(), "allowed": sorted(KB_TYPES), "max_mb": KB_MAX_BYTES // (1024 * 1024)}


@app.post("/api/kb")
def kb_upload():
    from werkzeug.utils import secure_filename
    KB_DIR.mkdir(parents=True, exist_ok=True)
    saved, rejected = [], []
    for f in request.files.getlist("files"):
        name = secure_filename(f.filename or "")
        ext = Path(name).suffix.lower()
        data = f.read(KB_MAX_BYTES + 1)
        if not name or ext not in KB_TYPES:
            rejected.append({"name": f.filename, "why": "file type not allowed"})
        elif len(data) > KB_MAX_BYTES:
            rejected.append({"name": f.filename, "why": "larger than 10 MB"})
        else:
            (KB_DIR / name).write_bytes(data)
            saved.append(name)
    return {"saved": saved, "rejected": rejected, "files": kb_list()}


@app.delete("/api/kb/<name>")
def kb_delete(name: str):
    from werkzeug.utils import secure_filename
    p = KB_DIR / secure_filename(name)
    if p.is_file() and p.parent == KB_DIR:
        p.unlink()
    return {"files": kb_list()}


@app.get("/api/tree")
def get_tree():
    return load_tree()


@app.post("/api/tree")
def put_tree():
    errors = save_tree(body())
    return ({"ok": False, "errors": errors}, 400) if errors else {"ok": True}


@app.post("/api/tree/validate")
def check_tree():
    return {"errors": validate(body())}


@app.post("/api/tree/import-retell")
def import_retell():
    """Turn a Retell AI agent export into a NightShift call flow (not saved until the user presses Save)."""
    from nightshift.retell_import import convert, is_retell
    b = body()
    if not is_retell(b.get("export") or {}):
        return {"error": "This does not look like a Retell agent export."}, 400
    tree = convert(b["export"], company_name=business()["company_name"], brand=b.get("brand") or None)
    return {"tree": tree, "errors": validate(tree)}


@app.post("/api/tree/reset")
def tree_reset():
    reset_tree()
    return load_tree()


@app.get("/api/schedule")
def get_schedule():
    from datetime import date as _d
    start = request.args.get("start")
    return schedule.schedule_grid(min(int(request.args.get("days", 7)), 42), _d.fromisoformat(start) if start else None)


@app.post("/api/demo/reset")
def demo_reset():
    return db.reset_demo(load_sample_night=body().get("sample_night", True))


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5050"))
    print(f"\n  NightShift running on http://127.0.0.1:{port}\n")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
