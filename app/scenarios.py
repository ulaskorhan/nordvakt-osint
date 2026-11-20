"""Scenariokort: historiske paralleller og indikatorer som følges i nyhetene.

Kortene i data/scenarier.json er skrevet for hånd, med kilde for hver historiske
parallell. Det eneste som beregnes her, er hvor ofte hver indikator dukker opp i
nyhetene de siste to ukene, sammenlignet med de fire ukene før. Nordvakt sier
ikke hvilket scenario som er mest sannsynlig; siden viser bare hvilke tegn som synes.
"""

import json
import re
import time
from pathlib import Path

from . import news

CONFIG = json.loads((Path(__file__).resolve().parent.parent / "data" / "scenarier.json").read_text(encoding="utf-8"))
DAYS = CONFIG["dager"]
BASE_DAYS = CONFIG["grunnlag_dager"]
STORIES = 6


def _compile(card: dict) -> dict:
    return {
        "ctx": re.compile(card["kontekst"], re.IGNORECASE),
        "ind": {(s["id"], i["navn"]): re.compile(i["mønster"], re.IGNORECASE)
                for s in card["scenarier"] for i in s["indikatorer"]},
    }


PATTERNS = {c["id"]: _compile(c) for c in CONFIG["kort"]}


def _articles(since: float) -> list[dict]:
    with news._lock:
        rows = news._db.execute(
            "SELECT tittel, lenke, kilde, publisert, sammendrag FROM artikler WHERE publisert > ? ORDER BY publisert DESC",
            (since,),
        ).fetchall()
    seen, out = set(), []
    for tittel, lenke, kilde, pub, sammendrag in rows:
        key = tittel.strip().lower()
        if key in seen:
            continue
        seen.add(key)
        out.append({"tittel": tittel, "lenke": lenke, "kilde": kilde, "publisert": pub, "tekst": f"{tittel} {sammendrag}"})
    return out


def _story(a: dict) -> dict:
    return {k: a[k] for k in ("tittel", "lenke", "kilde", "publisert")}


def summary() -> dict:
    now = time.time()
    cut = now - DAYS * 86400
    arts = _articles(cut - BASE_DAYS * 86400)
    recent = [a for a in arts if a["publisert"] > cut]
    base = [a for a in arts if a["publisert"] <= cut]
    # Grunnlaget brukes bare når arkivet faktisk dekker de fire ukene før
    base_ok = len(base) >= 0.5 * len(recent) * BASE_DAYS / DAYS
    scale = DAYS / BASE_DAYS

    cards = []
    for card in CONFIG["kort"]:
        pat = PATTERNS[card["id"]]
        ctx_recent = [a for a in recent if pat["ctx"].search(a["tekst"])]
        ctx_base = [a for a in base if pat["ctx"].search(a["tekst"])]
        scen = []
        for s in card["scenarier"]:
            hits_all: dict[str, dict] = {}
            inds = []
            for ind in s["indikatorer"]:
                rx = pat["ind"][(s["id"], ind["navn"])]
                hits = [a for a in ctx_recent if rx.search(a["tekst"])]
                n_base = sum(1 for a in ctx_base if rx.search(a["tekst"]))
                expected = n_base * scale if base_ok else None
                for a in hits:
                    hits_all.setdefault(a["lenke"], {**_story(a), "tegn": []})["tegn"].append(ind["navn"])
                inds.append({
                    "navn": ind["navn"], "antall": len(hits),
                    "vanlig": round(expected, 1) if expected is not None else None,
                    "økning": expected is not None and len(hits) >= 3 and len(hits) >= 1.5 * max(expected, 1),
                })
            stories = sorted(hits_all.values(), key=lambda x: -x["publisert"])
            scen.append({"id": s["id"], "navn": s["navn"], "tekst": s["tekst"], "indikatorer": inds,
                         "antall": len(stories), "saker": stories[:STORIES]})
        cards.append({
            "id": card["id"], "tittel": card["tittel"], "spørsmål": card["spørsmål"],
            "paralleller": card["paralleller"], "scenarier": scen,
            "kontekst": {"antall": len(ctx_recent), "saker": [_story(a) for a in ctx_recent[:3]]},
        })
    return {"tid": now, "dager": DAYS, "grunnlag_dager": BASE_DAYS, "grunnlag": base_ok,
            "saker": len(recent), "kort": cards}
