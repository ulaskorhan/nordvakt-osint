"""Kildelogg: hvert oppslag mot en ekstern kilde logges med tidspunkt, URL og hash
av svaret, slik at funn kan spores tilbake til nøyaktig hva som ble hentet og når."""

import hashlib
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "kildelogg.sqlite"

_lock = threading.Lock()
_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.execute(
    """CREATE TABLE IF NOT EXISTS kildelogg (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tidspunkt TEXT NOT NULL,
        kilde TEXT NOT NULL,
        url TEXT NOT NULL,
        status INTEGER,
        sha256 TEXT
    )"""
)
_conn.commit()


def log(kilde: str, url: str, status: int, body: bytes) -> None:
    digest = hashlib.sha256(body).hexdigest()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _lock:
        _conn.execute(
            "INSERT INTO kildelogg (tidspunkt, kilde, url, status, sha256) VALUES (?, ?, ?, ?, ?)",
            (now, kilde, url, status, digest),
        )
        _conn.commit()


def recent(limit: int = 100) -> list[dict]:
    with _lock:
        rows = _conn.execute(
            "SELECT tidspunkt, kilde, url, status, sha256 FROM kildelogg ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [
        {"tidspunkt": r[0], "kilde": r[1], "url": r[2], "status": r[3], "sha256": r[4]}
        for r in rows
    ]


def summary() -> list[dict]:
    """Én rad per kilde: antall oppslag og det siste oppslaget."""
    with _lock:
        rows = _conn.execute(
            """SELECT k.kilde, n.antall, k.tidspunkt, k.status, k.sha256, k.url
               FROM kildelogg k
               JOIN (SELECT kilde, COUNT(*) AS antall, MAX(id) AS siste FROM kildelogg GROUP BY kilde) n
                 ON n.siste = k.id
               ORDER BY k.kilde"""
        ).fetchall()
    return [{"kilde": r[0], "oppslag": r[1], "sist": r[2], "status": r[3], "sha256": r[4], "url": r[5]}
            for r in rows]
