# Development log (measurements for the report)

## v1 — every action is a tool call (2026-10-25)
Scenario `no_heat_elderly`, simulated caller, reasoning effort `low`.
- 9 caller turns, **26 model requests** for the call agent + 1 summarizer request
- Tokens: 110,311 input (98,485 cached = 89%), 2,478 output, 294 reasoning
- Cost: **$0.0034 per call**
- Latency: 2.0 s average per request, but **3.3–7.4 s per caller turn** (update_notes → go_to_step → reply were separate round trips)
- Outcome: correct (urgent HVAC, Hamden, held tomorrow 8–11 AM, manager texted)

Problem: too slow for a phone conversation. → v2 merges notes, step move and the spoken reply into one structured output per turn; only the schedule lookup stays a tool.
