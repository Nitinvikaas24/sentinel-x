"""
Sentinel-X Judge — Evaluation Engine v4.2

Probes A/A/B services and makes statistical promote/rollback decisions.

Chaos is injected at the Kubernetes network layer via Chaos Mesh.  This
module only *measures* outcomes — it does not simulate faults in software.
Previously the probe() function added artificial delays to mimic the K8s
fault; that was removed because it double-counted the chaos and produced
biased latency estimates.

Statistical measures:
  - Mann-Whitney U (one-sided): P(canary latency > baseline latency)
    confidence = (1 − p_value) × 100
  - Cohen's d: standardised mean difference (effect size)
    d = (mean_canary − mean_baseline) / pooled_std

Thresholds are loaded from sentinelx.yaml (project root) when present,
with built-in defaults as fallback.
"""

from __future__ import annotations

import os
import subprocess
import time
import json
import statistics
import requests
from pathlib import Path
from typing import Dict, List, Tuple, Any


# ── Config loading ──────────────────────────────────────────────────────────

def _load_yaml_config() -> dict:
    """Load sentinelx.yaml from the project root (two levels up from this file)."""
    yaml_path = Path(__file__).parent.parent / "sentinelx.yaml"
    if yaml_path.exists():
        try:
            import yaml
            with open(yaml_path) as fh:
                return yaml.safe_load(fh) or {}
        except Exception as exc:
            print(f"[judge] Warning: could not load sentinelx.yaml: {exc}")
    return {}


_yaml_cfg = _load_yaml_config()
_ev_cfg   = _yaml_cfg.get("evaluation", {})
_th_cfg   = _yaml_cfg.get("thresholds", {})

# ── Runtime constants ───────────────────────────────────────────────────────

SAMPLES: int     = int(os.environ.get("SENTINEL_SAMPLES", str(_ev_cfg.get("samples", 20))))
TIMEOUT_S: float = float(_ev_cfg.get("timeout_s", 5.0))
ERROR_MS: float  = 5000.0   # sentinel value assigned to failed / timed-out requests

# Decision thresholds (ms / %) — all overridable via sentinelx.yaml → thresholds
NOISE_WARN_MS        = float(_th_cfg.get("noise_warn_ms",       30.0))
NOISE_FAIL_MS        = float(_th_cfg.get("noise_fail_ms",       50.0))
DEGRADATION_FAIL_MS  = float(_th_cfg.get("degradation_fail_ms", 80.0))
DEGRADATION_CRIT_MS  = float(_th_cfg.get("degradation_crit_ms", 300.0))
ERROR_RATE_FAIL_PCT  = float(_th_cfg.get("error_rate_fail_pct", 5.0))
CANARY_STD_FAIL_MS   = float(_th_cfg.get("canary_std_fail_ms",  80.0))
COHENS_D_LARGE       = float(_th_cfg.get("cohens_d_large",      0.8))


# ── Percentile helper (no external deps) ────────────────────────────────────

def _pct(data: List[float], p: float) -> float:
    """Nearest-rank percentile of *data* at percentage *p* (0–100)."""
    if not data:
        return 0.0
    s = sorted(data)
    k = max(0, min(int(len(s) * p / 100), len(s) - 1))
    return s[k]


# ── Statistical confidence (Mann-Whitney U) ─────────────────────────────────

def _confidence(baseline: List[float], canary: List[float]) -> float:
    """
    One-sided confidence (0–100) that the canary is degraded relative to
    the baseline, derived from the Mann-Whitney U statistic.

    H₀: P(canary > baseline) = 0.5  (no regression)
    H₁: P(canary > baseline) > 0.5  (canary is slower)
    confidence = (1 − p_value) × 100

    Falls back to the normalised U-fraction (exact probability estimate)
    when scipy is not installed.
    """
    if not baseline or not canary:
        return 0.0

    try:
        from scipy.stats import mannwhitneyu
        # alternative="less" → H1: baseline < canary (canary is slower)
        _, p = mannwhitneyu(baseline, canary, alternative="less")
        return round((1.0 - p) * 100.0, 1)
    except ImportError:
        pass

    # Pure-Python fallback: fraction of pairs where canary > baseline
    wins  = sum(1 for c in canary for b in baseline if c > b)
    total = len(canary) * len(baseline)
    return round((wins / total) * 100.0, 1) if total else 0.0


