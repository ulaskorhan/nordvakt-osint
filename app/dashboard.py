"""Oversiktssiden: et øyeblikksbilde på tvers av alle kildene."""

import re
import time

from . import brreg, news, provenance
from . import store as entity_store
from .ais import AISStore, WATCH_FLAGS, haversine_km

# MMSI-er som ikke er skip (fyr, bøyer, kyststasjoner) holdes utenfor fartøystallene
NOT_VESSELS = {"Navigasjonsinnretning", "Kyststasjon", "SAR-luftfartøy", "Nødsender"}


def _count(items) -> list[dict]:
    out: dict[str, int] = {}
    for i in items:
        out[i] = out.get(i, 0) + 1
    return sorted(({"navn": k, "antall": n} for k, n in out.items()), key=lambda x: -x["antall"])


def ais_summary(store: AISStore) -> dict:
    ships = [v for v in store.vessels.values() if v["lat"] is not None and v["flagg"] not in NOT_VESSELS]
    flags = _count(v["flagg"] for v in ships)
    soner = []
    for z in store.zones:
        inne = naer = utenlandske = 0
        for v in ships:
            d = haversine_km(v["lat"], v["lon"], z["lat"], z["lon"])
            if d <= z["radius_km"] * 2:
                naer += 1
                inne += d <= z["radius_km"]
                utenlandske += v["flagg"] != "Norge"
        soner.append({"id": z["id"], "navn": z["navn"], "kategori": z["kategori"],
                      "inne": inne, "naer": naer, "utenlandske": utenlandske})
    day_ago = time.time() - 86400
    alerts = [a for a in store.alerts if a["tid"] > day_ago]
    return {
        "tilkoblet": store.connected,
        "fartoy": len(ships),
        "utenlandske": sum(v["flagg"] != "Norge" for v in ships),
        "overvaket_flagg": sum(v["flagg"] in WATCH_FLAGS for v in ships),
        "i_bevegelse": sum((v["fart"] or 0) >= 1 for v in ships),
        "flagg": flags[:12],
        "antall_flagg": len(flags),
        "kategorier": _count(v["kategori"] for v in ships),
        "soner": sorted(soner, key=lambda s: -s["naer"]),
        "varsler_24": {"høy": sum(a["niva"] == "høy" for a in alerts),
                       "middels": sum(a["niva"] == "middels" for a in alerts)},
        "siste_varsler": alerts[:8],
        "posisjoner": [[v["lat"], v["lon"], v["mmsi"], v["flagg"] != "Norge"] for v in ships],
    }


# Navn i nyhetene som svarer til en annen flaggstat i AIS
FLAG_ALIAS = {"England": "Storbritannia", "Skottland": "Storbritannia"}

_org_cache: dict[str, tuple[float, dict | None]] = {}
ORG_TTL = 6 * 3600


def _norm(name: str) -> str:
    return re.sub(r"\s+(asa|as|sa|sf|hf|rhf|kf|iks)$", "", name.strip().lower())


async def org_facts(name: str) -> dict | None:
    """Slår opp en organisasjon fra nyhetene i Enhetsregisteret. Bare entydige navnetreff
    tas med: heller ingen kobling enn en feil kobling."""
    hit = _org_cache.get(name)
    if hit and time.time() - hit[0] < ORG_TTL:
        return hit[1]
    fact = None
    try:
        same = [e for e in await brreg.search(name)
                if _norm(e["navn"] or "") == _norm(name) and not e["slettet"]]
        if len(same) == 1:
            e = same[0]
            fact = {k: e[k] for k in ("orgnr", "navn", "form", "naering", "kommune", "ansatte")}
    except Exception:
        return None  # nettverksfeil mellomlagres ikke
    _org_cache[name] = (time.time(), fact)
    return fact


async def relations(store: AISStore) -> dict:
    """Nyheter koblet mot Enhetsregisteret (organisasjoner) og AIS (flaggstater)."""
    rel = news.relations()
    for o in rel["topp_organisasjoner"]:
        o["brreg"] = await org_facts(o["navn"])
    flags: dict[str, int] = {}
    for v in store.vessels.values():
        if v["lat"] is not None and v["flagg"] not in NOT_VESSELS:
            flags[v["flagg"]] = flags.get(v["flagg"], 0) + 1
    for land in rel["land"]:
        flagg = FLAG_ALIAS.get(land["navn"], land["navn"])
        land["fartoy"] = flags.get(flagg, 0)
        land["overvaket"] = flagg in WATCH_FLAGS
    return rel


async def summary(store: AISStore) -> dict:
    return {"tid": time.time(), "ais": ais_summary(store), "nyheter": news.dashboard(),
            "sammenhenger": await relations(store), "nyhetssteder": news.place_points(),
            "kildelogg": provenance.summary(), "lager": entity_store.stats()}
