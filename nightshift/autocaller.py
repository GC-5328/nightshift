"""Simulated caller for demos and evals: the model plays a customer from a scenario card.

Its tokens are logged with simulated=1 so they never count toward the product's cost.
"""

from __future__ import annotations

from . import db
from .config import load_json
from .llm import respond

HANGUP = "[hangs up]"


def scenarios() -> list[dict]:
    return load_json("scenarios.json")


def scenario(sid: str) -> dict | None:
    if sid and sid.startswith("gen-"):
        rows = db.query("SELECT * FROM generated_callers WHERE id=?", (int(sid[4:]),))
        if rows:
            r = rows[0]
            return {"id": sid, "title": r["title"], "caller_id": r["phone"], "persona": r["persona"], "facts": r["facts"]}
    return next((s for s in scenarios() if s["id"] == sid), None)


def next_line(call_id: int, sc: dict) -> str:
    call = db.get_call(call_id)
    instructions = f"""You are role-playing a person phoning a home services company's after-hours line. You are the CALLER, not the agent.
Persona: {sc['persona']}
Facts you know (share them naturally, only when asked or when it fits; never all at once): {sc['facts']}
Your caller ID is {sc['caller_id']}.
Speak like a real person on the phone: one or two short sentences, no stage directions, no quotes.
If the agent has said goodbye or is connecting you to someone, reply exactly: {HANGUP}"""
    convo = []
    for m in call["transcript"]:
        # From the caller's point of view, the agent is "user" and you are "assistant".
        convo.append({"role": "assistant" if m["role"] == "caller" else "user", "content": m["text"]})
    resp, _ = respond(agent="sim_caller", instructions=instructions, input=convo, effort="none",
                      call_id=call_id, simulated=True, max_output_tokens=200)
    return (resp.output_text or HANGUP).strip()
