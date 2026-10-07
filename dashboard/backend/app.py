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
import re
import sqlite3
import threading
import time
import uuid
import zipfile
from pathlib import Path

from flask import Flask, Response, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app, expose_headers=["Content-Type"])

DB         = os.environ.get("DB_PATH", str(Path(__file__).parent / "sentinel.db"))
API_KEY    = os.environ.get("SENTINEL_API_KEY", "")
UPLOAD_KEY = os.environ.get("SENTINEL_UPLOAD_KEY", "")   # optional gate on /api/jobs uploads
RUNNER_KEY = os.environ.get("SENTINEL_RUNNER_KEY", "")   # required for runner endpoints
JOBS_DIR   = Path(os.environ.get("JOBS_DIR", str(Path(__file__).parent / "jobs")))
SAMPLES    = Path(__file__).parent / "samples"
MAX_ZIP_MB = 25
MAX_QUEUED = 5
CHAOS_MODES = ("none", "latency", "packetloss", "combined")
SAMPLE_JOBS = {
    "good": {"file": "good-service.zip", "name": "Sample: healthy service"},
    "slow": {"file": "slow-service.zip", "name": "Sample: slow service (regression)"},
}
JOBS_DIR.mkdir(parents=True, exist_ok=True)
app.config["MAX_CONTENT_LENGTH"] = (2 * MAX_ZIP_MB + 5) * 1024 * 1024
_runner_seen = {"t": 0.0}


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
    conn.execute("""
        CREATE TABLE IF NOT EXISTS jobs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT,
            status     TEXT DEFAULT 'queued',
            chaos_mode TEXT DEFAULT 'latency',
            port       INTEGER DEFAULT 8080,
            health     TEXT DEFAULT '/',
            canary     TEXT,
            baseline   TEXT,
            run_id     INTEGER,
            log        TEXT DEFAULT '',
            error      TEXT,
            created    REAL,
            updated    REAL
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
        "service":      "TEXT",
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
    return jsonify({"saved": True, "id": _insert_run(data)})


def _insert_run(data: dict) -> int:
    """Store one evaluation result, broadcast it to SSE clients, return its id."""
    conn = _connect()
    conn.execute("""
        INSERT INTO runs (
            timestamp, chaos_mode,
            baseline_avg, canary_avg, noise, degradation, confidence,
            baseline_std, canary_std, error_rate,
            p95_baseline, p99_baseline, p95_canary, p99_canary, cohens_d,
            status, reason, eval_seconds, n_samples,
            b1_samples, b2_samples, canary_samples, service
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
        data.get("service"),
    ))
    conn.commit()
    run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()

    _broadcast({**data, "id": run_id})   # push to all SSE subscribers
    return run_id


# ── Jobs: bring-your-own-service ─────────────────────────────────────────────
# Flow: user uploads a zip containing a Dockerfile → job is queued here → a
# runner agent on a machine with minikube claims it, builds, deploys, injects
# chaos, evaluates, and posts the result back via /api/runner/*.

def require_upload_key(fn):
    @functools.wraps(fn)
    def _wrap(*args, **kwargs):
        if UPLOAD_KEY and request.headers.get("X-Upload-Key") != UPLOAD_KEY:
            return jsonify({"error": "invalid or missing access key"}), 401
        return fn(*args, **kwargs)
    return _wrap


def require_runner(fn):
    @functools.wraps(fn)
    def _wrap(*args, **kwargs):
        if not RUNNER_KEY:
            return jsonify({"error": "runner access is not configured on this server"}), 503
        if request.headers.get("X-Runner-Key") != RUNNER_KEY:
            return jsonify({"error": "unauthorized"}), 401
        _runner_seen["t"] = time.time()
        return fn(*args, **kwargs)
    return _wrap


