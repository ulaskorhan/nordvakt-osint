"""AIS fra BarentsWatch (Kystverket) over HTTPS, som alternativ til TCP-strømmen.

Kystverkets åpne TCP-strøm svarer ikke fra alle nett, blant annet ikke fra GitHub
Actions. BarentsWatch sitt AIS-API gir siste kjente posisjon for alle fartøy i ett
kall, men krever en gratis API-klient (client credentials med scope «ais»):
https://www.barentswatch.no/minside/

Miljøvariabler: BARENTSWATCH_CLIENT_ID og BARENTSWATCH_CLIENT_SECRET.
"""

import logging
import os
import time
from datetime import datetime

import httpx

from . import provenance
from .ais import STALE_AFTER, AISStore

log = logging.getLogger("nordvakt.barentswatch")

TOKEN_URL = "https://id.barentswatch.no/connect/token"
LATEST_URL = "https://live.ais.barentswatch.no/v1/latest/combined"


def credentials() -> tuple[str, str] | None:
    cid, secret = os.environ.get("BARENTSWATCH_CLIENT_ID"), os.environ.get("BARENTSWATCH_CLIENT_SECRET")
    return (cid, secret) if cid and secret else None


def _epoch(value) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def to_messages(rec: dict) -> list[dict]:
    """Gjør én BarentsWatch-post om til samme form som pyais gir, så AISStore kan ta imot den."""
    mmsi = rec.get("mmsi")
    if not mmsi:
        return []
    pos = {
        "msg_type": 1, "mmsi": int(mmsi), "lat": rec.get("latitude"), "lon": rec.get("longitude"),
        "speed": rec.get("speedOverGround"), "course": rec.get("courseOverGround"),
        "heading": rec.get("trueHeading"),
    }
    static = {
        "msg_type": 5, "mmsi": int(mmsi), "shipname": rec.get("name") or "",
        "callsign": rec.get("callSign") or "", "ship_type": rec.get("shipType"),
        "destination": rec.get("destination") or "",
    }
    return [pos, static]


async def load_latest(store: AISStore, client_id: str, secret: str) -> int:
    """Henter siste posisjon for alle fartøy og legger dem i store. Returnerer antall poster brukt."""
    async with httpx.AsyncClient(timeout=60, headers={"User-Agent": "Nordvakt/0.1 (OSINT-prosjekt)"}) as client:
        tok = await client.post(TOKEN_URL, data={
            "client_id": client_id, "client_secret": secret, "scope": "ais", "grant_type": "client_credentials",
        })
        tok.raise_for_status()
        token = tok.json()["access_token"]
        resp = await client.get(LATEST_URL, headers={"Authorization": f"Bearer {token}"})
        provenance.log("BarentsWatch AIS", LATEST_URL, resp.status_code, resp.content)
        resp.raise_for_status()
        records = resp.json()

    cutoff = time.time() - STALE_AFTER
    used = 0
    for rec in records:
        seen = _epoch(rec.get("msgtime"))
        if seen is not None and seen < cutoff:
            continue
        for msg in to_messages(rec):
            store.ingest(msg)
        used += 1
    store.connected = used > 0
    log.info("BarentsWatch: %d poster, %d brukt", len(records), used)
    return used
