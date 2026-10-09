"""Saved designs (SQLite).

We keep the uploaded picture plus the options and edits, not the stitches.
Stitches are re-planned on load, so improvements to the engine reach old
designs too. Design ids are random 128-bit values; knowing the id is what
grants access (the same model as an unlisted link).
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path

DEFAULT_DIR = Path(__file__).resolve().parent.parent / "data"


class Store:
    def __init__(self, path: str | os.PathLike | None = None):
        if path is None:
            data_dir = Path(os.environ.get("ECKO_DATA_DIR", DEFAULT_DIR))
            data_dir.mkdir(parents=True, exist_ok=True)
            path = data_dir / "ecko.sqlite3"
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute(
                """CREATE TABLE IF NOT EXISTS designs (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created REAL NOT NULL,
                    updated REAL NOT NULL,
                    image BLOB,
                    options TEXT NOT NULL,
                    edits TEXT NOT NULL,
                    summary TEXT NOT NULL DEFAULT '{}'
                )"""
            )
            self._db.commit()

    def create(self, name: str, image: bytes | None, options: dict, edits: dict) -> str:
        did = uuid.uuid4().hex
        now = time.time()
        with self._lock:
            self._db.execute(
                "INSERT INTO designs (id, name, created, updated, image, options, edits) VALUES (?,?,?,?,?,?,?)",
                (did, name, now, now, image, json.dumps(options), json.dumps(edits)),
            )
            self._db.commit()
        return did

    def get(self, did: str) -> dict | None:
        with self._lock:
            row = self._db.execute(
                "SELECT id, name, created, updated, image, options, edits, summary FROM designs WHERE id = ?",
                (did,),
            ).fetchone()
        if not row:
            return None
        return {
            "id": row[0], "name": row[1], "created": row[2], "updated": row[3], "image": row[4],
            "options": json.loads(row[5]), "edits": json.loads(row[6]), "summary": json.loads(row[7]),
        }

    def update(self, did: str, **fields) -> None:
        allowed = {"name", "options", "edits", "summary"}
        sets, vals = [], []
        for k, v in fields.items():
            if k not in allowed:
                raise KeyError(k)
            sets.append(f"{k} = ?")
            vals.append(json.dumps(v) if k != "name" else v)
        sets.append("updated = ?")
        vals.append(time.time())
        with self._lock:
            self._db.execute(f"UPDATE designs SET {', '.join(sets)} WHERE id = ?", (*vals, did))
            self._db.commit()

    def summaries(self, ids: list[str]) -> list[dict]:
        if not ids:
            return []
        marks = ",".join("?" * len(ids))
        with self._lock:
            rows = self._db.execute(
                f"SELECT id, name, updated, summary FROM designs WHERE id IN ({marks}) ORDER BY updated DESC",
                ids,
            ).fetchall()
        return [{"id": r[0], "name": r[1], "updated": r[2], **json.loads(r[3])} for r in rows]

    def delete(self, did: str) -> bool:
        with self._lock:
            cur = self._db.execute("DELETE FROM designs WHERE id = ?", (did,))
            self._db.commit()
        return cur.rowcount > 0
