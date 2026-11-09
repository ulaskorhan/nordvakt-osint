"""Lager et øyeblikksbilde av oversikten til den statiske versjonen på GitHub Pages.

Henter AIS, henter og analyserer nyhetene, og skriver samme JSON som /api/dashboard
til site/data/. AIS hentes fra BarentsWatch når BARENTSWATCH_CLIENT_ID og
BARENTSWATCH_CLIENT_SECRET er satt, ellers ved å lytte på Kystverkets TCP-strøm.

    python -m scripts.snapshot --ais-sekunder 240
"""

import argparse
import asyncio
import json
import logging
from pathlib import Path

from app import ais, barentswatch, dashboard, news

ROOT = Path(__file__).resolve().parent.parent


async def collect(seconds: int) -> tuple[ais.AISStore, str]:
    """AIS og nyheter hentes samtidig. TCP-strømmen lyttes på i minst `seconds` sekunder."""
    store = ais.AISStore(ais.load_zones())
    creds = barentswatch.credentials()
    if creds:
        _, result = await asyncio.gather(news.fetch_all(), barentswatch.load_latest(store, *creds),
                                         return_exceptions=True)
        if isinstance(result, Exception):
            logging.error("BarentsWatch feilet: %s", result)
        return store, "BarentsWatch"
    task = asyncio.create_task(ais.run(store))
    try:
        await asyncio.gather(news.fetch_all(), asyncio.sleep(seconds))
    finally:
        task.cancel()
    store.connected = store.messages > 0
    return store, "Kystverket TCP"


async def main(seconds: int, out: Path) -> None:
    store, source = await collect(seconds)
    data = dashboard.summary(store)
    data["øyeblikksbilde"] = {"ais_sekunder": seconds, "meldinger": store.messages,
                              "ais_tilgjengelig": store.messages > 0, "ais_kilde": source}
    out.mkdir(parents=True, exist_ok=True)
    (out / "dashboard.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    (out / "zones.json").write_text(json.dumps(store.zones, ensure_ascii=False), encoding="utf-8")
    logging.info("Øyeblikksbilde: %d fartøy, %d AIS-meldinger, %d saker siste døgn",
                 data["ais"]["fartoy"], store.messages, data["nyheter"]["siste_24"])


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser()
    parser.add_argument("--ais-sekunder", type=int, default=240)
    parser.add_argument("--ut", type=Path, default=ROOT / "site" / "data")
    args = parser.parse_args()
    asyncio.run(main(args.ais_sekunder, args.ut))
