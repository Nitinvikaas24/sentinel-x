"""
Sentinel-X runner agent.

Runs on a machine that has Docker + minikube + Chaos Mesh. It polls the
Sentinel-X API for queued "bring your own service" jobs, and for each one:

    1. downloads the uploaded zip(s) and extracts them safely
    2. builds the image(s) inside minikube
    3. deploys baseline-1, baseline-2 and canary into a throwaway namespace
    4. injects the chosen chaos profile into the canary only
    5. probes all three, runs the judge, posts the result back
    6. deletes the namespace, images and temp files

Usage (from the project root):
    $env:SENTINEL_API        = "http://localhost:5055"
    $env:SENTINEL_RUNNER_KEY = "<same value the API was started with>"
    py runner/agent.py

Safety notes
  * Building a Dockerfile executes uploaded code. The build runs inside
    minikube's Docker daemon, never on the host, but only enable this for
    people you trust. The zip itself is size/path/symlink checked first.
  * Pods get CPU/memory limits, no service-account token, dropped
    capabilities, and a NetworkPolicy that blocks all egress.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from judge.judge import evaluate  # noqa: E402

API = os.environ.get("SENTINEL_API", "").rstrip("/")
KEY = os.environ.get("SENTINEL_RUNNER_KEY", "")
POLL_S = float(os.environ.get("RUNNER_POLL_S", "3"))
SAMPLES = int(os.environ.get("RUNNER_SAMPLES", "20"))

BUILD_TIMEOUT_S = 600
ROLLOUT_TIMEOUT = "120s"
STABILISE_S = 15
MAX_FILES = 2000
MAX_UNZIPPED_BYTES = 150 * 1024 * 1024

CHAOS = {
    "latency":    [("delay", {"latency": "200ms", "correlation": "25", "jitter": "20ms"})],
    "packetloss": [("loss",  {"loss": "10", "correlation": "25"})],
    "combined":   [("delay", {"latency": "300ms", "correlation": "50", "jitter": "50ms"}),
                   ("loss",  {"loss": "10", "correlation": "25"})],
}

HEADERS = {"X-Runner-Key": KEY}


class JobError(Exception):
    """A problem with the uploaded service (bad zip, build failure, crash)."""


# ── API helpers ───────────────────────────────────────────────────────────────

def api(method: str, path: str, **kw):
    return requests.request(method, f"{API}{path}", headers=HEADERS, timeout=30, **kw)


def update(job_id: int, status: str | None = None, log: str | None = None, error: str | None = None) -> None:
    if log:
        print(f"[job {job_id}] {log}")
    try:
        api("POST", f"/api/runner/jobs/{job_id}/update", json={"status": status, "log": log, "error": error})
    except requests.RequestException as exc:
        print(f"[job {job_id}] could not report progress: {exc}")


def run(cmd: list[str], timeout: int = 120, check: bool = True) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise JobError(f"`{' '.join(cmd[:3])}` failed: {(r.stderr or r.stdout).strip()[-600:]}")
    return r


# ── Safe zip extraction ───────────────────────────────────────────────────────

def safe_extract(zip_path: Path, dest: Path) -> Path:
    """Extract *zip_path* into *dest*, rejecting path traversal, symlinks and zip bombs.
    Returns the directory that contains the Dockerfile."""
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    with zipfile.ZipFile(zip_path) as z:
        infos = z.infolist()
        if len(infos) > MAX_FILES:
            raise JobError(f"zip has too many files ({len(infos)} > {MAX_FILES})")
        if sum(i.file_size for i in infos) > MAX_UNZIPPED_BYTES:
            raise JobError("zip expands to more than 150 MB")
        for info in infos:
            target = (dest / info.filename).resolve()
            if root != target and root not in target.parents:
                raise JobError(f"unsafe path in zip: {info.filename}")
            if stat.S_ISLNK(info.external_attr >> 16):
                raise JobError(f"symlinks are not allowed in uploads: {info.filename}")
        z.extractall(dest)

    if (dest / "Dockerfile").is_file():
        return dest
    children = [p for p in dest.iterdir() if p.is_dir()]
    if len(children) == 1 and (children[0] / "Dockerfile").is_file():
        return children[0]
    raise JobError("no Dockerfile found at the top level of the zip")


# ── Kubernetes manifests ──────────────────────────────────────────────────────

def manifests(ns: str, port: int, canary_img: str, baseline_img: str) -> str:
    docs = [f"apiVersion: v1\nkind: Namespace\nmetadata:\n  name: {ns}\n"]
    for key, name, image in (("baseline1", "baseline-1", baseline_img),
                             ("baseline2", "baseline-2", baseline_img),
                             ("canary",    "canary",     canary_img)):
        docs.append(f"""apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-{name}
  namespace: {ns}
