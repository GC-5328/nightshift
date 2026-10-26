"""Paths, .env loading, model client, pricing and editable settings."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
# NIGHTSHIFT_RUNTIME lets the eval scripts use a separate database and leave the demo data alone.
RUNTIME = Path(os.getenv("NIGHTSHIFT_RUNTIME", ROOT / "runtime"))
RUNTIME.mkdir(exist_ok=True)

# Look for .env in the repo folder first, then the folder above it (where the
# teaching staff keep theirs), then further up. Nearest file wins.
for folder in [ROOT, *ROOT.parents]:
    if (folder / ".env").exists():
        load_dotenv(folder / ".env", override=False)

MODEL = os.getenv("MODEL_NAME", "gpt-6-luna")
PORTKEY_BASE_URL = os.getenv("PORTKEY_BASE_URL", "https://api.portkey.ai/v1").rstrip("/")

# USD per 1M tokens (course pricing sheet, Lecture 11). Cached input tokens are
# included in input_tokens and billed at the cached rate instead.
PRICES = {"gpt-6-luna": {"input": 0.10, "cached_input": 0.01, "output": 0.50}}


def cost_usd(input_tokens: int, cached_tokens: int, output_tokens: int, model: str = MODEL) -> float:
    p = PRICES.get(model, PRICES["gpt-6-luna"])
    cached = min(cached_tokens, input_tokens)
    return ((input_tokens - cached) * p["input"] + cached * p["cached_input"] + output_tokens * p["output"]) / 1_000_000


@lru_cache(maxsize=1)
def client():
    from openai import OpenAI

    portkey = os.getenv("PORTKEY_API_KEY", "").strip()
    if portkey:
        return OpenAI(api_key=portkey, base_url=PORTKEY_BASE_URL, default_headers={"x-portkey-provider": "openai"})
    openai_key = os.getenv("OPENAI_API_KEY", "").strip()
    if openai_key:
        return OpenAI(api_key=openai_key)
    raise RuntimeError("No API key found. Put PORTKEY_API_KEY in a .env file in this folder or the folder above it.")


def key_status() -> dict:
    return {
        "portkey": bool(os.getenv("PORTKEY_API_KEY", "").strip()),
        "openai": bool(os.getenv("OPENAI_API_KEY", "").strip()),
    }


def load_json(name: str):
    """Runtime override (edited in the app) wins over the shipped default in data/."""
    override = RUNTIME / name
    path = override if override.exists() else DATA / name
    return json.loads(path.read_text(encoding="utf-8"))


def save_runtime_json(name: str, obj) -> None:
    (RUNTIME / name).write_text(json.dumps(obj, indent=2), encoding="utf-8")


def reset_runtime_json(name: str) -> None:
    (RUNTIME / name).unlink(missing_ok=True)


def business() -> dict:
    return load_json("business.json")


def technicians() -> list[dict]:
    return load_json("technicians.json")


def note_fields() -> list[dict]:
    return load_json("note_fields.json")


def settings() -> dict:
    defaults = json.loads((DATA / "default_settings.json").read_text(encoding="utf-8"))
    path = RUNTIME / "settings.json"
    if path.exists():
        defaults.update(json.loads(path.read_text(encoding="utf-8")))
    return defaults


def save_settings(new: dict) -> dict:
    """Only values that differ from data/default_settings.json are stored."""
    defaults = json.loads((DATA / "default_settings.json").read_text(encoding="utf-8"))
    merged = settings()
    merged.update({k: v for k, v in new.items() if k in defaults})
    save_runtime_json("settings.json", {k: v for k, v in merged.items() if defaults.get(k) != v})
    return merged
