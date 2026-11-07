"""Sanntids AIS fra Kystverkets åpne strøm (NLOD-lisens).

Strømmen er rå NMEA over TCP med en tag block foran hver setning, f.eks.
    \\s:2573104,c:1794043100*07\\!BSVDM,1,1,,B,13m8:l0P11Q6el@VWuR=@?v`20Sw,0*27
Meldinger som går over flere setninger settes sammen før dekoding.
"""

import asyncio
import json
import logging
import math
import time
from collections import deque
from pathlib import Path

from pyais import decode

log = logging.getLogger("nordvakt.ais")

AIS_HOST = "153.44.253.27"
AIS_PORT = 5631
STALE_AFTER = 30 * 60  # fartøy som ikke er hørt fra på 30 min fjernes
LOITER_SOG = 1.5  # knop
LOITER_MINUTES = 20

# Maritime Identification Digits: de tre første sifrene i MMSI angir flaggstat
MID = {
    "257": "Norge", "258": "Norge", "259": "Norge",
    "273": "Russland",
    "265": "Sverige", "266": "Sverige",
    "219": "Danmark", "220": "Danmark", "231": "Færøyene",
    "230": "Finland", "251": "Island", "250": "Irland",
    "211": "Tyskland", "218": "Tyskland",
    "232": "Storbritannia", "233": "Storbritannia", "234": "Storbritannia", "235": "Storbritannia",
    "244": "Nederland", "245": "Nederland", "246": "Nederland",
    "205": "Belgia", "226": "Frankrike", "227": "Frankrike", "228": "Frankrike",
    "224": "Spania", "225": "Spania", "247": "Italia", "263": "Portugal",
    "261": "Polen", "275": "Latvia", "276": "Estland", "277": "Litauen",
    "209": "Kypros", "210": "Kypros", "212": "Kypros", "215": "Malta", "229": "Malta",
    "248": "Malta", "249": "Malta", "256": "Malta",
    "237": "Hellas", "239": "Hellas", "240": "Hellas", "241": "Hellas",
    "271": "Tyrkia", "272": "Ukraina",
    "304": "Antigua og Barbuda", "305": "Antigua og Barbuda",
    "308": "Bahamas", "309": "Bahamas", "311": "Bahamas",
    "338": "USA", "366": "USA", "367": "USA", "368": "USA", "369": "USA",
    "351": "Panama", "352": "Panama", "353": "Panama", "354": "Panama", "355": "Panama",
    "356": "Panama", "357": "Panama", "370": "Panama", "371": "Panama", "372": "Panama",
    "373": "Panama", "374": "Panama",
    "412": "Kina", "413": "Kina", "414": "Kina", "477": "Hongkong",
    "422": "Iran", "440": "Sør-Korea", "441": "Sør-Korea", "431": "Japan", "432": "Japan",
    "445": "Nord-Korea", "457": "Mongolia",
    "538": "Marshalløyene", "511": "Palau",
    "563": "Singapore", "564": "Singapore", "565": "Singapore", "566": "Singapore",
    "572": "Tuvalu", "577": "Vanuatu",
    "613": "Kamerun", "620": "Komorene", "626": "Gabon", "636": "Liberia", "637": "Liberia",
    "667": "Sierra Leone", "677": "Tanzania",
    "312": "Belize", "314": "Barbados", "325": "Jamaica", "341": "St. Kitts og Nevis",
    "375": "St. Vincent", "376": "St. Vincent", "377": "St. Vincent",
}

# Flaggstater som utløser varsel ved innseiling i en sone. Juster etter behov.
WATCH_FLAGS = {"Russland", "Kamerun", "Gabon", "Komorene", "Sierra Leone", "Iran", "Nord-Korea"}


def flag_of(mmsi: int) -> str:
    s = str(mmsi).zfill(9)
    if s.startswith("99"):
        return "Navigasjonsinnretning"
    if s.startswith("00"):
        return "Kyststasjon"
    if s.startswith("111"):
        return "SAR-luftfartøy"
    if s.startswith("97"):
        return "Nødsender"
    return MID.get(s[:3], f"MID {s[:3]}")


def ship_category(t: int | None) -> str:
    if t is None:
        return "ukjent"
    if t == 30:
        return "fiske"
    if t in (31, 32, 52):
        return "slep"
    if t == 35:
        return "militær"
    if t in (36, 37):
        return "fritid"
    if 40 <= t <= 49:
        return "hurtigbåt"
    if t in (50, 51, 53, 54, 55, 58):
        return "tjeneste"
    if 60 <= t <= 69:
        return "passasjer"
    if 70 <= t <= 79:
        return "last"
    if 80 <= t <= 89:
        return "tank"
    return "annet"


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def load_zones() -> list[dict]:
    path = Path(__file__).resolve().parent.parent / "data" / "zones.json"
    return json.loads(path.read_text(encoding="utf-8"))["soner"]


