"""
Sentinel-X API — Flask backend v4.2

New in v4.2:
  - /api/stream  — Server-Sent Events; broadcasts every pushed run in real-time
  - /metrics     — Prometheus-style plain-text metrics endpoint
  - SSE requires gunicorn with a single worker + threads (see render.yaml)
"""

from __future__ import annotations

import functools
import json
import os
import queue
import sqlite3
import threading
import time
from pathlib import Path

from flask import Flask, Response, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

DB      = os.environ.get("DB_PATH", str(Path(__file__).parent / "sentinel.db"))
API_KEY = os.environ.get("SENTINEL_API_KEY", "")


# ── SSE subscriber bus (thread-safe) ─────────────────────────────────────────

_subscribers: list[queue.Queue] = []
_sub_lock    = threading.Lock()


def _broadcast(data: dict) -> None:
    """Push *data* to every connected SSE client; prune dead queues."""
    payload = json.dumps(data)
    with _sub_lock:
        alive = []
        for q in _subscribers:
            try:
                q.put_nowait(payload)
                alive.append(q)
            except queue.Full:
                pass   # client is too slow — drop it
        _subscribers[:] = alive


def _subscribe() -> queue.Queue:
    q: queue.Queue = queue.Queue(maxsize=20)
    with _sub_lock:
        _subscribers.append(q)
    return q


def _unsubscribe(q: queue.Queue) -> None:
    with _sub_lock:
        try:
            _subscribers.remove(q)
        except ValueError:
            pass


