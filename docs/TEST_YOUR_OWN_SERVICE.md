# Test your own service

Sentinel-X can test code you upload, not just the built-in nginx demo.

```
Browser (Vercel)  ──zip──▶  API (Render)  ◀──poll──  Runner (your machine)
                              job queue                  │
                              results  ◀──verdict────────┤
                                                         ▼
                                      minikube: build → 3 pods → chaos → judge
```

The cloud never reaches into your cluster. A small **runner** on the machine
that has minikube polls the API for work, runs it, and posts the verdict back.

## What to upload

A `.zip` with a **Dockerfile at the top level** (or inside one top-level folder).
The service must listen on one TCP port (default `8080`) and answer HTTP GET on a
health path (default `/`).

Optional second zip: your **current production version**. That becomes the
baseline, so the verdict answers "is the new version worse than what's live?".
Without it, the canary is compared with an unmodified copy of itself, which tests
how it behaves under chaos.

Limits: 25 MB per zip, 2000 files, 150 MB unzipped, no symlinks or `..` paths.

## Run it locally

```powershell
# 1. API
$env:SENTINEL_RUNNER_KEY = "pick-a-long-random-string"
py dashboard/backend/app.py                       # http://localhost:5000

# 2. Dashboard
cd dashboard/frontend
$env:VITE_API_URL = "http://localhost:5000"
npm run dev

# 3. Runner (needs Docker Desktop + minikube + Chaos Mesh)
minikube start
$env:SENTINEL_API = "http://localhost:5000"
$env:SENTINEL_RUNNER_KEY = "pick-a-long-random-string"
py runner/agent.py
```

Open the dashboard, find **Test your own service**, upload a zip, or press
**Healthy release** / **Regressed release** for a demo.

## Demo script (about 3 minutes)

1. Show the page with the runner online.
2. Press **Healthy release**. Wait for **PASS** (about 90 s on a first build).
3. Press **Regressed release**. It is the same code with a 150 ms delay, compared
   with the healthy version as baseline. Wait for **FAIL** at roughly +150 ms.
4. Upload `dashboard/backend/samples/good-service.zip` yourself with **Latency**
   chaos. The service is healthy, but chaos slows it, so the gate rejects it.
   That is the "does it survive failure" story.
5. Point at the latency chart (hover for per-request values) and *Why this decision*.

The sample sources are in `samples/`. Rebuild the zips with `py scripts/make_samples.py`.

## Configuration (API environment variables)

| Variable | Purpose |
|---|---|
| `SENTINEL_RUNNER_KEY` | **Required.** Shared secret the runner sends. Runner endpoints refuse to work without it. |
| `SENTINEL_UPLOAD_KEY` | Optional. If set, uploads need this value as the *Access key* in the form. Recommended for any public deployment. |
| `SENTINEL_API_KEY` | Optional. Protects `/api/push`. |
| `JOBS_DIR` | Where uploaded zips are stored until tested (deleted afterwards). |

## Security model: read before exposing this publicly

Building a Dockerfile **runs uploaded code**. What is in place:

- Builds happen inside minikube's Docker daemon, not on the host.
- Zip extraction rejects path traversal, symlinks, oversized and over-numerous files.
- Pods run in a throwaway namespace with CPU/memory limits, no service-account
  token, dropped Linux capabilities and a NetworkPolicy that blocks egress
  (enforced only if your minikube CNI supports NetworkPolicy).
- Chaos, the namespace, the images and temp files are removed after every job.
- Queue is capped at 5 waiting jobs.

What is **not** solved: a malicious Dockerfile could still abuse the build
(CPU, disk, network during `RUN` steps). Treat this as suitable for
you and people you trust, behind `SENTINEL_UPLOAD_KEY`. For untrusted public users you
would add a dedicated build cluster, per-user quotas and an allow-list of base images.

## Known limits

- One job at a time. The runner is sequential.
- The API stores jobs in SQLite on the Render free tier's ephemeral disk, so the
  queue and history reset when the service redeploys.
- HTTP services only, probed with GET.
- **Packet-loss chaos is unverified.** In testing, latency chaos clearly slowed the canary, but a 10% packet-loss run showed no measurable effect. Use latency for demos until this is investigated.
