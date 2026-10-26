"""Load, validate and save the editable conversation tree."""

from __future__ import annotations

import re

from .config import load_json, note_fields, reset_runtime_json, save_runtime_json

NODE_TYPES = {"ai", "transfer", "end"}
KNOWN_ACTIONS = {"check_availability", "hold_window", "transfer_call", "end_call"}


def load_tree() -> dict:
    return load_json("call_tree.json")


def node_map() -> dict:
    return {n["id"]: n for n in load_tree()["nodes"]}


def validate(tree: dict) -> list[str]:
    errors = []
    nodes = tree.get("nodes") or []
    ids = [n.get("id") for n in nodes]
    if not nodes:
        return ["The tree has no steps."]
    for i in ids:
        if not i or not re.fullmatch(r"[a-z0-9_]{2,40}", i or ""):
            errors.append(f"Step id '{i}' must be 2-40 lowercase letters, digits or _.")
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        errors.append(f"Duplicate step ids: {sorted(dupes)}")
    if tree.get("start") not in ids:
        errors.append(f"Start step '{tree.get('start')}' does not exist.")
    fields = {f["key"] for f in note_fields()}
    for n in nodes:
        if n.get("type") not in NODE_TYPES:
            errors.append(f"[{n.get('id')}] type must be one of {sorted(NODE_TYPES)}.")
        if not (n.get("instructions") or "").strip():
            errors.append(f"[{n.get('id')}] needs instructions.")
        for e in n.get("next", []):
            if e.get("to") not in ids:
                errors.append(f"[{n.get('id')}] arrow points to missing step '{e.get('to')}'.")
            if not (e.get("when") or "").strip():
                errors.append(f"[{n.get('id')}] arrow to '{e.get('to')}' needs a 'when' condition.")
        for c in n.get("collect", []):
            if c not in fields:
                errors.append(f"[{n.get('id')}] collects unknown note field '{c}'.")
        for a in n.get("actions", []):
            if a not in KNOWN_ACTIONS:
                errors.append(f"[{n.get('id')}] unknown action '{a}'.")
        if n.get("type") == "ai" and not n.get("next"):
            errors.append(f"[{n.get('id')}] is a dead end: add an arrow or make it an 'end' step.")
    for r in tree.get("safety_rules", []):
        if r.get("goto") not in ids:
            errors.append(f"Safety rule '{r.get('id')}' points to missing step '{r.get('goto')}'.")
    # every step reachable from start
    if tree.get("start") in ids:
        seen, stack = set(), [tree["start"]]
        edges = {n["id"]: [e["to"] for e in n.get("next", [])] for n in nodes if n.get("id")}
        for r in tree.get("safety_rules", []):
            stack.append(r.get("goto"))
        while stack:
            cur = stack.pop()
            if cur in seen or cur not in edges:
                continue
            seen.add(cur)
            stack += edges[cur]
        unreachable = [i for i in ids if i not in seen]
        if unreachable:
            errors.append(f"Unreachable steps: {unreachable}")
    return errors


def save_tree(tree: dict) -> list[str]:
    errors = validate(tree)
    if not errors:
        save_runtime_json("call_tree.json", tree)
    return errors


def reset_tree() -> None:
    reset_runtime_json("call_tree.json")
