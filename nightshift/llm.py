"""One wrapper around the Responses API: every request is timed, priced and logged."""

from __future__ import annotations

import time

from . import db
from .config import MODEL, client, cost_usd


class BudgetExceeded(Exception):
    pass


def usage_dict(resp, latency_ms: int) -> dict:
    u = resp.usage
    inp = u.input_tokens or 0
    cached = getattr(getattr(u, "input_tokens_details", None), "cached_tokens", 0) or 0
    out = u.output_tokens or 0
    reasoning = getattr(getattr(u, "output_tokens_details", None), "reasoning_tokens", 0) or 0
    return {"input_tokens": inp, "cached_tokens": cached, "output_tokens": out, "reasoning_tokens": reasoning,
            "cost_usd": cost_usd(inp, cached, out), "latency_ms": latency_ms}


def respond(*, agent: str, instructions: str, input, tools=None, text_format=None, effort: str = "low",
            call_id: int | None = None, report_id: int | None = None, simulated: bool = False,
            cache_key: str | None = None, max_output_tokens: int | None = None):
    """Returns (response, usage). Logs usage to the ledger."""
    kwargs = {"model": MODEL, "instructions": instructions, "input": input, "reasoning": {"effort": effort}}
    if tools:
        kwargs["tools"] = tools
        kwargs["parallel_tool_calls"] = True
    if text_format:
        kwargs["text"] = {"format": text_format}
    if cache_key:
        kwargs["prompt_cache_key"] = cache_key
    if max_output_tokens:
        kwargs["max_output_tokens"] = max_output_tokens
    t0 = time.perf_counter()
    raw = client().responses.with_raw_response.create(**kwargs)
    resp = raw.parse()
    u = usage_dict(resp, round((time.perf_counter() - t0) * 1000))
    # Portkey can answer repeated identical requests from its own cache; record it so
    # latency numbers in the report are not flattered by gateway cache hits.
    u["gateway_cache"] = raw.headers.get("x-portkey-cache-status", "")
    db.log_usage(agent, u, call_id=call_id, report_id=report_id, simulated=simulated)
    return resp, u
