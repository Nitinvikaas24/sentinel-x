"""
Sentinel-X v4.2 Pipeline

Run from the sentinel-x-v4 folder:
    py pipeline.py --chaos none
    py pipeline.py --chaos latency
    py pipeline.py --chaos packetloss
    py pipeline.py --chaos combined
    py pipeline.py --chaos latency --samples 30    # more samples for higher confidence
    py pipeline.py --chaos latency --retry 3       # max retry attempts on non-PASS

To push results to your live dashboard:
    set SENTINEL_API=https://your-render-url.onrender.com      (Windows CMD)
    $env:SENTINEL_API="https://your-render-url.onrender.com"   (PowerShell)
    export SENTINEL_API="https://your-render-url.onrender.com" (Linux/macOS)

Optional API key auth (if SENTINEL_API_KEY is set on the server):
    set SENTINEL_API_KEY=your-key-here

Webhook notifications on FAIL/CRITICAL FAIL:
    Configure webhook_url in sentinelx.yaml → notifications
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from judge.judge import evaluate

ROOT        = Path(__file__).parent
RESULTS_DIR = ROOT / "results"
K8S_DIR     = ROOT / "k8s"
CHAOS_DIR   = K8S_DIR / "chaos"

API_URL = os.environ.get("SENTINEL_API", "").rstrip("/")
API_KEY = os.environ.get("SENTINEL_API_KEY", "")

CHAOS_PARAMS = {
    "none":       {"delay": 0,   "loss": 0},
    "latency":    {"delay": 200, "loss": 0},
    "packetloss": {"delay": 0,   "loss": 10},
    "combined":   {"delay": 300, "loss": 10},
}


# ── Config loading ────────────────────────────────────────────────────────────

def _load_config() -> dict:
    """Load sentinelx.yaml from the project root; return empty dict on failure."""
    yaml_path = ROOT / "sentinelx.yaml"
    if yaml_path.exists():
        try:
            import yaml
            with open(yaml_path) as fh:
                return yaml.safe_load(fh) or {}
        except Exception as exc:
            print(f"[pipeline] Warning: could not load sentinelx.yaml: {exc}")
    return {}


_cfg        = _load_config()
_ev_cfg     = _cfg.get("evaluation",   {})
_chaos_cfg  = _cfg.get("chaos",        {})
_notif_cfg  = _cfg.get("notifications", {})

DEFAULT_SAMPLES        = int(_ev_cfg.get("samples",              20))
DEFAULT_RETRY_MAX      = int(_ev_cfg.get("retry_max",             2))
DEFAULT_RETRY_BACKOFF  = int(_ev_cfg.get("retry_backoff_base_s", 10))
STABILISE_WAIT_S       = int(_chaos_cfg.get("stabilise_wait_s",  15))
WEBHOOK_URL            = _notif_cfg.get("webhook_url",           "")
WEBHOOK_ON             = _notif_cfg.get("webhook_on",            ["FAIL", "CRITICAL FAIL"])
WEBHOOK_TIMEOUT_S      = int(_notif_cfg.get("webhook_timeout_s", 10))


# ── Formatting ────────────────────────────────────────────────────────────────

def ts() -> str:
    return time.strftime("[%H:%M:%S]")


def banner(profile: str, samples: int, retry_max: int) -> None:
    print("\n╔══════════════════════════════════════════════╗")
    print("║        SENTINEL-X v4.2  PIPELINE             ║")
    print("╚══════════════════════════════════════════════╝")
    print(f"  Profile  : {profile}")
    print(f"  Samples  : {samples} per service")
    print(f"  Retries  : {retry_max}")
    print(f"  API      : {API_URL or 'local only'}")
    print(f"  Webhook  : {WEBHOOK_URL or 'disabled'}\n")


def step(n: int, total: int, title: str) -> None:
    print(f"\n{'─' * 48}\n  [{n}/{total}] {title}\n{'─' * 48}")


def run_cmd(cmd: list) -> subprocess.CompletedProcess:
    print(f"{ts()} $ {' '.join(str(c) for c in cmd)}")
    return subprocess.run(cmd)


# ── Webhook notification ──────────────────────────────────────────────────────

def _send_webhook(url: str, payload: dict, timeout: int = WEBHOOK_TIMEOUT_S) -> None:
    """POST the full result JSON to the configured webhook URL."""
    if not url:
        return
    try:
        import requests as req
        resp = req.post(url, json=payload, timeout=timeout,
                        headers={"Content-Type": "application/json"})
        print(f"{ts()}  ✔ Webhook delivered: HTTP {resp.status_code} → {url}")
    except Exception as exc:
        print(f"{ts()}  ⚠ Webhook delivery failed: {exc}")


# ── Pipeline stages ───────────────────────────────────────────────────────────

def deploy() -> None:
    step(1, 5, "Deploying A/A/B workloads")
    r = run_cmd(["kubectl", "apply", "-f", str(K8S_DIR / "apps.yaml"), "--validate=false"])
    if r.returncode != 0:
        print(f"{ts()} ✘ Deploy failed"); sys.exit(1)
    for dep in ["app-baseline-1", "app-baseline-2", "app-canary"]:
        run_cmd(["kubectl", "rollout", "status", f"deployment/{dep}", "--timeout=90s"])
    print(f"\n{ts()} ✔ All pods running")
    time.sleep(2)


def inject_chaos(profile: str) -> None:
    step(2, 5, f"Chaos injection: {profile}")
    if profile == "none":
        print(f"  {ts()} Skipping — clean run"); return
    r = run_cmd(["kubectl", "apply", "-f", str(CHAOS_DIR / f"{profile}.yaml")])
    if r.returncode != 0:
        print(f"{ts()} ✘ Chaos injection failed"); sys.exit(1)
    print(f"{ts()} ✔ Chaos applied — stabilising {STABILISE_WAIT_S}s...")
    time.sleep(STABILISE_WAIT_S)


def verify_chaos(profile: str) -> None:
    if profile == "none":
        return
    step(3, 5, "Verifying chaos resources")
    r = subprocess.run(["kubectl", "get", "networkchaos"], capture_output=True, text=True)
    print(r.stdout or "  (none)")


def open_tunnels() -> tuple[dict, dict]:
    """Open minikube service tunnels, return (proc_map, url_map)."""
    print(f"\n{ts()}  Opening minikube service tunnels...")
    tunnels: dict = {}
    urls: dict    = {}
    for svc, key in [
        ("svc-baseline-1", "baseline1"),
        ("svc-baseline-2", "baseline2"),
        ("svc-canary",     "canary"),
    ]:
        proc = subprocess.Popen(
            ["minikube", "service", svc, "--url"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        url = ""
        for line in proc.stdout:
            line = line.strip()
            if line.startswith("http"):
                url = line; break
        if not url:
            print(f"  {ts()} ✘ Could not get URL for {svc}"); sys.exit(1)
        tunnels[key] = proc
        urls[key]    = url
        print(f"  {ts()} {svc} → {url}")
    return tunnels, urls


def evaluate_with_retries(profile: str, samples: int, retry_max: int) -> dict:
    step(4, 5, "Running evaluation engine")
    RESULTS_DIR.mkdir(exist_ok=True)

    tunnels, urls = open_tunnels()
    os.environ["URL_BASELINE1"] = urls["baseline1"]
    os.environ["URL_BASELINE2"] = urls["baseline2"]
    os.environ["URL_CANARY"]    = urls["canary"]

    attempt      = 0
    final_result = None

    try:
        while attempt <= retry_max:
            print(f"\n{ts()}  Attempt {attempt + 1} of {retry_max + 1}")
            result = evaluate(chaos_mode=profile, n_samples=samples)
            print(json.dumps(result, indent=2))

            with open(RESULTS_DIR / f"run_attempt_{attempt}.json", "w") as f:
                json.dump(result, f, indent=2)

            final_result = result
            if result["status"] == "PASS":
                break

            attempt += 1
            if attempt <= retry_max:
                backoff = min(DEFAULT_RETRY_BACKOFF * (2 ** (attempt - 1)), 60)
                print(f"\n{ts()}  Retrying in {backoff}s (exponential backoff)...")
                time.sleep(backoff)
    finally:
        for proc in tunnels.values():
            proc.terminate()

    # Persist results
    with open(RESULTS_DIR / "latest.json", "w") as f:
        json.dump(final_result, f, indent=2)
    with open(RESULTS_DIR / f"run_{int(time.time())}.json", "w") as f:
        json.dump(final_result, f, indent=2)

    # Push to live API dashboard
    if API_URL:
        try:
            import requests as req
            headers = {"Content-Type": "application/json"}
            if API_KEY:
                headers["X-API-Key"] = API_KEY
            resp = req.post(f"{API_URL}/api/push", json=final_result,
                            headers=headers, timeout=10)
            if resp.status_code == 200:
                run_id = resp.json().get("id", "?")
                print(f"\n{ts()}  ✔ Results synced → {API_URL}  (run #{run_id})")
            elif resp.status_code == 401:
                print(f"\n{ts()}  ⚠ Push rejected: 401 Unauthorized — check SENTINEL_API_KEY")
            else:
                print(f"\n{ts()}  ⚠ Push failed: HTTP {resp.status_code}")
        except Exception as exc:
            print(f"\n{ts()}  ⚠ Push error: {exc}")
    else:
        print(f"\n{ts()}  Results saved locally. Set SENTINEL_API to push online.")

    # Webhook notification on FAIL / CRITICAL FAIL
    if final_result:
        status = final_result.get("status", "")
        if WEBHOOK_URL and status in WEBHOOK_ON:
            print(f"\n{ts()}  Sending webhook notification for status={status} ...")
            _send_webhook(WEBHOOK_URL, final_result)

    return final_result


def decide(result: dict, profile: str) -> None:
    step(5, 5, f"FINAL DECISION: {result['status']}")

    if profile != "none":
        print(f"  {ts()} Removing chaos...")
        run_cmd(["kubectl", "delete", "-f", str(CHAOS_DIR / f"{profile}.yaml"), "--ignore-not-found=true"])
        print(f"  {ts()} ✔ Chaos removed")

    p95_delta = max(0, result.get("p95_canary", 0) - result.get("p95_baseline", 0))
    p99_delta = max(0, result.get("p99_canary", 0) - result.get("p99_baseline", 0))

    print(f"\n  Status      : {result['status']}")
    print(f"  Reason      : {result['reason']}")
    print(f"  Confidence  : {result['confidence']}%  (Mann-Whitney U)")
    print(f"  Cohen's d   : {result.get('cohens_d', 'n/a')}  (effect size)")
    print(f"  Noise       : {result['noise']}ms")
    print(f"  Degrad (μ)  : {result['degradation']}ms")
    print(f"  P95 delta   : +{p95_delta:.1f}ms")
    print(f"  P99 delta   : +{p99_delta:.1f}ms")
    print(f"  Error rate  : {result['error_rate']}%")
    print(f"  Eval time   : {result.get('eval_seconds', '?')}s\n")

    if "FAIL" in result["status"]:
        print(f"{ts()} ✘ ROLLING BACK canary")
        run_cmd(["kubectl", "apply", "-f", str(K8S_DIR / "apps.yaml"), "--validate=false"])
        print(f"{ts()} ✔ Canary restored\n")
        sys.exit(1)
    elif result["status"] == "INCONCLUSIVE":
        print(f"{ts()} ⚠ INCONCLUSIVE — manual review needed\n"); sys.exit(2)
    else:
        print(f"{ts()} ✔ PROMOTED — canary is stable\n"); sys.exit(0)


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Sentinel-X v4.2 Pipeline")
    parser.add_argument("--chaos",   default="none",
                        choices=["none", "latency", "packetloss", "combined"],
                        help="Chaos profile to inject (default: none)")
    parser.add_argument("--samples", type=int, default=DEFAULT_SAMPLES,
                        help=f"Probe samples per service (default: {DEFAULT_SAMPLES})")
    parser.add_argument("--retry",   type=int, default=DEFAULT_RETRY_MAX,
                        help=f"Max retry attempts on non-PASS (default: {DEFAULT_RETRY_MAX})")
    args = parser.parse_args()

    banner(args.chaos, args.samples, args.retry)
    deploy()
    inject_chaos(args.chaos)
    verify_chaos(args.chaos)
    result = evaluate_with_retries(args.chaos, args.samples, args.retry)
    decide(result, args.chaos)


if __name__ == "__main__":
    main()
