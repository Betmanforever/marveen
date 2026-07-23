#!/usr/bin/env python3
"""Site availability monitor (kanban #8fc05c73).

Probes the production websites listed in store/site-monitor-config.json
(HTTP status, latency, content marker, SSL expiry, optional www->apex
redirect) and records every check into the site_checks table of
store/claudeclaw.db. Pure stdlib, zero LLM tokens -- meant to run from a
systemd user timer every 5 minutes, independent of any agent session.

Alerting (state-transition only, flap-protected):
  - site DOWN  after N consecutive failed checks (config: consecutive_fails)
  - site UP    after a down state recovers
  - SSL expiry closer than ssl_warn_days (re-alerted at most once per day)
Alerts go as an inter-agent message (neo -> mr-wolfe) through the local
dashboard API; mr-wolfe relays to Telegram. No alert = silence.

Stats/reporting live in site-monitor-stats.py, not here.
"""

import json
import socket
import ssl
import sqlite3
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

REPO = "/home/szabgabor/marveen"
DB = f"{REPO}/store/claudeclaw.db"
CONFIG = f"{REPO}/store/site-monitor-config.json"
TOKEN_FILE = f"{REPO}/store/.dashboard-token"
API = "http://localhost:3420/api/messages"
LOG = f"{REPO}/store/site-monitor.log"

SCHEMA = """
CREATE TABLE IF NOT EXISTS site_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT (unixepoch()),
  site TEXT NOT NULL,
  http_code INTEGER,
  latency_ms INTEGER,
  marker_ok INTEGER,
  redirect_ok INTEGER,
  ssl_days INTEGER,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_site_checks_site_ts ON site_checks(site, ts);
CREATE TABLE IF NOT EXISTS site_monitor_state (
  site TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'up',
  fails_in_row INTEGER NOT NULL DEFAULT 0,
  down_since INTEGER,
  last_ssl_alert_ts INTEGER
);
"""


def log(msg: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG, "a") as fh:
        fh.write(f"{stamp} {msg}\n")


def ssl_days_left(hostname: str, timeout: int) -> int | None:
    ctx = ssl.create_default_context()
    with socket.create_connection((hostname, 443), timeout=timeout) as sock:
        with ctx.wrap_socket(sock, server_hostname=hostname) as tls:
            cert = tls.getpeercert()
    not_after = cert.get("notAfter")
    if not not_after:
        return None
    expiry = datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    return int((expiry - datetime.now(timezone.utc)).total_seconds() // 86400)


def probe(site: dict, timeout: int) -> dict:
    url = site["url"]
    result = {
        "http_code": None, "latency_ms": None, "marker_ok": None,
        "redirect_ok": None, "ssl_days": None, "ok": 0, "error": None,
    }
    req = urllib.request.Request(url, headers={"User-Agent": "marveen-site-monitor/1.0"})
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(262144).decode("utf-8", errors="replace")
            result["http_code"] = resp.status
            result["latency_ms"] = int((time.monotonic() - start) * 1000)
            marker = site.get("marker")
            result["marker_ok"] = int(marker.lower() in body.lower()) if marker else None
    except urllib.error.HTTPError as e:
        result["http_code"] = e.code
        result["latency_ms"] = int((time.monotonic() - start) * 1000)
        result["error"] = f"http {e.code}"
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"

    hostname = url.split("//", 1)[1].split("/", 1)[0]
    try:
        result["ssl_days"] = ssl_days_left(hostname, timeout)
    except Exception as e:
        # SSL probe failure alone does not mark the site down, but is recorded.
        result["error"] = result["error"] or f"ssl: {type(e).__name__}: {e}"

    redirect_from = site.get("redirect_from")
    if redirect_from:
        try:
            r = urllib.request.Request(redirect_from, headers={"User-Agent": "marveen-site-monitor/1.0"})
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                result["redirect_ok"] = int(resp.url.rstrip("/") == url.rstrip("/"))
        except Exception:
            result["redirect_ok"] = 0

    result["ok"] = int(
        result["http_code"] == 200
        and (result["marker_ok"] in (None, 1))
    )
    return result


def send_alert(cfg: dict, text: str) -> None:
    try:
        token = open(TOKEN_FILE).read().strip()
        payload = json.dumps({
            "from": cfg["alert"].get("alert_from", "neo"),
            "to": cfg["alert"].get("alert_to", "mr-wolfe"),
            "content": text,
        }).encode()
        req = urllib.request.Request(API, data=payload, headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        })
        urllib.request.urlopen(req, timeout=10)
        log(f"ALERT SENT: {text[:120]}")
    except Exception as e:
        log(f"ALERT FAILED ({type(e).__name__}: {e}): {text[:120]}")


