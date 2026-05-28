"""Check TFT Academy settings + correlate event capture with MP4 recording."""
import os, sqlite3, json
from pathlib import Path

APP = Path(os.environ["APPDATA"]) / "TFTAcademy"
DB = APP / "tft-events.db"
CONFIG = APP / "config.json"

conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
cur = conn.cursor()

print("=== ALL SETTINGS ===")
cur.execute("SELECT key, value FROM settings ORDER BY key")
for k, v in cur.fetchall():
    # Truncate long values
    vs = v if v else ""
    if len(vs) > 200:
        vs = vs[:200] + "..."
    print(f"  {k}")
    print(f"    {vs}")
    print()

print("\n=== GAMES — events vs recording status ===")
cur.execute("""
  SELECT
    substr(id, 1, 8) AS game,
    datetime(started_at, 'unixepoch') AS started,
    final_placement,
    CASE WHEN recording_file_path IS NOT NULL THEN 'yes' ELSE 'no' END AS recorded,
    (SELECT COUNT(*) FROM events WHERE game_id = games.id) AS events
  FROM games ORDER BY started_at
""")
for r in cur.fetchall():
    place = str(r[2]) if r[2] is not None else "—"
    print(f"  {r[0]}  {r[1]}  place={place:>3s}  recorded={r[3]:>3s}  events={r[4]}")

print("\n=== CONFIG.JSON KEYS ===")
if CONFIG.exists():
    cfg = json.loads(CONFIG.read_text())
    if isinstance(cfg, dict):
        def walk(d, prefix=""):
            for k, v in d.items():
                if isinstance(v, dict):
                    walk(v, prefix + k + ".")
                elif isinstance(v, list):
                    print(f"  {prefix}{k}: [list of {len(v)}]")
                else:
                    vs = str(v)
                    if len(vs) > 120: vs = vs[:120] + "..."
                    print(f"  {prefix}{k}: {vs}")
        walk(cfg)

conn.close()