# ── Database ─────────────────────────────────────────────────────────────────

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _init() -> None:
    conn = _connect()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS runs (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp      TEXT,
            chaos_mode     TEXT,
            baseline_avg   REAL,
            canary_avg     REAL,
            noise          REAL,
            degradation    REAL,
            confidence     REAL,
            baseline_std   REAL,
            canary_std     REAL,
            error_rate     REAL,
            p95_baseline   REAL DEFAULT 0,
            p99_baseline   REAL DEFAULT 0,
            p95_canary     REAL DEFAULT 0,
            p99_canary     REAL DEFAULT 0,
            cohens_d       REAL DEFAULT 0,
            status         TEXT,
            reason         TEXT,
            eval_seconds   REAL DEFAULT 0,
            n_samples      INTEGER DEFAULT 10,
            b1_samples     TEXT,
            b2_samples     TEXT,
            canary_samples TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_timestamp ON runs(timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_status    ON runs(status)")
    conn.commit()
    _migrate(conn)
    conn.close()


def _migrate(conn: sqlite3.Connection) -> None:
    existing = {r[1] for r in conn.execute("PRAGMA table_info(runs)")}
    new_cols = {
        "p95_baseline": "REAL DEFAULT 0",
        "p99_baseline": "REAL DEFAULT 0",
        "p95_canary":   "REAL DEFAULT 0",
        "p99_canary":   "REAL DEFAULT 0",
        "cohens_d":     "REAL DEFAULT 0",
        "eval_seconds": "REAL DEFAULT 0",
        "n_samples":    "INTEGER DEFAULT 10",
    }
    for col, typedef in new_cols.items():
        if col not in existing:
            conn.execute(f"ALTER TABLE runs ADD COLUMN {col} {typedef}")
    conn.commit()


_init()


def _row(row: sqlite3.Row) -> dict:
    d = dict(row)
    for k in ("b1_samples", "b2_samples", "canary_samples"):
        try:
            d[k] = json.loads(d[k]) if d.get(k) else []
        except (json.JSONDecodeError, TypeError):
            d[k] = []
    return d


_EMPTY = {
    "status": "NO DATA", "reason": "No pipeline run yet.",
    "baseline_avg": 0, "canary_avg": 0, "noise": 0, "degradation": 0,
    "confidence": 0, "baseline_std": 0, "canary_std": 0, "error_rate": 0,
    "p95_baseline": 0, "p99_baseline": 0, "p95_canary": 0, "p99_canary": 0,
    "cohens_d": 0, "timestamp": "-", "chaos_mode": "none",
    "eval_seconds": 0, "n_samples": 0,
}


# ── Auth ─────────────────────────────────────────────────────────────────────

def require_key(fn):
    @functools.wraps(fn)
    def _wrap(*args, **kwargs):
        if API_KEY and request.headers.get("X-API-Key") != API_KEY:
            return jsonify({"error": "unauthorized"}), 401
        return fn(*args, **kwargs)
    return _wrap


# ── Routes — data ─────────────────────────────────────────────────────────────

@app.route("/")
def health():
    conn = _connect()
    total = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
    conn.close()
    return jsonify({
        "service": "sentinel-x-api", "version": "4.2",
        "status": "ok", "runs": total,
        "subscribers": len(_subscribers),
    })


@app.route("/api/latest")
def latest():
    conn = _connect()
    row  = conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()
    return jsonify(_row(row) if row else _EMPTY)


@app.route("/api/history")
def history():
    limit  = min(int(request.args.get("limit",  "20")), 100)
    offset = int(request.args.get("offset", "0"))
    chaos  = request.args.get("chaos")
    conn   = _connect()
    if chaos:
        rows  = conn.execute(
            "SELECT * FROM runs WHERE chaos_mode=? ORDER BY id DESC LIMIT ? OFFSET ?",
            (chaos, limit, offset)
        ).fetchall()
    else:
        rows  = conn.execute(
            "SELECT * FROM runs ORDER BY id DESC LIMIT ? OFFSET ?",
            (limit, offset)
        ).fetchall()
    total = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
    conn.close()
    return jsonify({"runs": [_row(r) for r in rows], "total": total})


@app.route("/api/runs/<int:run_id>")
def run_detail(run_id: int):
    conn = _connect()
    row  = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    conn.close()
    return (jsonify(_row(row)) if row else (jsonify({"error": "not found"}), 404))


@app.route("/api/stats")
def stats():
    conn  = _connect()
    total  = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
    passed = conn.execute("SELECT COUNT(*) FROM runs WHERE status='PASS'").fetchone()[0]
    failed = conn.execute("SELECT COUNT(*) FROM runs WHERE status LIKE '%FAIL%'").fetchone()[0]
    incon  = conn.execute("SELECT COUNT(*) FROM runs WHERE status='INCONCLUSIVE'").fetchone()[0]
    avg_d  = conn.execute(
        "SELECT AVG(degradation) FROM runs"
    ).fetchone()[0] or 0.0
    conn.close()
    return jsonify({
        "total":              total,
        "passed":             passed,
        "failed":             failed,
        "inconclusive":       incon,
        "pass_rate":          round(passed / total * 100 if total else 0, 1),
        "avg_degradation_ms": round(avg_d, 1),
        "live_subscribers":   len(_subscribers),
    })


@app.route("/api/push", methods=["POST"])
@require_key
def push():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "request body must be JSON"}), 400
    if not data.get("status"):
        return jsonify({"error": "'status' field is required"}), 400

    conn = _connect()
    conn.execute("""
        INSERT INTO runs (
            timestamp, chaos_mode,
            baseline_avg, canary_avg, noise, degradation, confidence,
            baseline_std, canary_std, error_rate,
            p95_baseline, p99_baseline, p95_canary, p99_canary, cohens_d,
            status, reason, eval_seconds, n_samples,
            b1_samples, b2_samples, canary_samples
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        data.get("timestamp", time.strftime("%Y-%m-%dT%H:%M:%S")),
        data.get("chaos_mode", "none"),
        data.get("baseline_avg", 0),   data.get("canary_avg", 0),
        data.get("noise", 0),          data.get("degradation", 0),
        data.get("confidence", 0),
        data.get("baseline_std", 0),   data.get("canary_std", 0),
        data.get("error_rate", 0),
        data.get("p95_baseline", 0),   data.get("p99_baseline", 0),
        data.get("p95_canary", 0),     data.get("p99_canary", 0),
        data.get("cohens_d", 0),
        data.get("status"),            data.get("reason", ""),
        data.get("eval_seconds", 0),   data.get("n_samples", 10),
        json.dumps(data.get("b1_samples", [])),
        json.dumps(data.get("b2_samples", [])),
        json.dumps(data.get("canary_samples", [])),
    ))
    conn.commit()
    run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()

    saved = {**data, "id": run_id}
    _broadcast(saved)   # push to all SSE subscribers

    return jsonify({"saved": True, "id": run_id})


# ── Routes — real-time & observability ───────────────────────────────────────

@app.route("/api/stream")
def stream():
    """
    Server-Sent Events endpoint.

    Each new run pushed via /api/push is broadcast here within milliseconds.
    Heartbeat event sent every 25s to keep the connection alive through
    proxies and load balancers.

    NOTE: requires gunicorn --workers 1 --threads 4 (or gthread worker class).
    Multi-worker deployments need a Redis pub/sub bus instead of in-process queues.
    """
    q = _subscribe()

    def _generate():
        try:
            while True:
                try:
                    payload = q.get(timeout=25)
                    yield f"data: {payload}\n\n"
                except queue.Empty:
                    # Heartbeat — keeps proxies from closing the connection
                    yield "data: {\"heartbeat\":true}\n\n"
        except GeneratorExit:
            pass
        finally:
            _unsubscribe(q)

    return Response(
        _generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":   "no-cache",
            "X-Accel-Buffering": "no",   # disable nginx buffering
            "Connection":      "keep-alive",
        },
    )


@app.route("/metrics")
def metrics():
    """
    Prometheus-style plain-text metrics.
    Scrape with: curl https://<host>/metrics
    """
    conn  = _connect()
    total  = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
    passed = conn.execute("SELECT COUNT(*) FROM runs WHERE status='PASS'").fetchone()[0]
    failed = conn.execute("SELECT COUNT(*) FROM runs WHERE status LIKE '%FAIL%'").fetchone()[0]
    incon  = conn.execute("SELECT COUNT(*) FROM runs WHERE status='INCONCLUSIVE'").fetchone()[0]
    avg_d  = conn.execute("SELECT AVG(degradation) FROM runs").fetchone()[0] or 0.0
    avg_c  = conn.execute("SELECT AVG(confidence) FROM runs").fetchone()[0] or 0.0
    conn.close()

    lines = [
        "# HELP sentinelx_runs_total Total pipeline runs",
        "# TYPE sentinelx_runs_total counter",
        f"sentinelx_runs_total {total}",
        "",
        "# HELP sentinelx_runs_passed Pipeline runs that PASSed",
        "# TYPE sentinelx_runs_passed counter",
        f"sentinelx_runs_passed {passed}",
        "",
        "# HELP sentinelx_runs_failed Pipeline runs that FAILed (any severity)",
        "# TYPE sentinelx_runs_failed counter",
        f"sentinelx_runs_failed {failed}",
        "",
        "# HELP sentinelx_runs_inconclusive Inconclusive pipeline runs",
        "# TYPE sentinelx_runs_inconclusive counter",
        f"sentinelx_runs_inconclusive {incon}",
        "",
        "# HELP sentinelx_pass_rate_pct Historical pass rate (percent)",
        "# TYPE sentinelx_pass_rate_pct gauge",
        f"sentinelx_pass_rate_pct {round(passed / total * 100 if total else 0, 2)}",
        "",
        "# HELP sentinelx_avg_degradation_ms Mean canary latency degradation across all runs",
        "# TYPE sentinelx_avg_degradation_ms gauge",
        f"sentinelx_avg_degradation_ms {round(avg_d, 2)}",
        "",
        "# HELP sentinelx_avg_confidence_pct Mean Mann-Whitney U confidence across all runs",
        "# TYPE sentinelx_avg_confidence_pct gauge",
        f"sentinelx_avg_confidence_pct {round(avg_c, 2)}",
        "",
        "# HELP sentinelx_sse_subscribers Current live SSE subscriber count",
        "# TYPE sentinelx_sse_subscribers gauge",
        f"sentinelx_sse_subscribers {len(_subscribers)}",
        "",
    ]
    return Response("\n".join(lines), mimetype="text/plain; version=0.0.4; charset=utf-8")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
