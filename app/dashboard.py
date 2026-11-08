"""Oversiktssiden: et øyeblikksbilde på tvers av alle kildene."""

import time

from . import news
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


def summary(store: AISStore) -> dict:
    return {"tid": time.time(), "ais": ais_summary(store), "nyheter": news.dashboard(),
            "lager": entity_store.stats()}
