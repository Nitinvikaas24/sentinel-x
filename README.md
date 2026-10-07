# Sentinel-X v4 — Autonomous Chaos-Based Resilience Validation Gate

> Does your app survive failure? Sentinel-X finds out before production does.

---

## Architecture

```
Your Machine (Minikube + Chaos Mesh)         Internet (Free)
────────────────────────────────────         ───────────────────
py pipeline.py --chaos latency          →    POST /api/push
       │                                          │
       ├── kubectl apply apps.yaml          Flask API (Render)
       ├── kubectl apply chaos/latency.yaml       │
       ├── minikube service --url (tunnel)   SQLite DB
       ├── judge/judge.py (probes)                │
       │     A1 · A2 · Canary              React UI (Vercel)
       │     stats · decision              (live public URL)
       └── promote / rollback
```

## Chaos Profiles

| Profile      | Fault                    | Expected   |
|--------------|--------------------------|------------|
| `none`       | Clean run                | PASS       |
| `latency`    | +200ms on canary         | FAIL       |
| `packetloss` | 10% packet drop          | FAIL       |
| `combined`   | +300ms + 10% loss        | CRITICAL FAIL |

---

## Run Locally

```bash
# Install deps
pip install requests flask flask-cors

# Deploy to minikube
kubectl apply -f k8s/apps.yaml

# Run scenarios
py pipeline.py --chaos none
py pipeline.py --chaos latency
py pipeline.py --chaos packetloss
py pipeline.py --chaos combined
```

## Deploy Dashboard Online (Free)

### Backend → Render.com
1. Push repo to GitHub
2. Render → New Web Service → connect repo → it reads `render.yaml` automatically
3. Copy your URL: `https://sentinel-x-api.onrender.com`

### Frontend → Vercel
1. Vercel → New Project → import repo
2. Set root directory: `dashboard/frontend`
3. Add env var: `VITE_API_URL=https://sentinel-x-api.onrender.com`
4. Deploy → get your live URL

### Push results from local machine
```bash
# Windows PowerShell
$env:SENTINEL_API="https://sentinel-x-api.onrender.com"
py pipeline.py --chaos latency
```

---

## Test Your Own Service

Upload a zip with a Dockerfile in the dashboard, or press **Healthy release** /
**Regressed release** for a one-click demo. A runner on your machine builds it in
minikube, injects chaos into the canary, and posts the verdict back.
See [docs/TEST_YOUR_OWN_SERVICE.md](docs/TEST_YOUR_OWN_SERVICE.md) for setup, the demo script and the security model.

---

## Resume Bullet

> Built **Sentinel-X**, an autonomous chaos-driven deployment validation system on Kubernetes (Minikube) using A/A/B canary strategy, Chaos Mesh fault injection, and statistical regression detection — with automated promote/rollback decisions and a live React dashboard on Vercel/Render.
