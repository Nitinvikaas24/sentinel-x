import { useState, useEffect, useCallback } from "react";

const API = import.meta.env.VITE_API_URL || "https://sentinel-x-v4.onrender.com";

/* ── Status config ─────────────────────────────────────────────────────────── */
const STATUS_CFG = {
  "PASS":          { c: "#00ff88", dim: "#00ff8808" },
  "FAIL":          { c: "#ff2244", dim: "#ff224408" },
  "CRITICAL FAIL": { c: "#ff0011", dim: "#ff001112" },
  "INCONCLUSIVE":  { c: "#ffcc00", dim: "#ffcc0008" },
  "NO DATA":       { c: "#2a2a4e", dim: "#2a2a4e08" },
};
const scfg = (s) => STATUS_CFG[s] || STATUS_CFG["NO DATA"];

/* ── Confidence bar ────────────────────────────────────────────────────────── */
function ConfBar({ value = 0, color = "#00ff88", height = 4 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ flex: 1, height, background: "#13131f", border: "1px solid #1c1c2e", overflow: "hidden" }}>
        <div style={{
          width: `${Math.min(value, 100)}%`, height: "100%", background: color,
          boxShadow: `0 0 6px ${color}66`,
          transition: "width 1.1s cubic-bezier(.4,0,.2,1)",
        }} />
      </div>
      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, fontWeight: 700, color, minWidth: 40, textAlign: "right" }}>
        {Math.round(value)}%
      </span>
    </div>
  );
}

/* ── Sparkline ──────────────────────────────────────────────────────────────── */
function Spark({ data = [], color, h = 36, w = 260 }) {
  if (!data.length) return <div style={{ width: w, height: h }} />;
  const valid = data.filter(v => v < 4500);
  if (!valid.length) return (
    <div style={{ width: w, height: h, display: "flex", alignItems: "center" }}>
      <span style={{ color: "#ff2244", fontSize: 10, fontFamily: "'JetBrains Mono',monospace" }}>TIMEOUT ×{data.length}</span>
    </div>
  );
  const mn = Math.min(...valid), mx = Math.max(...valid, mn + 1);
  const pts = data.map((v, i) => {
    const x = data.length < 2 ? w / 2 : (i / (data.length - 1)) * w;
    const y = h - ((Math.min(v, 4500) - mn) / (mx - mn)) * (h - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={w} height={h} style={{ overflow: "visible" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} style={{ filter: `drop-shadow(0 0 3px ${color}88)` }} />
      {data.map((v, i) => {
        const x = data.length < 2 ? w / 2 : (i / (data.length - 1)) * w;
        const y = h - ((Math.min(v, 4500) - mn) / (mx - mn)) * (h - 6) - 3;
        return <circle key={i} cx={x} cy={y} r={1.5} fill={color} opacity={0.65} />;
      })}
    </svg>
  );
}

/* ── Metric card ────────────────────────────────────────────────────────────── */
function MetricCard({ label, value, unit = "", color = "#6a6a9e", note, accentColor }) {
  const accent = accentColor || color;
  return (
    <div style={{
      background: "#0d0d1a", border: "1px solid #1c1c2e",
      borderLeft: `3px solid ${accent}`, boxShadow: "3px 3px 0 0 #000000bb",
      padding: "14px 18px", display: "flex", flexDirection: "column", gap: 6,
    }}>
      <span style={{ fontSize: 9, letterSpacing: 3, color: "#2a2a4e", textTransform: "uppercase", fontFamily: "'Space Grotesk',sans-serif" }}>{label}</span>
      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 22, fontWeight: 700, color, lineHeight: 1 }}>
        {value}<span style={{ fontSize: 11, opacity: 0.45, marginLeft: 2 }}>{unit}</span>
      </span>
      {note && <span style={{ fontSize: 10, color: "#3a3a5e", fontFamily: "'Space Grotesk',sans-serif" }}>{note}</span>}
    </div>
  );
}

/* ── P-latency card ─────────────────────────────────────────────────────────── */
function PLatCard({ label, baseline = 0, canary = 0, statusColor }) {
  const delta = canary - baseline;
  const dColor = delta > 80 ? "#ff2244" : delta > 30 ? "#ffcc00" : "#00ff88";
  return (
    <div style={{
      background: "#0d0d1a", border: "1px solid #1c1c2e",
      borderLeft: `3px solid ${statusColor}`, boxShadow: "3px 3px 0 0 #000000bb", padding: "16px 20px",
    }}>
      <div style={{ fontSize: 9, letterSpacing: 3, color: "#2a2a4e", textTransform: "uppercase", fontFamily: "'Space Grotesk',sans-serif", marginBottom: 12 }}>{label}</div>
      <div style={{ display: "flex", gap: 20, alignItems: "flex-end" }}>
        <div>
          <div style={{ fontSize: 8, letterSpacing: 2, color: "#00aaff66", marginBottom: 4 }}>BASELINE</div>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 20, fontWeight: 700, color: "#00aaff" }}>
            {baseline.toFixed(0)}<span style={{ fontSize: 10, opacity: 0.45 }}>ms</span>
          </span>
        </div>
        <div>
          <div style={{ fontSize: 8, letterSpacing: 2, color: `${statusColor}66`, marginBottom: 4 }}>CANARY</div>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 20, fontWeight: 700, color: statusColor }}>
            {canary.toFixed(0)}<span style={{ fontSize: 10, opacity: 0.45 }}>ms</span>
          </span>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <div style={{ fontSize: 8, letterSpacing: 2, color: `${dColor}66`, marginBottom: 4 }}>Δ</div>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 16, fontWeight: 700, color: dColor }}>
            {delta > 0 ? "+" : ""}{delta.toFixed(0)}ms
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── History row ─────────────────────────────────────────────────────────────── */
function HistRow({ run, isNew }) {
  const c = scfg(run.status);
  const t = (run.timestamp || "").slice(11, 16);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 14px",
      borderLeft: `2px solid ${c.c}`, borderBottom: "1px solid #13131f",
      background: isNew ? "#ffffff05" : "transparent",
      animation: isNew ? "fadeIn .35s ease" : "none",
    }}>
      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#2a2a4e", minWidth: 34 }}>{t}</span>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: c.c, fontFamily: "'Space Grotesk',sans-serif" }}>{run.status}</span>
      <span style={{ fontSize: 9, color: "#2a2a4e", marginLeft: "auto", fontFamily: "'JetBrains Mono',monospace" }}>
        {run.chaos_mode || "—"} · {(run.degradation || 0).toFixed(0)}ms
      </span>
    </div>
  );
}

