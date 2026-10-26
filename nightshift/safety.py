"""Guards that run in plain code around the model (they do not trust the model to behave)."""

from __future__ import annotations

import re

from . import db
from .config import business, settings

MAX_CALLER_CHARS = 600

INJECTION_PATTERNS = [
    r"ignore (all |any |the |your )?(previous|prior|above|earlier) (instructions|rules|prompts?)",
    r"(disregard|forget) (all |your |the )?(instructions|rules)",
    r"system prompt", r"developer mode", r"jailbreak",
    r"you are now", r"act as (an? )?(admin|administrator|developer|system)",
    r"(i am|this is) (the )?(system )?(administrator|admin|developer|it department|openai)",
    r"(other|previous|all|every)( \w+)? (customers?|callers?)('s)? (names?|numbers?|addresses|info|information|details)",
    r"(everyone|anyone|people) who called",
    r"(home address|phone number|schedule) of (your|the) (tech|technician|staff|employee)",
    r"(tech|technician|employee)s?'?s? (home address|personal (phone|number))",
    r"(reveal|print|show me|read me) (your|the) (instructions|prompt|rules)",
]

PHONE_RE = re.compile(r"\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b")


def digits(s: str | None) -> str:
    return re.sub(r"\D", "", s or "")[-10:]


def emergency_rule(text: str, tree: dict) -> dict | None:
    """Keyword safety net: if a caller mentions gas, CO, sparks... force the emergency step."""
    low = text.lower().replace("’", "'")
    for rule in tree.get("safety_rules", []):
        for kw in rule["keywords"]:
            for m in re.finditer(r"(?<![a-z])" + re.escape(kw.lower()) + r"(e?s)?(?![a-z])", low):
                if not is_negated(low, m.start()) and not is_calm_after(low, m.end()):
                    return {"rule": rule["id"], "label": rule["label"], "keyword": kw, "goto": rule["goto"]}
    return None


NEGATORS = r"\b(no|not|don't|dont|doesn't|doesnt|isn't|there's no|without|never|nothing|none|neither|nor)\b"


CALM_AFTER = r"^\W*(is|are|was|has been|seems|'s)?\s*(quiet|silent|fine|normal|okay|ok|off|not (going off|sounding|beeping|on)|isn't|is not|hasn't|has not|didn't|did not)\b"


def is_calm_after(low: str, end: int) -> bool:
    """'the CO alarm is quiet' / 'CO alarm isn't going off' -> calm. 'the CO alarm is going off' -> danger."""
    return re.search(CALM_AFTER, low[end:end + 30]) is not None


def is_negated(low: str, pos: int) -> bool:
    """'no burning smell, smoke, or sparks' -> sparks is negated. 'no smoke but now sparks' -> not negated."""
    clause = re.split(r"[.?!;]|\bbut\b|\bhowever\b|\bexcept\b|\bnow\b", low[max(0, pos - 80):pos])[-1]
    return re.search(NEGATORS, clause) is not None


def injection_check(text: str) -> list[str]:
    hits = []
    for p in INJECTION_PATTERNS:
        m = re.search(p, text, flags=re.I)
        if m:
            hits.append(m.group(0))
    return hits


def clean_caller_text(text: str) -> tuple[str, bool]:
    text = (text or "").replace("\x00", "").strip()
    if len(text) > MAX_CALLER_CHARS:
        return text[:MAX_CALLER_CHARS], True
    return text, False


def allowed_numbers(call: dict) -> set[str]:
    b = business()
    nums = {digits(call.get("caller_id")), digits((call.get("notes") or {}).get("callback_number")), digits(b["office_phone"])}
    nums |= {digits(v["phone"]) for v in b["on_call"].values()}
    nums.add(digits(settings().get("forward_number")))
    return {n for n in nums if n}


def redact_reply(reply: str, call: dict) -> tuple[str, list[str]]:
    """Strip any phone number or private detail the caller did not give us themselves."""
    leaked = []
    ok = allowed_numbers(call)

    def sub(m):
        if digits(m.group(0)) in ok:
            return m.group(0)
        leaked.append(m.group(0))
        return "[removed]"

    reply = PHONE_RE.sub(sub, reply)
    # Other callers' street addresses: private unless THIS caller said it themselves.
    own = norm_addr(" ".join([(call.get("notes") or {}).get("service_address") or ""] +
                             [m["text"] for m in call.get("transcript", []) if m["role"] == "caller"]))
    for other in db.query("SELECT id, notes FROM calls WHERE id<>?", (call["id"],)):
        addr = (other.get("notes") or {}).get("service_address")
        if not addr or len(addr) < 6 or norm_addr(addr) in own:
            continue
        pattern = addr_regex(addr)
        if re.search(pattern, reply, flags=re.I):
            leaked.append(addr)
            reply = re.sub(pattern, "[removed]", reply, flags=re.I)
    return reply, leaked


ABBR = {"st": "street", "ave": "avenue", "av": "avenue", "rd": "road", "dr": "drive", "ln": "lane", "blvd": "boulevard", "ct": "court", "hwy": "highway"}


def norm_addr(s: str) -> str:
    words = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split()
    return " ".join(ABBR.get(w, w) for w in words)


def addr_regex(addr: str) -> str:
    """Match '48 Dixwell Ave', '48 Dixwell Avenue', '48 dixwell ave.' alike."""
    parts = []
    for w in norm_addr(addr).split():
        alts = [w] + [k for k, v in ABBR.items() if v == w]
        parts.append("(?:" + "|".join(re.escape(a) for a in alts) + r")\.?")
    return r"\b" + r"[\s,]+".join(parts) + r"\b"


def budget_status(call_id: int) -> dict:
    s = settings()
    spent_call = db.usage_for_call(call_id)["cost_usd"]
    return {
        "call_spent": spent_call, "call_cap": s["per_call_budget_usd"],
        "over": spent_call >= s["per_call_budget_usd"],
    }