def _job_public(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["has_baseline"] = bool(d.pop("baseline"))
    d.pop("canary", None)
    return d


def _job_event(job_id: int) -> None:
    conn = _connect()
    row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    conn.close()
    if row:
        _broadcast({"event": "job", **_job_public(row)})


def _is_zip(path: Path) -> bool:
    try:
        with zipfile.ZipFile(path) as z:
            return z.testzip() is None and len(z.namelist()) > 0
    except zipfile.BadZipFile:
        return False


def _create_job(name: str, chaos: str, port: int, health: str, canary: Path, baseline: Path | None) -> int:
    conn = _connect()
    if conn.execute("SELECT COUNT(*) FROM jobs WHERE status='queued'").fetchone()[0] >= MAX_QUEUED:
        conn.close()
        raise OverflowError("queue is full — wait for a running test to finish")
    now = time.time()
    cur = conn.execute(
        "INSERT INTO jobs (name, chaos_mode, port, health, canary, baseline, created, updated) VALUES (?,?,?,?,?,?,?,?)",
        (name, chaos, port, health, str(canary) if canary else None, str(baseline) if baseline else None, now, now),
    )
    conn.commit()
    job_id = cur.lastrowid
    conn.close()
    return job_id


def _save_zip(field: str, tag: str) -> Path | None:
    f = request.files.get(field)
    if not f or not f.filename:
        return None
    tmp = JOBS_DIR / f"upload_{uuid.uuid4().hex}.zip"
    f.save(tmp)
    if tmp.stat().st_size > MAX_ZIP_MB * 1024 * 1024 or not _is_zip(tmp):
        tmp.unlink(missing_ok=True)
        raise ValueError(f"{field}: must be a valid .zip under {MAX_ZIP_MB} MB")
    return tmp


def _clean_form():
    name  = re.sub(r"[^\w .\-()]", "", (request.form.get("name") or "My service"))[:60].strip() or "My service"
    chaos = request.form.get("chaos", "latency")
    if chaos not in CHAOS_MODES:
        raise ValueError(f"chaos must be one of {', '.join(CHAOS_MODES)}")
    try:
        port = int(request.form.get("port", "8080"))
    except ValueError:
        raise ValueError("port must be a number")
    if not 1 <= port <= 65535:
        raise ValueError("port must be between 1 and 65535")
    health = request.form.get("health", "/") or "/"
    if not re.fullmatch(r"/[A-Za-z0-9_\-./]*", health):
        raise ValueError("health path must start with / and use simple characters")
    return name, chaos, port, health


@app.route("/api/jobs", methods=["POST"])
@require_upload_key
def create_job():
    canary = baseline = None
    try:
        name, chaos, port, health = _clean_form()
        canary = _save_zip("canary", "canary")
        if canary is None:
            return jsonify({"error": "canary: a .zip containing a Dockerfile is required"}), 400
        baseline = _save_zip("baseline", "baseline")
        job_id = _create_job(name, chaos, port, health, canary, baseline)
    except ValueError as exc:
        for p in (canary, baseline):
            if p: p.unlink(missing_ok=True)
        return jsonify({"error": str(exc)}), 400
    except OverflowError as exc:
        for p in (canary, baseline):
            if p: p.unlink(missing_ok=True)
        return jsonify({"error": str(exc)}), 429
    _job_event(job_id)
    return jsonify({"queued": True, "id": job_id}), 201


@app.route("/api/jobs/sample", methods=["POST"])
def create_sample_job():
    body   = request.get_json(silent=True) or {}
    key    = body.get("sample", "good")
    sample = SAMPLE_JOBS.get(key)
    if not sample or not (SAMPLES / sample["file"]).exists():
        return jsonify({"error": f"unknown sample '{key}'"}), 400
    chaos = body.get("chaos", "none")
    if chaos not in CHAOS_MODES:
        return jsonify({"error": "invalid chaos mode"}), 400
    dest = JOBS_DIR / f"upload_{uuid.uuid4().hex}.zip"
    dest.write_bytes((SAMPLES / sample["file"]).read_bytes())
    baseline = None
    if key == "slow":   # baseline = the healthy version, canary = the regressed one
        baseline = JOBS_DIR / f"upload_{uuid.uuid4().hex}.zip"
        baseline.write_bytes((SAMPLES / SAMPLE_JOBS["good"]["file"]).read_bytes())
    try:
        job_id = _create_job(sample["name"], chaos, 8080, "/", dest, baseline)
    except OverflowError as exc:
        dest.unlink(missing_ok=True)
        if baseline: baseline.unlink(missing_ok=True)
        return jsonify({"error": str(exc)}), 429
    _job_event(job_id)
    return jsonify({"queued": True, "id": job_id}), 201


@app.route("/api/jobs")
def list_jobs():
    limit = min(int(request.args.get("limit", "20")), 100)
    conn  = _connect()
    rows  = conn.execute("SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return jsonify({"jobs": [_job_public(r) for r in rows]})


@app.route("/api/jobs/<int:job_id>")
def job_detail(job_id: int):
    conn = _connect()
    row  = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    conn.close()
    return jsonify(_job_public(row)) if row else (jsonify({"error": "not found"}), 404)


@app.route("/api/runner")
def runner_status():
    age = time.time() - _runner_seen["t"] if _runner_seen["t"] else None
    return jsonify({"online": age is not None and age < 30, "seconds_since_seen": None if age is None else round(age)})


@app.route("/api/runner/claim", methods=["POST"])
@require_runner
def runner_claim():
    conn = _connect()
    row = conn.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").fetchone()
    if not row:
        conn.close()
        return jsonify({"job": None})
    conn.execute("UPDATE jobs SET status='building', updated=? WHERE id=? AND status='queued'", (time.time(), row["id"]))
    conn.commit()
    conn.close()
    _job_event(row["id"])
    return jsonify({"job": {
        "id": row["id"], "name": row["name"], "chaos_mode": row["chaos_mode"],
        "port": row["port"], "health": row["health"], "has_baseline": bool(row["baseline"]),
    }})


@app.route("/api/runner/jobs/<int:job_id>/artifact/<role>")
@require_runner
def runner_artifact(job_id: int, role: str):
    if role not in ("canary", "baseline"):
        return jsonify({"error": "bad role"}), 400
    conn = _connect()
    row = conn.execute(f"SELECT {role} FROM jobs WHERE id=?", (job_id,)).fetchone()
    conn.close()
    if not row or not row[0] or not Path(row[0]).exists():
        return jsonify({"error": "not found"}), 404
    return Response(Path(row[0]).read_bytes(), mimetype="application/zip")


@app.route("/api/runner/jobs/<int:job_id>/update", methods=["POST"])
@require_runner
def runner_update(job_id: int):
    body = request.get_json(silent=True) or {}
    status, line, error = body.get("status"), body.get("log"), body.get("error")
    conn = _connect()
    row = conn.execute("SELECT log FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "not found"}), 404
    log = (row["log"] or "") + (f"{line}\n" if line else "")
    conn.execute(
        "UPDATE jobs SET status=COALESCE(?, status), log=?, error=COALESCE(?, error), updated=? WHERE id=?",
        (status, log[-8000:], (error or "")[:1000] or None, time.time(), job_id),
    )
    conn.commit()
    conn.close()
    _job_event(job_id)
    return jsonify({"ok": True})


@app.route("/api/runner/jobs/<int:job_id>/complete", methods=["POST"])
@require_runner
def runner_complete(job_id: int):
    result = request.get_json(silent=True) or {}
    if not result.get("status"):
        return jsonify({"error": "'status' field is required"}), 400
    conn = _connect()
    row = conn.execute("SELECT name FROM jobs WHERE id=?", (job_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "not found"}), 404
    result["service"] = row["name"]
    run_id = _insert_run(result)
    conn = _connect()
    conn.execute("UPDATE jobs SET status='done', run_id=?, updated=? WHERE id=?", (run_id, time.time(), job_id))
    conn.commit()
    conn.close()
    for key in ("canary", "baseline"):   # artifacts are no longer needed once tested
        conn = _connect()
        r = conn.execute(f"SELECT {key} FROM jobs WHERE id=?", (job_id,)).fetchone()
        conn.execute(f"UPDATE jobs SET {key}=NULL WHERE id=?", (job_id,))
        conn.commit()
        conn.close()
        if r and r[0]:
            Path(r[0]).unlink(missing_ok=True)
    _job_event(job_id)
    return jsonify({"saved": True, "run_id": run_id})


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