/* ── Explain section ─────────────────────────────────────────────────────────── */
function Explain({ d }) {
  if (!d || d.status === "NO DATA") return null;
  const cd = d.cohens_d || 0;
  const cdLabel = Math.abs(cd) < 0.2 ? "negligible" : Math.abs(cd) < 0.5 ? "small" : Math.abs(cd) < 0.8 ? "medium" : "large";
  const lines = [
    d.noise < 10 ? { ok: true, text: `Environment stable — baseline noise only ${d.noise?.toFixed(1)}ms.` }
      : d.noise < 50 ? { ok: null, text: `Moderate baseline noise (${d.noise?.toFixed(1)}ms) — results valid but marginal.` }
      : { ok: false, text: `Unstable environment — A1 vs A2 differ by ${d.noise?.toFixed(1)}ms (threshold: 50ms).` },
    d.degradation < 50 ? { ok: true, text: `Mean latency within acceptable range (+${d.degradation?.toFixed(1)}ms).` }
      : d.degradation < 150 ? { ok: null, text: `Measurable latency increase: +${d.degradation?.toFixed(1)}ms above baseline.` }
      : { ok: false, text: `Significant degradation — mean +${d.degradation?.toFixed(1)}ms above baseline.` },
    (() => {
      const p95d = (d.p95_canary || 0) - (d.p95_baseline || 0);
      return p95d < 50
        ? { ok: true,  text: `P95 acceptable: +${p95d.toFixed(1)}ms (${d.p95_baseline?.toFixed(0)} → ${d.p95_canary?.toFixed(0)}ms).` }
        : { ok: false, text: `P95 regression: +${p95d.toFixed(1)}ms (${d.p95_baseline?.toFixed(0)} → ${d.p95_canary?.toFixed(0)}ms).` };
    })(),
    d.error_rate > 5 ? { ok: false, text: `High error rate: ${d.error_rate?.toFixed(1)}% of canary requests failed.` }
      : { ok: true, text: `Error rate nominal: ${d.error_rate?.toFixed(1)}%.` },
    { ok: null, text: `Mann-Whitney U confidence: ${d.confidence}% — probability canary is slower than baseline.` },
    { ok: cd > 0.8 ? false : cd < 0.2 ? true : null, text: `Cohen's d = ${cd.toFixed(3)} (${cdLabel} effect size).` },
    d.status === "PASS" ? { ok: true, text: "→ Safe to promote canary to production." }
      : d.status?.includes("FAIL") ? { ok: false, text: "→ Rollback required. Do not promote." }
      : { ok: null, text: "→ Manual review required before any promotion decision." },
  ];
  const dot = ok => ok === true ? "#00ff88" : ok === false ? "#ff2244" : "#ffcc00";
  return (
    <div style={{ background: "#0d0d1a", border: "1px solid #1c1c2e", borderLeft: "3px solid #1c1c2e", padding: "22px 26px" }}>
      <div style={{ fontSize: 9, letterSpacing: 3, color: "#2a2a4e", textTransform: "uppercase", fontFamily: "'Space Grotesk',sans-serif", marginBottom: 18 }}>
        Decision Audit Trail
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {lines.map((l, i) => (
          <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ width: 5, height: 5, borderRadius: "50%", background: dot(l.ok), boxShadow: `0 0 5px ${dot(l.ok)}88`, marginTop: 7, flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: "#6a6a9e", lineHeight: 1.75, fontFamily: "'Space Grotesk',sans-serif" }}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Skeleton ────────────────────────────────────────────────────────────────── */
function Skel({ w = "100%", h = 18 }) {
  return (
    <div style={{
      width: w, height: h,
      background: "linear-gradient(90deg,#0d0d1a 25%,#1a1a2e 50%,#0d0d1a 75%)",
      backgroundSize: "200% 100%", animation: "shimmer 1.6s ease infinite",
    }} />
  );
}

/* ── Tech chip ───────────────────────────────────────────────────────────────── */
function Chip({ label, color = "#2a2a4e" }) {
  return (
    <span style={{
      fontSize: 9, letterSpacing: 2, padding: "3px 10px",
      border: `1px solid ${color}`, color,
      textTransform: "uppercase", fontFamily: "'JetBrains Mono',monospace",
    }}>{label}</span>
  );
}

/* ── Divider ─────────────────────────────────────────────────────────────────── */
function VDivider() {
  return <div style={{ width: 1, height: 22, background: "#1c1c2e", flexShrink: 0 }} />;
}

/* ══════════════════════════════════════════════════════════════════════════════
   PROJECT INFO BANNER
   ══════════════════════════════════════════════════════════════════════════════ */
function InfoBanner({ connected }) {
  const [open,    setOpen]    = useState(true);
  const [runOpen, setRunOpen] = useState(false);

  return (
    <div style={{ marginBottom: 16 }}>

      {/* ── Header ── */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 20px", cursor: "pointer", userSelect: "none",
          background: "#0d0d1a", border: "1px solid #1c1c2e",
          borderLeft: "3px solid #00aaff",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 9, letterSpacing: 3, color: "#00aaff", textTransform: "uppercase", fontFamily: "'Space Grotesk',sans-serif" }}>
            About This Project
          </span>
          <span style={{ fontSize: 9, letterSpacing: 2, color: "#2a2a4e", fontFamily: "'JetBrains Mono',monospace" }}>
            — Nitin Vikaas
          </span>
        </div>
        <span style={{ fontSize: 10, color: "#2a2a4e", fontFamily: "'JetBrains Mono',monospace" }}>
          {open ? "▲ collapse" : "▼ expand"}
        </span>
      </div>

      {open && (
        <div style={{
          background: "#0a0a14", border: "1px solid #1c1c2e", borderTop: "none",
          borderLeft: "3px solid #00aaff", padding: "26px 28px",
          display: "flex", flexDirection: "column", gap: 22,
        }}>

          {/* ── What is it ── */}
          <div>
            <div style={{ fontSize: 9, letterSpacing: 3, color: "#2a2a4e", textTransform: "uppercase", fontFamily: "'Space Grotesk',sans-serif", marginBottom: 12 }}>
              What Is Sentinel-X?
            </div>
            <p style={{ fontSize: 13, color: "#8a8ab0", lineHeight: 1.9, fontFamily: "'Space Grotesk',sans-serif", margin: "0 0 10px 0", maxWidth: 860 }}>
              A self-built <span style={{ color: "#d4d4f0", fontWeight: 600 }}>chaos engineering and canary deployment gate</span> — designed to solve how companies like Netflix, Google, and Amazon ship code safely without downtime. It deploys three service variants (two stable baselines + one canary), injects real network faults at the Kubernetes kernel level via Chaos Mesh, then uses{" "}
              <span style={{ color: "#d4d4f0", fontWeight: 600 }}>Mann-Whitney U + Cohen's d</span> to make a statistically-backed promote-or-rollback decision automatically.
            </p>
            <p style={{ fontSize: 12, color: "#5a5a7e", lineHeight: 1.8, fontFamily: "'Space Grotesk',sans-serif", margin: 0, maxWidth: 860 }}>
              The A/A/B design — two baselines, not one — is the key differentiator. It measures environment stability before trusting any signal. If the baselines themselves diverge by more than 50ms, the system returns{" "}
              <span style={{ color: "#ffcc00" }}>INCONCLUSIVE</span> rather than a false answer.
            </p>
          </div>

          {/* ── Tech stack ── */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {[
              ["Kubernetes",       "#00aaff"],
              ["Chaos Mesh",       "#ff6622"],
              ["Python",           "#3572a5"],
              ["Flask + SSE",      "#4a4a7e"],
              ["React + Vite",     "#61dafb"],
              ["SQLite WAL",       "#4a4a7e"],
              ["Mann-Whitney U",   "#00ff88"],
              ["Cohen's d",        "#00ff88"],
              ["Prometheus",       "#e6522c"],
              ["GitHub Actions CI","#4a4a7e"],
            ].map(([l, c]) => <Chip key={l} label={l} color={c} />)}
          </div>

          {/* ── Why offline ── */}
          <div style={{
            background: "#13131f", border: "1px solid #ffcc0025",
            borderLeft: "3px solid #ffcc00", padding: "16px 20px",
          }}>
            <div style={{ fontSize: 9, letterSpacing: 3, color: "#ffcc0070", textTransform: "uppercase", fontFamily: "'Space Grotesk',sans-serif", marginBottom: 9 }}>
              Why Is It Not Updating Live?
            </div>
            <p style={{ fontSize: 12, color: "#7a7060", lineHeight: 1.8, fontFamily: "'Space Grotesk',sans-serif", margin: 0, maxWidth: 860 }}>
              The pipeline runs on a <span style={{ color: "#ffcc00", fontWeight: 600 }}>local Kubernetes cluster (minikube)</span> because it injects real network-layer faults — this cannot be replicated on a free cloud VM. The Flask API is live on Render; pipeline results are pushed here after each local run via the <code style={{ color: "#ffcc0070", fontSize: 11 }}>SENTINEL_API</code> env var. This is intentional architecture, not a limitation. SSE status:{" "}
              <span style={{ color: connected ? "#00ff88" : "#ff2244", fontWeight: 600 }}>{connected ? "LIVE" : "OFFLINE"}</span>
              {!connected && <span style={{ color: "#4a4a5e" }}> — pipeline not running locally</span>}.
            </p>
            <div
              onClick={() => setRunOpen(o => !o)}
              style={{ marginTop: 12, cursor: "pointer", fontSize: 10, color: "#4a4a5e", fontFamily: "'JetBrains Mono',monospace", letterSpacing: 1, display: "inline-block" }}
            >
              {runOpen ? "▲" : "▼"} run it locally
            </div>
            {runOpen && (
              <div style={{
                marginTop: 10, padding: "12px 16px",
                background: "#0d0d1a", borderLeft: "2px solid #1c1c2e",
                fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "#4a6a8e", lineHeight: 2.2,
              }}>
                <div style={{ color: "#2a2a4e" }}># prerequisites: Docker Desktop + minikube</div>
                <div>minikube start</div>
                <div>python3.11 pipeline.py --chaos latency</div>
                <div style={{ color: "#2a2a4e" }}># results push to this dashboard in real time</div>
              </div>
            )}
          </div>

          {/* ── Pipeline flow ── */}
          <div>
            <div style={{ fontSize: 9, letterSpacing: 3, color: "#2a2a4e", textTransform: "uppercase", fontFamily: "'Space Grotesk',sans-serif", marginBottom: 12 }}>
              Pipeline Flow
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 0 }}>
              {[
                { n: "01", title: "DEPLOY",       color: "#00aaff", desc: "3 Kubernetes pods launched: two stable baselines and one canary release candidate." },
                { n: "02", title: "INJECT CHAOS", color: "#ff6622", desc: "Chaos Mesh applies real network faults to the canary at the Linux kernel level." },
                { n: "03", title: "EVALUATE",     color: "#ffcc00", desc: "20 HTTP probes per service. Mann-Whitney U + Cohen's d + P95/P99 computed." },
                { n: "04", title: "DECIDE",       color: "#00ff88", desc: "PASS → promote. FAIL → rollback. INCONCLUSIVE → retry with exponential backoff." },
              ].map((step, i) => (
                <div key={step.n} style={{
                  padding: "16px 18px", background: "#0d0d1a", position: "relative",
                  borderLeft:   i === 0 ? `3px solid ${step.color}` : "1px solid #1c1c2e",
                  borderTop:    "1px solid #1c1c2e",
                  borderBottom: "1px solid #1c1c2e",
                  borderRight:  i === 3 ? "1px solid #1c1c2e" : "none",
                }}>
                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: step.color, letterSpacing: 2, marginBottom: 6 }}>{step.n}</div>
                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, fontWeight: 700, color: step.color, marginBottom: 8 }}>{step.title}</div>
                  <div style={{ fontSize: 11, color: "#4a4a6e", lineHeight: 1.65, fontFamily: "'Space Grotesk',sans-serif" }}>{step.desc}</div>
                  {i < 3 && (
                    <div style={{ position: "absolute", right: -10, top: "50%", transform: "translateY(-50%)", color: "#2a2a4e", fontSize: 14, zIndex: 1 }}>→</div>
                  )}
                </div>
              ))}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   EMPTY STATE — shown when no pipeline runs exist yet
   ══════════════════════════════════════════════════════════════════════════════ */
function EmptyState() {
  return (
    <div style={{
      padding: "48px 36px", marginBottom: 16,
      background: "#0d0d1a", border: "1px solid #1c1c2e",
      borderLeft: "6px solid #2a2a4e",
      display: "flex", flexDirection: "column", alignItems: "center",
      textAlign: "center", gap: 16,
    }}>
      <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 42, color: "#1c1c2e", fontWeight: 700, letterSpacing: 4 }}>
        NO DATA
      </div>
      <div style={{ fontSize: 14, color: "#4a4a6e", fontFamily: "'Space Grotesk',sans-serif", maxWidth: 480, lineHeight: 1.7 }}>
        No pipeline runs found. The dashboard is ready and waiting — start the pipeline locally to see results appear here in real time.
      </div>
      <div style={{
        padding: "14px 24px", background: "#13131f",
        border: "1px solid #1c1c2e", borderLeft: "3px solid #00aaff",
        fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: "#4a6a8e",
        textAlign: "left", maxWidth: 400, lineHeight: 2,
      }}>
        <div style={{ color: "#2a2a4e", marginBottom: 4 }}># from your terminal:</div>
        <div>minikube start</div>
        <div>python3.11 pipeline.py --chaos none</div>
        <div>python3.11 pipeline.py --chaos latency</div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN APP
   ══════════════════════════════════════════════════════════════════════════════ */
export default function App() {
  const [latest,    setLatest]    = useState(null);
  const [history,   setHistory]   = useState([]);
  const [stats,     setStats]     = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [connected, setConnected] = useState(false);
  const [updated,   setUpdated]   = useState(null);
  const [flashId,   setFlashId]   = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [l, h, s] = await Promise.all([
        fetch(`${API}/api/latest`).then(r => { if (!r.ok) throw Error(r.statusText); return r.json(); }),
        fetch(`${API}/api/history?limit=20`).then(r => { if (!r.ok) throw Error(r.statusText); return r.json(); }),
        fetch(`${API}/api/stats`).then(r => { if (!r.ok) throw Error(r.statusText); return r.json(); }),
      ]);
      setLatest(l);
      setHistory(Array.isArray(h) ? h : (h.runs || []));
      setStats(s);
      setUpdated(new Date().toLocaleTimeString());
      setError(null);
    } catch (err) {
      setError(err.message || "fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  /* SSE */
  useEffect(() => {
    const es = new EventSource(`${API}/api/stream`);
    es.onopen    = () => setConnected(true);
    es.onerror   = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.heartbeat) { setConnected(true); return; }
        setConnected(true);
        setLatest(data);
        setFlashId(data.id);
        setHistory(prev => [data, ...prev.filter(r => r.id !== data.id)].slice(0, 20));
        setUpdated(new Date().toLocaleTimeString());
        fetch(`${API}/api/stats`).then(r => r.json()).then(setStats).catch(() => {});
      } catch (_) {}
    };
    return () => es.close();
  }, []);

  /* Keyboard shortcut R */
  useEffect(() => {
    const h = (e) => {
      if (e.key === "r" && !e.ctrlKey && !e.metaKey && !e.altKey
        && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") fetchAll();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [fetchAll]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const exportJSON = () => {
    if (!latest) return;
    const blob = new Blob([JSON.stringify(latest, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `sentinel-x-run-${latest.id || Date.now()}.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  const hasData    = latest && latest.status !== "NO DATA";
  const c          = scfg(latest?.status);
  const p95Base    = latest?.p95_baseline || 0;
  const p95Can     = latest?.p95_canary   || 0;
  const p99Base    = latest?.p99_baseline || 0;
  const p99Can     = latest?.p99_canary   || 0;
  const cohensD    = latest?.cohens_d     || 0;
  const degradColor = (latest?.degradation || 0) > 80  ? "#ff2244" : "#00ff88";
  const noiseColor  = (latest?.noise       || 0) > 50  ? "#ff2244" : "#6a6a9e";
  const errColor    = (latest?.error_rate  || 0) > 5   ? "#ff2244" : "#00ff88";
  const cdColor     = Math.abs(cohensD) > 0.8 ? "#ff2244" : Math.abs(cohensD) > 0.5 ? "#ffcc00" : "#6a6a9e";

  const btn = { background: "transparent", border: "1px solid #1c1c2e", color: "#4a4a6e", fontSize: 10, padding: "5px 12px", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", letterSpacing: 1 };

  return (
    <div style={{ minHeight: "100vh", background: "#08080f", color: "#d4d4f0", fontFamily: "'Space Grotesk',system-ui,sans-serif" }}>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;700&family=JetBrains+Mono:wght@400;700&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:2px} ::-webkit-scrollbar-track{background:#08080f} ::-webkit-scrollbar-thumb{background:#1c1c2e}
        @keyframes fadeIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
        @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        button:hover{border-color:#3a3a5e!important;color:#8a8ab0!important}
        button:active{transform:translate(1px,1px)}
      `}</style>

      {/* ── TOP BAR ── */}
      <div style={{
        borderBottom: "1px solid #1c1c2e", background: "#08080f",
        padding: "0 32px", height: 54,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 14, fontWeight: 700, letterSpacing: 3, color: "#d4d4f0" }}>
            SENTINEL<span style={{ color: c.c, textShadow: `0 0 18px ${c.c}88` }}>-X</span>
          </span>
          <VDivider />
          <span style={{ fontSize: 9, letterSpacing: 3, color: "#2a2a4e", textTransform: "uppercase" }}>
            v4.2 · Canary Resilience Gate
          </span>
          <VDivider />
          <span style={{ fontSize: 9, letterSpacing: 2, color: "#1c1c2e", textTransform: "uppercase" }}>
            Kubernetes · Chaos Mesh · Mann-Whitney U · Cohen's d
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* Live indicator */}
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <div style={{
              width: 6, height: 6, borderRadius: "50%",
              background: connected ? "#00ff88" : "#2a2a4e",
              boxShadow: connected ? "0 0 8px #00ff88" : "none",
              animation: connected ? "pulse 2.4s ease infinite" : "none",
            }} />
            <span style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: connected ? "#00ff8870" : "#2a2a4e" }}>
              {connected ? "LIVE" : "offline"}
            </span>
            {!connected && (
              <span style={{ fontSize: 9, color: "#2a2a3e", letterSpacing: 0 }}>— start pipeline locally</span>
            )}
          </div>

          <VDivider />

          {stats && (
            <div style={{ display: "flex", gap: 18 }}>
              {[
                { l: "RUNS", v: stats.total,       c: "#4a4a6e" },
                { l: "PASS", v: stats.passed,      c: "#00ff88" },
                { l: "FAIL", v: stats.failed,      c: "#ff2244" },
                { l: "RATE", v: `${stats.pass_rate}%`, c: "#4a4a6e" },
              ].map(x => (
                <div key={x.l} style={{ textAlign: "center" }}>
                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, fontWeight: 700, color: x.c }}>{x.v}</div>
                  <div style={{ fontSize: 7, letterSpacing: 2, color: "#2a2a4e" }}>{x.l}</div>
                </div>
              ))}
            </div>
          )}

          <VDivider />

          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={fetchAll} style={btn} title="Force refresh [r]">↺ [R]</button>
            <button onClick={exportJSON} disabled={!latest} style={{ ...btn, opacity: latest ? 1 : 0.35 }} title="Export run as JSON">↓ JSON</button>
          </div>

          {updated && (
            <span style={{ fontSize: 9, color: "#1c1c2e", fontFamily: "'JetBrains Mono',monospace" }}>↻ {updated}</span>
          )}
        </div>
      </div>

      {/* ── BODY ── */}
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "24px 32px" }}>

        {/* Error banner */}
        {error && (
          <div style={{ padding: "10px 16px", marginBottom: 16, background: "#ff224408", border: "1px solid #ff224430", borderLeft: "3px solid #ff2244", fontSize: 11, color: "#ff5566", fontFamily: "'JetBrains Mono',monospace" }}>
            ⚠ API unreachable — {error}. Make sure the Flask backend is running locally. Press [R] to retry.
          </div>
        )}

        {/* ── PROJECT INFO BANNER ── */}
        <InfoBanner connected={connected} />

        {/* ── VERDICT HERO ── */}
        {loading ? (
          <div style={{ padding: "30px 36px", marginBottom: 16, background: "#0d0d1a", border: "1px solid #1c1c2e", borderLeft: "6px solid #1c1c2e" }}>
            <Skel h={50} w="30%" /><div style={{ marginTop: 18 }}><Skel h={4} /></div><div style={{ marginTop: 14 }}><Skel h={13} w="55%" /></div>
          </div>
        ) : !hasData ? (
          <EmptyState />
        ) : (
          <div style={{
            display: "flex", gap: 0, marginBottom: 16,
            border: "1px solid #1c1c2e", borderLeft: `6px solid ${c.c}`,
            boxShadow: `4px 4px 0 0 #000000cc, 0 0 80px ${c.c}08`,
          }}>
            <div style={{ flex: 1, padding: "30px 36px", background: "#0d0d1a" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                {latest?.chaos_mode && latest.chaos_mode !== "none" && (
                  <span style={{ fontSize: 8, letterSpacing: 3, padding: "3px 9px", border: "1px solid #2a2a3e", color: "#4a4a6e", textTransform: "uppercase" }}>{latest.chaos_mode}</span>
                )}
                {(latest?.n_samples || 0) > 0 && (
                  <span style={{ fontSize: 8, letterSpacing: 2, padding: "3px 9px", border: "1px solid #1c1c2e", color: "#2a2a4e", fontFamily: "'JetBrains Mono',monospace" }}>n={latest.n_samples}</span>
                )}
              </div>
              <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 56, fontWeight: 700, lineHeight: 1, color: c.c, letterSpacing: 2, textShadow: `0 0 40px ${c.c}44`, marginBottom: 18 }}>
                {latest?.status}
              </div>
              <div style={{ marginBottom: 4 }}>
                <div style={{ fontSize: 8, letterSpacing: 3, color: "#2a2a4e", textTransform: "uppercase", marginBottom: 7 }}>Mann-Whitney U Confidence</div>
                <ConfBar value={latest?.confidence || 0} color={c.c} />
              </div>
              <div style={{ marginTop: 16, fontSize: 13, color: "#5a5a7e", lineHeight: 1.7, maxWidth: 620, fontFamily: "'Space Grotesk',sans-serif" }}>
                {latest?.reason}
              </div>
              {(latest?.eval_seconds || 0) > 0 && (
                <div style={{ marginTop: 10, fontSize: 10, color: "#2a2a4e", fontFamily: "'JetBrains Mono',monospace" }}>
                  eval: {latest.eval_seconds}s · {latest.timestamp}
                </div>
              )}
            </div>
            {stats && (
              <div style={{ minWidth: 176, padding: "30px 24px", background: "#0a0a14", borderLeft: "1px solid #1c1c2e", display: "flex", flexDirection: "column", justifyContent: "center", gap: 10 }}>
                <div style={{ fontSize: 8, letterSpacing: 3, color: "#2a2a4e", textTransform: "uppercase", marginBottom: 6 }}>Historical Pass Rate</div>
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 36, fontWeight: 700, color: "#00ff88", lineHeight: 1 }}>{stats.pass_rate}%</div>
                <ConfBar value={stats.pass_rate} color="#00ff88" />
                <div style={{ marginTop: 4, fontSize: 9, color: "#2a2a4e", fontFamily: "'JetBrains Mono',monospace" }}>{stats.total} total runs</div>
              </div>
            )}
          </div>
        )}

        {/* ── METRIC GRID ROW 1 ── */}
        {hasData && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 10 }}>
            <MetricCard label="Baseline Avg"  value={(latest?.baseline_avg || 0).toFixed(1)} unit="ms" color="#00aaff" accentColor="#00aaff" />
            <MetricCard label="Canary Avg"    value={(latest?.canary_avg   || 0).toFixed(1)} unit="ms" color={c.c} accentColor={c.c} />
            <MetricCard label="Degradation"   value={(latest?.degradation  || 0).toFixed(1)} unit="ms" color={degradColor} accentColor={degradColor} note={(latest?.degradation || 0) > 80 ? "Above threshold" : "Within bounds"} />
            <MetricCard label="Noise (A1-A2)" value={(latest?.noise || 0).toFixed(1)} unit="ms" color={noiseColor} accentColor={noiseColor} note={(latest?.noise || 0) > 50 ? "⚠ Env unstable" : "Stable"} />
          </div>
        )}

        {/* ── METRIC GRID ROW 2 ── */}
        {hasData && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 16 }}>
            <MetricCard label="Baseline σ"  value={(latest?.baseline_std || 0).toFixed(2)} unit="ms" color="#00aaff" accentColor="#00aaff" />
            <MetricCard label="Canary σ"    value={(latest?.canary_std   || 0).toFixed(2)} unit="ms" color={c.c} accentColor={c.c} />
            <MetricCard label="Error Rate"  value={(latest?.error_rate   || 0).toFixed(1)} unit="%" color={errColor} accentColor={errColor} />
            <MetricCard label="Cohen's d"   value={cohensD.toFixed(3)} color={cdColor} accentColor={cdColor}
              note={Math.abs(cohensD) < 0.2 ? "negligible effect" : Math.abs(cohensD) < 0.5 ? "small effect" : Math.abs(cohensD) < 0.8 ? "medium effect" : "large effect"} />
          </div>
        )}

        {/* ── P95 / P99 ── */}
        {hasData && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10, marginBottom: 16 }}>
            <PLatCard label="P95 Latency" baseline={p95Base} canary={p95Can} statusColor={c.c} />
            <PLatCard label="P99 Latency" baseline={p99Base} canary={p99Can} statusColor={c.c} />
          </div>
        )}

        {/* ── SPARKLINES + HISTORY ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 10, marginBottom: 16 }}>
          <div style={{ background: "#0d0d1a", border: "1px solid #1c1c2e", borderLeft: "3px solid #1c1c2e", padding: "20px 26px" }}>
            <div style={{ fontSize: 9, letterSpacing: 3, color: "#2a2a4e", textTransform: "uppercase", marginBottom: 22 }}>Latency Samples — Per Request</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
              {[
                { label: "BASELINE-1", data: latest?.b1_samples,     color: "#00aaff" },
                { label: "BASELINE-2", data: latest?.b2_samples,     color: "#0077bb" },
                { label: "CANARY",     data: latest?.canary_samples,  color: c.c },
              ].map(row => {
                const valid = (row.data || []).filter(v => v < 4500);
                const avg   = valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : null;
                return (
                  <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <span style={{ fontSize: 8, letterSpacing: 2, color: row.color, minWidth: 76, textTransform: "uppercase", fontFamily: "'JetBrains Mono',monospace" }}>{row.label}</span>
                    <div style={{ flex: 1 }}>
                      {loading ? <Skel h={36} /> : <Spark data={row.data || []} color={row.color} h={36} w={320} />}
                    </div>
                    <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "#2a2a4e", minWidth: 44, textAlign: "right" }}>{avg != null ? `${avg}ms` : "—"}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ background: "#0d0d1a", border: "1px solid #1c1c2e", borderLeft: "3px solid #1c1c2e", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "13px 16px", borderBottom: "1px solid #1c1c2e", fontSize: 9, letterSpacing: 3, color: "#2a2a4e", textTransform: "uppercase", display: "flex", justifyContent: "space-between" }}>
              <span>Run History</span>
              {history.length > 0 && <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#1c1c2e" }}>×{history.length}</span>}
            </div>
            <div style={{ flex: 1, overflowY: "auto", maxHeight: 226 }}>
              {loading
                ? <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>{Array(4).fill(0).map((_, i) => <Skel key={i} h={10} />)}</div>
                : history.length === 0
                ? <div style={{ padding: "16px", fontSize: 11, color: "#2a2a4e" }}>No runs yet — start the pipeline.</div>
                : history.map((r, i) => <HistRow key={r.id ?? i} run={r} isNew={r.id === flashId && i === 0} />)
              }
            </div>
          </div>
        </div>

        {/* ── DECISION AUDIT TRAIL ── */}
        <Explain d={latest} />

        {/* ── FOOTER ── */}
        <div style={{ marginTop: 32, paddingTop: 20, borderTop: "1px solid #1c1c2e", display: "flex", justifyContent: "space-between", fontSize: 9, letterSpacing: 2, color: "#1c1c2e", textTransform: "uppercase", fontFamily: "'Space Grotesk',sans-serif" }}>
          <span>Sentinel-X v4.2 · Kubernetes Canary Resilience Gate</span>
          <span>Chaos Mesh · A/A/B · Mann-Whitney U · Cohen's d · SSE · Prometheus</span>
        </div>
      </div>
    </div>
  );
}
