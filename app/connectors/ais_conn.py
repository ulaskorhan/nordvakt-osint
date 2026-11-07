from .. import ais
from .base import Connector, entity, relation

KILDE = "Kystverket AIS"
SONER = "Nordvakt soner"
PLACE_VESSEL_KM = 5
PLACE_ZONE_KM = 25


def vessel_entity(v: dict) -> dict:
    fart = f"{v['fart']} kn" if v.get("fart") is not None else None
    return entity(
        f"vessel:{v['mmsi']}", "vessel", v.get("navn") or f"MMSI {v['mmsi']}", kilde=KILDE,
        beskrivelse=" · ".join(filter(None, [v["flagg"], v["kategori"], fart])),
        lat=v.get("lat"), lon=v.get("lon"), tid=v.get("sist"),
        mmsi=v["mmsi"], flagg=v["flagg"], kategori=v["kategori"], kallesignal=v.get("kallesignal"),
        destinasjon=v.get("destinasjon"), fart=v.get("fart"), kurs=v.get("kurs"),
    )


def zone_entity(z: dict) -> dict:
    op = z.get("operatør") or {}
    return entity(
        f"zone:{z['id']}", "zone", z["navn"], kilde=SONER,
        beskrivelse=f"Overvåkingssone ({z['kategori']}) · radius {z['radius_km']} km",
        lat=z["lat"], lon=z["lon"], radius_km=z["radius_km"], kategori=z["kategori"],
        alias=z.get("alias"), operator=op.get("navn"),
    )


class AISConnector(Connector):
    name = KILDE
    prefixes = ("vessel", "zone")

    def __init__(self):
        self.store = ais.AISStore(ais.load_zones())

    async def run(self) -> None:
        await ais.run(self.store)

    def _zone(self, zid: str) -> dict | None:
        return next((z for z in self.store.zones if z["id"] == zid), None)

    def _vessels_near(self, lat: float, lon: float, km: float, limit: int = 40) -> list[tuple[float, dict]]:
        hits = []
        for v in self.store.vessels.values():
            if v["lat"] is None:
                continue
            d = ais.haversine_km(lat, lon, v["lat"], v["lon"])
            if d <= km:
                hits.append((d, v))
        return sorted(hits, key=lambda h: h[0])[:limit]

    async def search(self, q: str) -> list[dict]:
        ql = q.strip().lower()
        if not ql:
            return []
        zones = [zone_entity(z) for z in self.store.zones
                 if ql in z["navn"].lower() or any(ql in a.lower() for a in z.get("alias", []))]
        vessels = [
            vessel_entity(v) for v in self.store.vessels.values()
            if v["lat"] is not None and (
                ql in (v["navn"] or "").lower() or str(v["mmsi"]).startswith(ql)
                or ql == (v["kallesignal"] or "").lower()
            )
        ][:10]
        return zones + vessels

    async def get(self, eid: str) -> dict | None:
        prefix, key = eid.split(":", 1)
        if prefix == "zone":
            z = self._zone(key)
            return zone_entity(z) if z else None
        v = self.store.vessels.get(int(key)) if key.isdigit() else None
        return vessel_entity(v) if v and v["lat"] is not None else None

    async def expand(self, e: dict) -> tuple[list[dict], list[dict]]:
        ents, rels = [], []
        t = e["type"]

        if t == "zone":
            z = self._zone(e["id"].split(":", 1)[1])
            for d, v in self._vessels_near(z["lat"], z["lon"], z["radius_km"] * 2):
                ents.append(vessel_entity(v))
                label = "I sonen" if d <= z["radius_km"] else f"Nær sonen ({d:.1f} km)"
                rels.append(relation(f"vessel:{v['mmsi']}", e["id"], label, KILDE))
            if z.get("operatør"):
                op = z["operatør"]
                ents.append(entity(f"org:{op['orgnr']}", "org", op["navn"], kilde=SONER, orgnr=op["orgnr"]))
                rels.append(relation(f"org:{op['orgnr']}", e["id"], "Operatør", SONER))

        elif t == "vessel" and e["lat"] is not None:
            for z in self.store.zones:
                d = ais.haversine_km(e["lat"], e["lon"], z["lat"], z["lon"])
                if d <= z["radius_km"] * 2:
                    ents.append(zone_entity(z))
                    label = "I sonen" if d <= z["radius_km"] else f"Nær sonen ({d:.1f} km)"
                    rels.append(relation(e["id"], f"zone:{z['id']}", label, KILDE))

        elif t == "place" and e["lat"] is not None:
            for d, v in self._vessels_near(e["lat"], e["lon"], PLACE_VESSEL_KM, limit=25):
                ents.append(vessel_entity(v))
                rels.append(relation(f"vessel:{v['mmsi']}", e["id"], f"{d:.1f} km unna", KILDE))
            for z in self.store.zones:
                d = ais.haversine_km(e["lat"], e["lon"], z["lat"], z["lon"])
                if d <= PLACE_ZONE_KM:
                    ents.append(zone_entity(z))
                    rels.append(relation(f"zone:{z['id']}", e["id"], f"{d:.0f} km unna", SONER))

        elif t == "org" and e["props"].get("orgnr"):
            for z in self.store.zones:
                if (z.get("operatør") or {}).get("orgnr") == e["props"]["orgnr"]:
                    ents.append(zone_entity(z))
                    rels.append(relation(e["id"], f"zone:{z['id']}", "Operatør", SONER))

        return ents, rels