# ── Effect size (Cohen's d) ──────────────────────────────────────────────────

def _cohens_d(baseline: List[float], canary: List[float]) -> float:
    """
    Standardised mean difference between canary and baseline latency.

      d = (mean_canary − mean_baseline) / pooled_std

    Positive d → canary is slower (regression).
    Negative d → canary is faster (improvement).
    Returns 0.0 when pooled std is zero (identical distributions).

    Rule of thumb (Cohen 1988):
      |d| < 0.2  → negligible
      |d| < 0.5  → small
      |d| < 0.8  → medium
      |d| >= 0.8 → large
    """
    if len(baseline) < 2 or len(canary) < 2:
        return 0.0

    m_b = statistics.mean(baseline)
    m_c = statistics.mean(canary)
    s_b = statistics.stdev(baseline)
    s_c = statistics.stdev(canary)

    pooled = ((s_b ** 2 + s_c ** 2) / 2.0) ** 0.5
    if pooled == 0.0:
        return 0.0

    return round((m_c - m_b) / pooled, 4)


# ── Service discovery ────────────────────────────────────────────────────────

def get_service_urls() -> Dict[str, str]:
    """
    Return URLs for each service variant.
    Env vars (set by the pipeline before calling this) take precedence over
    minikube tunnel discovery so that parallel tunnel processes are not
    duplicated.
    """
    env_b1 = os.environ.get("URL_BASELINE1")
    env_b2 = os.environ.get("URL_BASELINE2")
    env_c  = os.environ.get("URL_CANARY")

    if env_b1 and env_b2 and env_c:
        return {"baseline1": env_b1, "baseline2": env_b2, "canary": env_c}

    print("[judge] Discovering service URLs via minikube...")
    urls: Dict[str, str] = {}
    for svc, key in [
        ("svc-baseline-1", "baseline1"),
        ("svc-baseline-2", "baseline2"),
        ("svc-canary",     "canary"),
    ]:
        result = subprocess.run(
            ["minikube", "service", svc, "--url"],
            capture_output=True, text=True, timeout=30,
        )
        url = result.stdout.strip().splitlines()[0].strip()
        if not url.startswith("http"):
            raise RuntimeError(f"Could not get URL for {svc}: {result.stderr}")
        urls[key] = url
        print(f"[judge]   {svc} → {url}")

    return urls


# ── Probing ──────────────────────────────────────────────────────────────────

def probe(url: str, n: int = SAMPLES) -> Tuple[List[float], int]:
    """
    Issue *n* GET requests to *url* and return (latency_samples_ms, n_errors).

    Chaos (latency spikes, packet loss, pod restarts) is injected at the
    Kubernetes network layer by Chaos Mesh.  This function does NOT add
    synthetic delays — it measures whatever the network delivers.
    """
    times: List[float] = []
    errors: int = 0

    for _ in range(n):
        try:
            t0 = time.perf_counter()
            resp = requests.get(url, timeout=TIMEOUT_S)
            elapsed = (time.perf_counter() - t0) * 1000.0
            times.append(elapsed)
            if resp.status_code >= 500:
                errors += 1
        except requests.exceptions.Timeout:
            errors += 1
            times.append(ERROR_MS)
        except Exception:
            errors += 1
            times.append(ERROR_MS)

    return times, errors


# ── Evaluation ───────────────────────────────────────────────────────────────

