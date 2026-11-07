"""Entitetslager: alle entiteter og relasjoner som er slått opp, med første og siste
gang de ble sett. Grunnlaget for saksmapper senere.

Personer lagres ikke. De vises bare i øyeblikket som roller i en virksomhet.
"""

import json
import sqlite3
import threading
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "entiteter.sqlite"

_lock = threading.Lock()
_db = sqlite3.connect(DB_PATH, check_same_thread=False)
_db.executescript(
    """
    CREATE TABLE IF NOT EXISTS entiteter (
        id TEXT PRIMARY KEY, type TEXT, label TEXT, data TEXT, forst_sett REAL, sist_sett REAL
    );
    CREATE TABLE IF NOT EXISTS relasjoner (
        fra TEXT, til TEXT, label TEXT, kilde TEXT, forst_sett REAL, sist_sett REAL,
        PRIMARY KEY (fra, til, label)
    );
    """
)


def save(entities: list[dict], relations: list[dict]) -> None:
    now = time.time()
    ents = [e for e in entities if e["type"] != "person"]
    rels = [r for r in relations if not r["fra"].startswith("person:") and not r["til"].startswith("person:")]
    with _lock:
        _db.executemany(
            """INSERT INTO entiteter VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET label = excluded.label, data = excluded.data, sist_sett = excluded.sist_sett""",
            [(e["id"], e["type"], e["label"], json.dumps(e, ensure_ascii=False), now, now) for e in ents],
        )
        _db.executemany(
            """INSERT INTO relasjoner VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(fra, til, label) DO UPDATE SET sist_sett = excluded.sist_sett""",
            [(r["fra"], r["til"], r["label"], r["kilde"], now, now) for r in rels],
        )
        _db.commit()


def stats() -> dict:
    with _lock:
        types = dict(_db.execute("SELECT type, COUNT(*) FROM entiteter GROUP BY type").fetchall())
        rels = _db.execute("SELECT COUNT(*) FROM relasjoner").fetchone()[0]
    return {"entiteter": types, "relasjoner": rels}