class AISStore:
    def __init__(self, zones: list[dict]):
        self.zones = zones
        self.vessels: dict[int, dict] = {}
        self.alerts: deque[dict] = deque(maxlen=300)
        self.connected = False
        self.messages = 0
        self.errors = 0
        self.started = time.time()

    def _vessel(self, mmsi: int) -> dict:
        v = self.vessels.get(mmsi)
        if v is None:
            v = {
                "mmsi": mmsi, "navn": None, "kallesignal": None, "skipstype": None,
                "kategori": "ukjent", "destinasjon": None, "flagg": flag_of(mmsi),
                "lat": None, "lon": None, "fart": None, "kurs": None, "heading": None,
                "sist": None, "spor": deque(maxlen=60), "soner": {},
            }
            self.vessels[mmsi] = v
        return v

    def _alert(self, niva: str, regel: str, v: dict, zone: dict, tekst: str) -> None:
        self.alerts.appendleft({
            "tid": time.time(), "niva": niva, "regel": regel, "mmsi": v["mmsi"],
            "navn": v["navn"], "flagg": v["flagg"], "sone": zone["navn"], "tekst": tekst,
            "lat": v["lat"], "lon": v["lon"],
        })

    def _check_zones(self, v: dict, now: float) -> None:
        for z in self.zones:
            inside = haversine_km(v["lat"], v["lon"], z["lat"], z["lon"]) <= z["radius_km"]
            state = v["soner"].get(z["id"])
            if inside and state is None:
                v["soner"][z["id"]] = {"inn": now, "loiter_varslet": False}
                if v["flagg"] in WATCH_FLAGS:
                    self._alert("høy", "flagg_i_sone", v, z,
                                f"Fartøy med flagg {v['flagg']} inn i sonen")
            elif inside and state is not None:
                slow = v["fart"] is not None and v["fart"] < LOITER_SOG
                long_enough = now - state["inn"] >= LOITER_MINUTES * 60
                if slow and long_enough and not state["loiter_varslet"] and v["flagg"] != "Norge":
                    state["loiter_varslet"] = True
                    mins = int((now - state["inn"]) / 60)
                    self._alert("middels", "opphold", v, z,
                                f"Lav fart (< {LOITER_SOG} kn) i sonen i {mins} min")
            elif not inside and state is not None:
                del v["soner"][z["id"]]

    def ingest(self, msg: dict) -> None:
        self.messages += 1
        mmsi = msg.get("mmsi")
        if not mmsi:
            return
        t = msg.get("msg_type")
        now = time.time()

        if t in (1, 2, 3, 18, 19):
            lat, lon = msg.get("lat"), msg.get("lon")
            if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180 or (lat == 0 and lon == 0):
                return
            v = self._vessel(mmsi)
            v.update(lat=round(lat, 5), lon=round(lon, 5), sist=now)
            speed = msg.get("speed")
            v["fart"] = None if speed is None or speed >= 102.3 else speed
            course = msg.get("course")
            v["kurs"] = None if course is None or course >= 360 else course
            heading = msg.get("heading")
            v["heading"] = None if heading is None or heading == 511 else heading
            if not v["spor"] or (v["spor"][-1][0], v["spor"][-1][1]) != (v["lat"], v["lon"]):
                v["spor"].append((v["lat"], v["lon"], int(now)))
            if t == 19:
                self._static(v, msg)
            self._check_zones(v, now)
        elif t in (5, 24):
            self._static(self._vessel(mmsi), msg)

    def _static(self, v: dict, msg: dict) -> None:
        name = (msg.get("shipname") or "").strip(" @")
        if name:
            v["navn"] = name
        cs = (msg.get("callsign") or "").strip(" @")
        if cs:
            v["kallesignal"] = cs
        st = msg.get("ship_type")
        if st is not None:
            v["skipstype"] = int(st)
            v["kategori"] = ship_category(int(st))
        dest = (msg.get("destination") or "").strip(" @")
        if dest:
            v["destinasjon"] = dest

    def prune(self) -> None:
        cutoff = time.time() - STALE_AFTER
        for mmsi in [m for m, v in self.vessels.items() if v["sist"] and v["sist"] < cutoff]:
            del self.vessels[mmsi]

    def compact(self) -> list[dict]:
        return [
            {k: v[k] for k in ("mmsi", "navn", "lat", "lon", "fart", "kurs", "flagg", "kategori")}
            for v in self.vessels.values() if v["lat"] is not None
        ]

    def detail(self, mmsi: int) -> dict | None:
        v = self.vessels.get(mmsi)
        if v is None:
            return None
        out = {k: val for k, val in v.items() if k not in ("spor", "soner")}
        out["spor"] = list(v["spor"])
        out["i_soner"] = [z["navn"] for z in self.zones if z["id"] in v["soner"]]
        return out

    def status(self) -> dict:
        return {
            "tilkoblet": self.connected, "meldinger": self.messages, "feil": self.errors,
            "fartoy": len(self.vessels), "oppetid_s": int(time.time() - self.started),
        }


def _strip_tag_block(line: str) -> str | None:
    i = line.find("!")
    return line[i:] if i >= 0 else None


async def run(store: AISStore) -> None:
    """Leser strømmen for alltid og kobler til på nytt ved brudd."""
    while True:
        try:
            reader, writer = await asyncio.open_connection(AIS_HOST, AIS_PORT)
            store.connected = True
            log.info("Koblet til Kystverkets AIS-strøm")
            fragments: dict[tuple, list[str]] = {}
            last_prune = time.time()
            while True:
                raw = await asyncio.wait_for(reader.readline(), timeout=60)
                if not raw:
                    break
                sentence = _strip_tag_block(raw.decode("ascii", errors="ignore").strip())
                if not sentence:
                    continue
                parts = sentence.split(",")
                if len(parts) < 7:
                    continue
                try:
                    total, num = int(parts[1]), int(parts[2])
                    if total == 1:
                        msg = decode(sentence)
                    else:
                        key = (parts[3], parts[4])
                        fragments.setdefault(key, []).append(sentence)
                        if num < total:
                            continue
                        msg = decode(*fragments.pop(key))
                    store.ingest(msg.asdict())
                except Exception:
                    store.errors += 1
                if time.time() - last_prune > 60:
                    store.prune()
                    fragments.clear()
                    last_prune = time.time()
            writer.close()
        except Exception as exc:
            log.warning("AIS-forbindelse brutt: %s", exc)
        store.connected = False
        await asyncio.sleep(5)
