"""Convert a Retell AI agent export (conversationFlow JSON) into a NightShift call flow.

Retell nodes become steps, edge transition prompts become 'when' conditions,
end nodes become 'end' steps. Empty placeholder nodes and dangling edges are dropped.
The result still goes through tree.validate() before it can be saved.
"""

from __future__ import annotations

import re


def _slug(name: str, used: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", (name or "step").lower()).strip("_")[:30] or "step"
    if not re.match(r"[a-z]", base):
        base = "s_" + base
    sid, i = base, 2
    while sid in used or len(sid) < 2:
        sid = f"{base}_{i}"
        i += 1
    used.add(sid)
    return sid


def _text(node: dict) -> str:
    ins = node.get("instruction") or {}
    return (ins.get("text") if isinstance(ins, dict) else str(ins) or "").strip()


def is_retell(obj: dict) -> bool:
    return isinstance(obj, dict) and ("conversationFlow" in obj or ("nodes" in obj and "start_node_id" in obj))


def convert(export: dict, company_name: str | None = None, brand: str | None = None) -> dict:
    flow = export.get("conversationFlow", export)
    raw_nodes = [n for n in flow.get("nodes", []) if _text(n) or n.get("type") == "end"]
    used: set[str] = set()
    ids = {}
    for n in raw_nodes:
        name = n.get("name") or "Step"
        if name.lower() in ("conversation", "end call", "step"):
            name = " ".join(_text(n).split()[:5]) or name
        ids[n["id"]] = _slug(name, used)

    def rebrand(s: str) -> str:
        if brand and company_name:
            s = re.sub(re.escape(brand), company_name, s, flags=re.I)
        return s

    nodes = []
    for n in raw_nodes:
        text = rebrand(_text(n))
        kind = "end" if n.get("type") == "end" else "transfer" if "transfer" in (n.get("type") or "") else "ai"
        nxt = []
        for e in n.get("edges", []):
            to = ids.get(e.get("destination_node_id"))
            cond = e.get("transition_condition") or {}
            when = cond.get("prompt") if isinstance(cond, dict) else str(cond)
            if to and when and when.strip() and when.strip() != "Describe the transition condition":
                if not any(x["to"] == to for x in nxt):
                    nxt.append({"to": to, "when": rebrand(when.strip())})
                else:  # merge alternative conditions that lead to the same step
                    for x in nxt:
                        if x["to"] == to:
                            x["when"] += " OR " + rebrand(when.strip())
        title = (n.get("name") if n.get("name") not in (None, "Conversation", "End Call") else None) or " ".join(text.split()[:6]).rstrip(".,") or "Step"
        nodes.append({"id": ids[n["id"]], "title": title[:60], "type": kind,
                      "instructions": text or "Politely end the call.", "collect": [], "next": nxt})
    for n in nodes:  # an AI step with no way out would trap the call
        if n["type"] == "ai" and not n["next"]:
            n["type"] = "end"
    start = ids.get(flow.get("start_node_id")) or (nodes[0]["id"] if nodes else None)
    return {"version": 1, "name": rebrand(export.get("agent_name") or "Imported flow"), "start": start,
            "imported_from": "retell", "global_prompt": rebrand(flow.get("global_prompt") or ""),
            "safety_rules": [], "nodes": nodes}
