"""Capture report screenshots of the running app (python app.py must be running on :5050).

  python scripts/screenshots.py [--only overview live ...] [--out ../report/assets]

Uses the locally installed Google Chrome through Playwright (no browser download).
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:5050"
ROOT = Path(__file__).resolve().parents[1]


def api(path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"}, method="POST" if body is not None else "GET")
    return json.loads(urllib.request.urlopen(req).read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--out", default=str(ROOT.parent / "report" / "assets"))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    want = lambda k: not args.only or k in args.only  # noqa: E731

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1.5)
        pg.goto(BASE)
        pg.wait_for_timeout(2000)

        def nav(page):
            pg.evaluate(f"show('{page}')")
            pg.wait_for_timeout(1500)

        def shot(name, full=False, el=None):
            path = out / f"{name}.jpg"
            if el:
                pg.locator(el).screenshot(path=str(path), type="jpeg", quality=82)
            else:
                pg.screenshot(path=str(path), full_page=full, type="jpeg", quality=82)
            print("saved", path.name)

        if want("overview"):
            nav("overview")
            pg.evaluate("LOADERS.overview('last_night')"); pg.wait_for_timeout(1500)
            shot("overview_last_night")
            pg.evaluate("LOADERS.overview('tonight')"); pg.wait_for_timeout(1500)
            pg.evaluate("document.querySelector('#ov-pipeline').scrollIntoView({block:'center'})"); pg.wait_for_timeout(400)
            shot("action_strip", el="#ov-pipeline")
            pg.evaluate("openActions('visit')"); pg.wait_for_timeout(1500)
            shot("action_items", el="#drawer")
            pg.evaluate("closeDrawer()")

        if want("calls"):
            nav("calls"); shot("calls_history")
            pg.evaluate("document.querySelector('#calls-tabs [data-tab=analysis]').click()"); pg.wait_for_timeout(2000)
            shot("calls_analysis", full=True)

        if want("drawers"):
            calls = api("/api/calls")
            pick = {
                "call_emergency": next((c for c in calls if c["category"] == "emergency"), None),
                "call_attack": next((c for c in calls if c["category"] in ("spam",) or (c.get("one_line") or "").lower().find("manipul") >= 0), None),
                "call_service": next((c for c in calls if c["category"] == "service_request" and c.get("held_window")), None),
            }
            for name, c in pick.items():
                if not c:
                    continue
                pg.evaluate(f"openCall({c['id']})"); pg.wait_for_timeout(1500)
                pg.evaluate("document.querySelector('#drawer').style.transition='none'")
                shot(name, el="#drawer")
                pg.evaluate("document.querySelector('#drawer').scrollTop = document.querySelector('#drawer .timeline').offsetTop - 80"); pg.wait_for_timeout(400)
                shot(name + "_trace", el="#drawer")
                pg.evaluate("closeDrawer()"); pg.wait_for_timeout(300)

        if want("report"):
            nav("report"); pg.wait_for_timeout(1500)
            pg.evaluate("S.night='2026-10-26'; renderNights(); showNight(S.night)"); pg.wait_for_timeout(1500)
            shot("morning_report", full=True)

        if want("schedule"):
            nav("team"); shot("schedule_week")
            pg.evaluate("S.cal.view='month'; LOADERS.team()"); pg.wait_for_timeout(1200); shot("schedule_month")
            pg.evaluate("S.cal.view='week'; LOADERS.team()")

        if want("agent"):
            nav("agent"); pg.wait_for_timeout(1500)
            pg.evaluate("selectNode('find_window')"); pg.wait_for_timeout(500)
            shot("agent_map")
            pg.evaluate("document.querySelector('#agent-tabs [data-tab=settings]').click()"); pg.wait_for_timeout(800)
            shot("agent_settings", full=True)
            pg.evaluate("document.querySelector('#agent-tabs [data-tab=kb]').click()"); pg.wait_for_timeout(800); shot("agent_kb")
            pg.evaluate("document.querySelector('#agent-tabs [data-tab=model]').click()"); pg.wait_for_timeout(800); shot("agent_model")
            pg.evaluate("document.querySelector('#agent-tabs [data-tab=map]').click()")

        if want("live"):
            api("/api/simulate", {"n": 3, "pace": "realistic", "spread_s": 0, "mode": "invent"})
            nav("test"); pg.wait_for_timeout(15000)
            shot("test_page", full=True)
            nav("live"); pg.wait_for_timeout(12000)
            first = pg.evaluate("(document.querySelector('#live-board .lcard')||{}).dataset?.id")
            if first:
                pg.evaluate(f"document.querySelector('#ls-audio') ; startListening({first})"); pg.wait_for_timeout(1000)
                pg.evaluate("document.querySelector('#ls-audio') && (document.querySelector('#ls-audio').checked=false)")
                pg.wait_for_timeout(14000)
            shot("live_monitor")
        b.close()


if __name__ == "__main__":
    main()
