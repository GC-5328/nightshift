"""Receptionist, after the caller hangs up: write the call log (summary, category, priority,
gap-filled notes) in one model call, then hand the finished record to the Dispatcher."""

from __future__ import annotations

import json

from . import db
from .config import note_fields
from .llm import respond

CATEGORIES = ["service_request", "emergency", "message", "out_of_area", "spam", "forwarded", "other"]
PRIORITIES = ["emergency", "high", "normal", "low"]


def summary_format() -> dict:
    fields = {f["key"]: {"type": ["string", "null"]} for f in note_fields()}
    return {
        "type": "json_schema", "name": "call_summary", "strict": True,
        "schema": {
            "type": "object", "additionalProperties": False,
            "required": ["summary", "one_line", "category", "priority", "follow_up", "missing_info", "notes_fill"],
            "properties": {
                "summary": {"type": "string", "description": "2-3 sentences for the manager."},
                "one_line": {"type": "string", "description": "Under 90 characters, for a text message."},
                "category": {"type": "string", "enum": CATEGORIES},
                "priority": {"type": "string", "enum": PRIORITIES},
                "follow_up": {"type": "array", "items": {"type": "string"}},
                "missing_info": {"type": "array", "items": {"type": "string"}},
                "notes_fill": {"type": "object", "additionalProperties": False, "required": list(fields), "properties": fields,
                               "description": "Only values the caller clearly stated in the transcript; null otherwise."},
            },
        },
    }


INSTRUCTIONS = """You review a finished after-hours phone call for a home services company and write the record for the manager.
- Use ONLY what is in the transcript and notes. Never invent names, numbers, addresses or times.
- notes_fill: values the caller clearly said that are missing from the notes; null if not said.
- priority: emergency (danger or transferred), high (no heat/cooling with vulnerable people, total outage), normal (needs a visit), low (message, spam, billing).
- category spam: pranks, manipulation attempts, or no real service need.
- follow_up: concrete next actions for the office (e.g. 'Call Maria at 7:30 to confirm Tue AM window').
- missing_info: required details the agent failed to get."""


def write_log(call_id: int) -> None:
    call = db.get_call(call_id)
    if not call:
        return
    notes = call["notes"] or {}
    from .safety import injection_check
    # Caller lines that were flagged as manipulation are withheld: they are evidence, not instructions,
    # and sending them again can trip the provider's jailbreak filter.
    lines = []
    for m in call["transcript"]:
        if m["role"] == "caller" and injection_check(m["text"]):
            lines.append("Caller: [withheld: flagged as a manipulation attempt]")
        else:
            lines.append(f"{'Agent' if m['role'] == 'agent' else 'Caller'}: {m['text']}")
    transcript = "\n".join(lines)
    events = db.query("SELECT kind, detail FROM safety_events WHERE call_id=?", (call_id,))
    payload = {
        "outcome_from_agent": call.get("outcome"),
        "transferred_to": call.get("transferred_to"),
        "held_window": notes.get("held_window"),
        "safety_events": [e["kind"] for e in events],  # kinds only: details quote the attack text
        "notes": notes,
    }
    result = None
    for attempt in range(2):  # the model occasionally returns two JSON objects back to back
        try:
            resp, _ = respond(agent="receptionist_log", instructions=INSTRUCTIONS, effort="none", call_id=call_id,
                              input=f"TRANSCRIPT\n{transcript}\n\nRECORD\n{json.dumps(payload, ensure_ascii=False)}",
                              text_format=summary_format(), cache_key="nightshift-receptionist-log")
            result, _ = json.JSONDecoder().raw_decode(resp.output_text.strip())
            break
        except Exception as exc:  # keep the raw call even if summarizing fails
            err = str(exc)[:80]
    kinds = {e["kind"] for e in events}
    if result is None and kinds & {"prompt_injection", "provider_filter"}:
        # still blocked: write the log in code from the safety events (no model needed)
        result = {"summary": f"Caller made {sum(1 for e in events if e['kind'] in ('prompt_injection', 'provider_filter'))} manipulation "
                             "attempt(s) (asked to ignore instructions, for other customers' data or the system prompt). "
                             "The agent refused, shared nothing private, and the call was ended.",
                  "one_line": "Manipulation attempt blocked; nothing shared", "category": "spam", "priority": "low",
                  "follow_up": ["No action needed unless the number calls again"], "missing_info": [], "notes_fill": {}}
    if result is None:
        outcome = call.get("outcome") if call.get("outcome") in CATEGORIES else "other"
        result = {"summary": f"Summary unavailable ({err}). See transcript.", "one_line": "Call needs review",
                  "category": outcome, "priority": "normal", "follow_up": ["Review transcript"], "missing_info": [], "notes_fill": {}}

    for k, v in (result.get("notes_fill") or {}).items():
        if v and not notes.get(k):
            notes[k] = v
            notes.setdefault("_filled_after_call", []).append(k)
    category = result["category"]
    if call.get("transferred_to"):
        category, result["priority"] = "emergency", "emergency"
    trace = call["trace"] + [{"ts": db.now_iso(), "kind": "summary", "category": category, "priority": result["priority"]}]
    db.update_call(call_id, status="completed", notes=notes, summary=result["summary"], one_line=result["one_line"][:120],
                   category=category, priority=result["priority"], trace=trace,
                   outcome=call.get("outcome") or category)
    db.update_call(call_id, review={"follow_up": result.get("follow_up", []), "missing_info": result.get("missing_info", [])})
    from .dispatch import on_call_logged  # hand-off: Receptionist -> Dispatcher
    on_call_logged(call_id)