spec:
  replicas: 1
  selector:
    matchLabels: {{app: sentinel, version: {key}}}
  template:
    metadata:
      labels: {{app: sentinel, version: {key}}}
    spec:
      automountServiceAccountToken: false
      containers:
      - name: app
        image: {image}
        imagePullPolicy: Never
        ports:
        - containerPort: {port}
        resources:
          requests: {{cpu: 50m, memory: 64Mi}}
          limits: {{cpu: 500m, memory: 256Mi}}
        securityContext:
          allowPrivilegeEscalation: false
          capabilities: {{drop: [ALL]}}
---
apiVersion: v1
kind: Service
metadata:
  name: svc-{name}
  namespace: {ns}
spec:
  type: NodePort
  selector: {{app: sentinel, version: {key}}}
  ports:
  - port: {port}
    targetPort: {port}
""")
    docs.append(f"""apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-egress
  namespace: {ns}
spec:
  podSelector: {{}}
  policyTypes: [Egress]
""")
    return "---\n".join(docs)


def chaos_yaml(ns: str, profile: str) -> str:
    docs = []
    for i, (action, params) in enumerate(CHAOS[profile]):
        body = "\n".join(f'    {k}: "{v}"' for k, v in params.items())
        docs.append(f"""apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: sx-canary-{action}-{i}
  namespace: {ns}
spec:
  action: {action}
  mode: all
  selector:
    namespaces: [{ns}]
    labelSelectors:
      version: canary
  {action}:
{body}
  duration: "300s"