def evaluate(chaos_mode: str = "none", n_samples: int = SAMPLES) -> Dict[str, Any]:
    """
    Probe all three service variants, compute statistics, and return a
    structured result dict that pipeline.py can persist and push.

    Metrics returned:
      baseline_avg / canary_avg  — mean latency (ms)
      noise                      — A1 vs A2 mean diff (environment stability)
      degradation                — canary vs baseline mean delta (regression signal)
      baseline_std / canary_std  — standard deviation
      p95_baseline / p95_canary  — P95 latency (excl. timeout sentinels)
      p99_baseline / p99_canary  — P99 latency
      confidence                 — Mann-Whitney U one-sided confidence (%)
      cohens_d                   — standardised effect size
      error_rate                 — canary HTTP 5xx / timeout rate (%)
      status                     — PASS | FAIL | CRITICAL FAIL | INCONCLUSIVE
    """
    t_start = time.perf_counter()
    print(f"\n[judge] chaos={chaos_mode} | samples={n_samples}")

    urls = get_service_urls()

    print("[judge] Probing baseline-1 ...")
    b1_times, b1_err = probe(urls["baseline1"], n=n_samples)

    print("[judge] Probing baseline-2 ...")
    b2_times, b2_err = probe(urls["baseline2"], n=n_samples)

    print("[judge] Probing canary ...")
    c_times, c_err   = probe(urls["canary"], n=n_samples)

    # ── Core statistics ──────────────────────────────────────────────────────
    b1_avg = statistics.mean(b1_times)
    b2_avg = statistics.mean(b2_times)
    c_avg  = statistics.mean(c_times)

    baseline_avg = (b1_avg + b2_avg) / 2.0
    noise        = abs(b1_avg - b2_avg)
    degradation  = max(0.0, c_avg - baseline_avg)
    error_rate   = (c_err / n_samples) * 100.0

    all_baseline = b1_times + b2_times
    b_std = statistics.stdev(all_baseline) if len(all_baseline) > 1 else 0.0
    c_std = statistics.stdev(c_times)      if len(c_times) > 1      else 0.0

    # ── Percentiles (exclude ERROR_MS sentinel values) ───────────────────────
    valid_b = [v for v in all_baseline if v < ERROR_MS]
    valid_c = [v for v in c_times      if v < ERROR_MS]

    p95_baseline = _pct(valid_b, 95)
    p99_baseline = _pct(valid_b, 99)
    p95_canary   = _pct(valid_c, 95)
    p99_canary   = _pct(valid_c, 99)

    # ── Statistical measures ─────────────────────────────────────────────────
    confidence = _confidence(all_baseline, c_times)
    cohens_d   = _cohens_d(all_baseline, c_times)

    # ── Decision ─────────────────────────────────────────────────────────────
    if noise > NOISE_FAIL_MS:
        status = "INCONCLUSIVE"
        reason = (
            f"Baseline noise too high — A1 vs A2 differ by {noise:.0f}ms. "
            "Environment unstable; rerun once cluster settles."
        )
    elif error_rate > ERROR_RATE_FAIL_PCT or degradation > DEGRADATION_CRIT_MS:
        status = "CRITICAL FAIL"
        reason = (
            f"Severe regression. Error rate: {error_rate:.1f}%, "
            f"mean degradation: {degradation:.0f}ms (Cohen's d = {cohens_d:.2f})."
        )
    elif degradation > DEGRADATION_FAIL_MS or c_std > CANARY_STD_FAIL_MS:
        status = "FAIL"
        reason = (
            f"Unacceptable canary regression — mean +{degradation:.0f}ms above baseline "
            f"(P95 delta: +{max(0.0, p95_canary - p95_baseline):.0f}ms, "
            f"σ={c_std:.0f}ms, Cohen's d = {cohens_d:.2f})."
        )
    else:
        status = "PASS"
        reason = (
            f"Canary within acceptable bounds. "
            f"Mean +{degradation:.0f}ms, P95 +{max(0.0, p95_canary - p95_baseline):.0f}ms, "
            f"error rate {error_rate:.1f}%, Cohen's d = {cohens_d:.2f}."
        )

    eval_seconds = round(time.perf_counter() - t_start, 2)

    return {
        # Identity
        "timestamp":      time.strftime("%Y-%m-%dT%H:%M:%S"),
        "chaos_mode":     chaos_mode,
        "n_samples":      n_samples,
        "eval_seconds":   eval_seconds,
        # Means
        "baseline_avg":   round(baseline_avg, 2),
        "canary_avg":     round(c_avg, 2),
        # Spread / noise
        "noise":          round(noise, 2),
        "degradation":    round(degradation, 2),
        "baseline_std":   round(b_std, 2),
        "canary_std":     round(c_std, 2),
        # Percentiles
        "p95_baseline":   round(p95_baseline, 2),
        "p99_baseline":   round(p99_baseline, 2),
        "p95_canary":     round(p95_canary, 2),
        "p99_canary":     round(p99_canary, 2),
        # Statistical measures
        "error_rate":     round(error_rate, 2),
        "confidence":     confidence,
        "cohens_d":       cohens_d,
        # Decision
        "status":         status,
        "reason":         reason,
        # Raw samples for dashboard sparklines
        "b1_samples":     [round(x, 2) for x in b1_times],
        "b2_samples":     [round(x, 2) for x in b2_times],
        "canary_samples": [round(x, 2) for x in c_times],
    }