def fmt_duration(seconds: int) -> str:
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h}h{m:02d}m" if h else f"{m}m{s:02d}s"


def main() -> int:
    cfg = json.load(open(CONFIG))
    timeout = cfg.get("timeout_seconds", 15)
    n_fails = cfg["alert"].get("consecutive_fails", 2)
    ssl_warn = cfg["alert"].get("ssl_warn_days", 14)

    db = sqlite3.connect(DB, timeout=30)
    db.executescript(SCHEMA)
    now = int(time.time())

    for site in cfg["sites"]:
        name = site["name"]
        r = probe(site, timeout)
        db.execute(
            "INSERT INTO site_checks (ts, site, http_code, latency_ms, marker_ok, redirect_ok, ssl_days, ok, error)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (now, name, r["http_code"], r["latency_ms"], r["marker_ok"],
             r["redirect_ok"], r["ssl_days"], r["ok"], r["error"]),
        )
        row = db.execute("SELECT status, fails_in_row, down_since, last_ssl_alert_ts FROM site_monitor_state WHERE site=?", (name,)).fetchone()
        status, fails, down_since, last_ssl_alert = row if row else ("up", 0, None, None)

        if r["ok"]:
            if status == "down":
                dur = fmt_duration(now - down_since) if down_since else "?"
                send_alert(cfg, f"[site-monitor] {name} ({site['url']}) UJRA ELERHETO. Kieses hossza: {dur}. http={r['http_code']} latency={r['latency_ms']}ms")
            status, fails, down_since = "up", 0, None
        else:
            fails += 1
            if status == "up" and fails >= n_fails:
                status, down_since = "down", now
                send_alert(cfg, f"[site-monitor] {name} ({site['url']}) NEM ELERHETO ({fails} egymast koveto hibas check). Utolso hiba: {r['error'] or ('http ' + str(r['http_code']))}. Javasolt: hoszting/DNS ellenorzes; a monitor 5 percenkent ujraprobalja es jelez ha helyreallt.")

        if r["ssl_days"] is not None and r["ssl_days"] < ssl_warn:
            if not last_ssl_alert or now - last_ssl_alert > 86400:
                send_alert(cfg, f"[site-monitor] {name}: az SSL tanusitvany {r['ssl_days']} nap mulva lejar. Megujitas szukseges (Let's Encrypt auto-renew ellenorzese a hosztingon).")
                last_ssl_alert = now

        db.execute(
            "INSERT INTO site_monitor_state (site, status, fails_in_row, down_since, last_ssl_alert_ts) VALUES (?,?,?,?,?)"
            " ON CONFLICT(site) DO UPDATE SET status=excluded.status, fails_in_row=excluded.fails_in_row,"
            " down_since=excluded.down_since, last_ssl_alert_ts=excluded.last_ssl_alert_ts",
            (name, status, fails, down_since, last_ssl_alert),
        )
        log(f"{name}: ok={r['ok']} http={r['http_code']} lat={r['latency_ms']}ms marker={r['marker_ok']} ssl_days={r['ssl_days']} status={status} err={r['error'] or '-'}")

    db.commit()
    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