""")
    return "---\n".join(docs)


def kubectl_apply(yaml_text: str) -> None:
    r = subprocess.run(["kubectl", "apply", "-f", "-"], input=yaml_text, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise JobError(f"kubectl apply failed: {r.stderr.strip()[-500:]}")


# ── Service access ────────────────────────────────────────────────────────────

def open_tunnels(ns: str) -> tuple[dict, dict]:
    tunnels, urls = {}, {}
    for svc, key in (("svc-baseline-1", "baseline1"), ("svc-baseline-2", "baseline2"), ("svc-canary", "canary")):
        proc = subprocess.Popen(["minikube", "service", svc, "-n", ns, "--url"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        url = ""
        for line in proc.stdout:
            if line.strip().startswith("http"):
                url = line.strip()
                break
        if not url:
            raise JobError(f"could not open a tunnel to {svc}")
        tunnels[key], urls[key] = proc, url
    return tunnels, urls


def wait_healthy(url: str, timeout_s: int = 60) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if requests.get(url, timeout=5).status_code < 500:
                return
        except requests.RequestException:
            pass
        time.sleep(2)
    raise JobError(f"service never became healthy at {url}")


# ── Job lifecycle ─────────────────────────────────────────────────────────────

def teardown_namespace(ns: str) -> None:
    """Remove chaos first (while the pods still exist so Chaos Mesh can undo its
    network rules), then delete the namespace. If a chaos object gets stuck on its
    finalizer, clear it so the namespace cannot hang forever."""
    subprocess.run(["kubectl", "delete", "networkchaos", "--all", "-n", ns, "--wait=true", "--timeout=40s",
                    "--ignore-not-found=true"], capture_output=True, timeout=90)
    stuck = subprocess.run(["kubectl", "get", "networkchaos", "-n", ns, "-o", "name"],
                           capture_output=True, text=True, timeout=30).stdout.split()
    for name in stuck:
        subprocess.run(["kubectl", "patch", name, "-n", ns, "--type=merge", "-p", '{"metadata":{"finalizers":[]}}'],
                       capture_output=True, timeout=30)
    subprocess.run(["kubectl", "delete", "namespace", ns, "--wait=false", "--ignore-not-found=true"],
                   capture_output=True, timeout=60)


def process(job: dict) -> None:
    jid, ns = job["id"], f"sx-job-{job['id']}"
    work = Path(tempfile.mkdtemp(prefix=f"sx-job-{jid}-"))
    images, tunnels = [], {}
    try:
        # 1 — download + extract
        update(jid, "building", f"Starting test: {job['name']} (chaos: {job['chaos_mode']})")
        ctx = {}
        for role in ("canary", "baseline"):
            if role == "baseline" and not job["has_baseline"]:
                continue
            r = api("GET", f"/api/runner/jobs/{jid}/artifact/{role}")
            if r.status_code != 200:
                raise JobError(f"could not download the {role} zip")
            zp = work / f"{role}.zip"
            zp.write_bytes(r.content)
            ctx[role] = safe_extract(zp, work / role)
            update(jid, log=f"Unpacked {role} upload")

        # 2 — build inside minikube
        tags = {}
        for role, path in ctx.items():
            tag = f"sx-{role}-{jid}:latest"
            update(jid, log=f"Building {role} image (first build can take a minute)…")
            run(["minikube", "image", "build", "-t", tag, str(path)], timeout=BUILD_TIMEOUT_S)
            tags[role] = tag
            images.append(tag)
        canary_img = tags["canary"]
        baseline_img = tags.get("baseline", canary_img)
        if "baseline" not in tags:
            update(jid, log="No baseline uploaded — comparing the canary against an unmodified copy of itself")

        # 3 — deploy
        update(jid, "deploying", f"Deploying three pods in namespace {ns}")
        kubectl_apply(manifests(ns, job["port"], canary_img, baseline_img))
        for dep in ("app-baseline-1", "app-baseline-2", "app-canary"):
            r = run(["kubectl", "rollout", "status", f"deployment/{dep}", "-n", ns, f"--timeout={ROLLOUT_TIMEOUT}"],
                    timeout=180, check=False)
            if r.returncode != 0:
                logs = run(["kubectl", "logs", f"deployment/{dep}", "-n", ns, "--tail=15"], check=False).stdout
                raise JobError(f"{dep} did not start. Last log lines: {logs.strip()[-400:] or '(none)'}")
        update(jid, log="All pods are running")

        # 4 — chaos
        update(jid, "injecting")
        if job["chaos_mode"] != "none":
            kubectl_apply(chaos_yaml(ns, job["chaos_mode"]))
            update(jid, log=f"Injected '{job['chaos_mode']}' into the canary; letting it settle for {STABILISE_S}s")
            time.sleep(STABILISE_S)
        else:
            update(jid, log="Clean run: no chaos injected")

        # 5 — evaluate
        update(jid, "evaluating", "Opening tunnels and probing all three services")
        tunnels, urls = open_tunnels(ns)
        health = job["health"] if job["health"].startswith("/") else "/" + job["health"]
        full = {k: u.rstrip("/") + health for k, u in urls.items()}
        for k in ("baseline1", "baseline2"):
            wait_healthy(full[k])
        wait_healthy(full["canary"], timeout_s=90)
        os.environ.update(URL_BASELINE1=full["baseline1"], URL_BASELINE2=full["baseline2"], URL_CANARY=full["canary"])
        result = evaluate(chaos_mode=job["chaos_mode"], n_samples=SAMPLES)
        update(jid, log=f"Verdict: {result['status']} — {result['reason']}")

        r = api("POST", f"/api/runner/jobs/{jid}/complete", json=result)
        if r.status_code != 200:
            raise JobError(f"could not save the result: HTTP {r.status_code}")

    except JobError as exc:
        update(jid, "failed", log=f"Failed: {exc}", error=str(exc))
    except Exception as exc:  # unexpected runner problem — still report it
        update(jid, "failed", log=f"Runner error: {exc}", error=f"runner error: {exc}")
    finally:
        for p in tunnels.values():
            p.terminate()
        teardown_namespace(ns)
        for tag in images:
            subprocess.run(["minikube", "image", "rm", f"docker.io/library/{tag}"], capture_output=True, timeout=60)
        shutil.rmtree(work, ignore_errors=True)
        print(f"[job {jid}] cleaned up")


def main() -> None:
    if not API or not KEY:
        sys.exit("Set SENTINEL_API and SENTINEL_RUNNER_KEY first (see the docstring at the top of this file).")
    print(f"Sentinel-X runner polling {API} every {POLL_S:.0f}s — Ctrl+C to stop")
    while True:
        try:
            r = api("POST", "/api/runner/claim")
            if r.status_code == 401:
                sys.exit("The API rejected the runner key.")
            if r.status_code == 503:
                sys.exit("The API has no SENTINEL_RUNNER_KEY configured.")
            job = r.json().get("job") if r.ok else None
        except requests.RequestException as exc:
            print(f"API unreachable ({exc}); retrying")
            job = None
        if job:
            process(job)
        else:
            time.sleep(POLL_S)


if __name__ == "__main__":
    main()
