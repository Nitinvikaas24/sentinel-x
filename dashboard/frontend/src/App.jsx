import { useState, useEffect, useCallback, useRef } from "react";

const API = import.meta.env.VITE_API_URL || "https://sentinel-x-v4.onrender.com";

/* ── Status palette (light theme) ──────────────────────────────────────────── */
const STATUS_CFG = {
  "PASS":          { c: "#3ee6a0" },
  "FAIL":          { c: "#ff5d73" },
  "CRITICAL FAIL": { c: "#ff4560" },
  "INCONCLUSIVE":  { c: "#ffc247" },
  "NO DATA":       { c: "#6b7086" },
};
const scfg = (s) => STATUS_CFG[s] || STATUS_CFG["NO DATA"];

const BAD = "#ff5d73", WARN = "#ffc247", GOOD = "#3ee6a0", MUTED = "#8d92a8", BLUE = "#6ea8ff";

/* ── Scroll reveal ─────────────────────────────────────────────────────────── */
function Reveal({ children, delay = 0, as: Tag = "div", className = "", ...rest }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setShown(true); return; }
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setShown(true); io.disconnect(); }
    }, { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref} className={`reveal ${shown ? "in" : ""} ${className}`} style={{ transitionDelay: `${delay}ms` }} {...rest}>
      {children}
    </Tag>
  );
}

/* ── Count-up number ───────────────────────────────────────────────────────── */
function CountUp({ value = 0, decimals = 0, duration = 900 }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setShown(value); return; }
    const start = performance.now(), a = from.current, b = Number(value) || 0;
    let raf;
    const tick = (t) => {
      const p = Math.min((t - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(a + (b - a) * eased);
      if (p < 1) raf = requestAnimationFrame(tick); else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{Number(shown).toFixed(decimals)}</>;
}

/* ── Confidence bar ────────────────────────────────────────────────────────── */
function ConfBar({ value = 0, color = GOOD }) {
  const [w, setW] = useState(0);
  useEffect(() => { const t = setTimeout(() => setW(Math.min(value, 100)), 60); return () => clearTimeout(t); }, [value]);
  return (
    <div className="confbar">
      <div className="confbar-track"><div className="confbar-fill" style={{ width: `${w}%`, background: color }} /></div>
      <span style={{ color }}>{Math.round(value)}%</span>
    </div>
  );
}

/* ── Sparkline (line draws itself) ─────────────────────────────────────────── */
function Spark({ data = [], color, h = 56, w = 420 }) {
  if (!data.length) return <div style={{ width: "100%", height: h }} />;
  const valid = data.filter(v => v < 4500);
  if (!valid.length) return <span style={{ color: BAD }}>timeout × {data.length}</span>;
  const mn = Math.min(...valid), mx = Math.max(...valid, mn + 1);
  const pt = (v, i) => {
    const x = data.length < 2 ? w / 2 : (i / (data.length - 1)) * w;
    const y = h - ((Math.min(v, 4500) - mn) / (mx - mn)) * (h - 10) - 5;
    return [x, y];
  };
  const pts = data.map((v, i) => pt(v, i).map(n => n.toFixed(1)).join(",")).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: h, overflow: "visible" }}>
      <polyline key={pts} className="spark-line" points={pts} pathLength="1" fill="none" stroke={color}
        strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ── Ring (pass rate) ──────────────────────────────────────────────────────── */
function Ring({ value = 0, color = GOOD }) {
  const r = 54, C = 2 * Math.PI * r;
  const [p, setP] = useState(0);
  useEffect(() => { const t = setTimeout(() => setP(value), 120); return () => clearTimeout(t); }, [value]);
  return (
    <svg viewBox="0 0 140 140" className="ring" role="img" aria-label={`Pass rate ${Math.round(value)} percent`}>
      <circle cx="70" cy="70" r={r} fill="none" stroke="var(--line)" strokeWidth="8" />
      <circle cx="70" cy="70" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
        strokeDasharray={C} strokeDashoffset={C * (1 - Math.min(p, 100) / 100)} transform="rotate(-90 70 70)"
        style={{ transition: "stroke-dashoffset 1.5s cubic-bezier(.22,.8,.24,1)" }} />
      <text x="70" y="79" textAnchor="middle" fontSize="28" fontWeight="500" fill="currentColor">{Math.round(value)}%</text>
    </svg>
  );
}

/* ── Comparison bar ────────────────────────────────────────────────────────── */
function Bar({ name, v, max, color }) {
  const [w, setW] = useState(0);
  useEffect(() => { const t = setTimeout(() => setW((v / max) * 100), 120); return () => clearTimeout(t); }, [v, max]);
  return (
    <div className="bar">
      <span className="bar-name">{name}</span>
      <div className="bar-track"><div className="bar-fill" style={{ width: `${w}%`, background: color }} /></div>
      <span className="bar-val" style={{ color }}><CountUp value={v} />ms</span>
    </div>
  );
}

/* ── Interactive latency chart ─────────────────────────────────────────────── */
function LatencyChart({ series }) {
  const W = 760, H = 300, L = 62, R = 14, T = 14, B = 30;
  const [hover, setHover] = useState(null);
  const all = series.flatMap(s => (s.data || []).filter(v => v < 4500));
  if (!all.length) return <p className="note">No samples yet.</p>;
  const n = Math.max(...series.map(s => (s.data || []).length));
  const mx = Math.max(...all) * 1.1;
  const x = i => L + (n < 2 ? (W - L - R) / 2 : (i / (n - 1)) * (W - L - R));
  const y = v => T + (1 - Math.min(v, 4500) / mx) * (H - T - B);
  const path = d => d.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => Math.round(mx * t));
  const canary = series[2].data || [];
  const area = canary.length ? `${path(canary)} L${x(canary.length - 1).toFixed(1)},${H - B} L${x(0).toFixed(1)},${H - B} Z` : "";
  const move = e => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1)))));
  };
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" onMouseMove={move} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={series[2].color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={series[2].color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map(t => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line)" />
            <text x={L - 12} y={y(t) + 6} textAnchor="end" fontSize="17" fill="#8d92a8">{t}</text>
          </g>
        ))}
        {area && <path d={area} fill="url(#cg)" className="chart-area" />}
        {series.map(s => (s.data || []).length > 0 && (
          <path key={s.label} className="spark-line" d={path(s.data)} pathLength="1" fill="none" stroke={s.color}
            strokeWidth={s.label === "Canary" ? 3 : 2} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--ink)" strokeOpacity="0.25" strokeDasharray="4 4" />
            {series.map(s => s.data?.[hover] != null && (
              <circle key={s.label} cx={x(hover)} cy={y(s.data[hover])} r="5.5" fill="#fff" stroke={s.color} strokeWidth="2.5" />
            ))}
          </g>
        )}
      </svg>
      <div className="legend">
        {series.map(s => {
          const valid = (s.data || []).filter(v => v < 4500);
          const avg = valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : null;
          const cur = hover != null ? s.data?.[hover] : null;
          return (
            <div key={s.label}>
              <span><i style={{ background: s.color }} />{s.label}</span>
              <b style={{ color: s.color }}>
                {cur != null ? `${Math.round(cur)}ms` : avg != null ? `${avg}ms` : "—"}
              </b>
              <small>{hover != null ? `request ${hover + 1}` : "average"}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Open metric (no box) ──────────────────────────────────────────────────── */
function Metric({ label, value, unit = "", color = "inherit", note, decimals = 1, delay = 0 }) {
  return (
    <Reveal className="metric" delay={delay}>
      <span className="label">{label}</span>
      <span className="metric-value" style={{ color }}>
        <CountUp value={Number(value)} decimals={decimals} />
        <small>{unit}</small>
      </span>
      {note && <span className="note">{note}</span>}
    </Reveal>
  );
}

/* ── Percentile comparison (bars) ──────────────────────────────────────────── */
function PLat({ label, baseline = 0, canary = 0, statusColor, delay = 0 }) {
  const delta = canary - baseline;
  const dColor = delta > 80 ? BAD : delta > 30 ? WARN : GOOD;
  const max = Math.max(baseline, canary, 1);
  return (
    <Reveal className="plat" delay={delay}>
      <div className="plat-head">
        <span className="label">{label}</span>
        <b style={{ color: dColor }}>{delta > 0 ? "+" : ""}<CountUp value={delta} />ms</b>
      </div>
      <Bar name="Baseline" v={baseline} max={max} color={BLUE} />
      <Bar name="Canary" v={canary} max={max} color={statusColor} />
    </Reveal>
  );
}

/* ── History row ───────────────────────────────────────────────────────────── */
function HistRow({ run, isNew }) {
  const c = scfg(run.status);
  const t = (run.timestamp || "").slice(11, 16);
  return (
    <div className={`hist-row ${isNew ? "fresh" : ""}`}>
      <i style={{ background: c.c }} />
      <span className="hist-time">{t}</span>
      <span className="hist-status" style={{ color: c.c }}>{run.status}</span>
      <span className="hist-meta" title={run.service || ""}>{run.service ? run.service.replace(/^Sample: /, "") : (run.chaos_mode || "—")} · {(run.degradation || 0).toFixed(0)}ms</span>
    </div>
  );
}

/* ── Audit trail ───────────────────────────────────────────────────────────── */
function Explain({ d }) {
  if (!d || d.status === "NO DATA") return null;
  const cd = d.cohens_d || 0;
  const cdLabel = Math.abs(cd) < 0.2 ? "negligible" : Math.abs(cd) < 0.5 ? "small" : Math.abs(cd) < 0.8 ? "medium" : "large";
  const p95d = (d.p95_canary || 0) - (d.p95_baseline || 0);
  const lines = [
    d.noise < 10 ? { ok: true, text: `Environment stable — baseline noise only ${d.noise?.toFixed(1)}ms.` }
      : d.noise < 50 ? { ok: null, text: `Moderate baseline noise (${d.noise?.toFixed(1)}ms) — results valid but marginal.` }
      : { ok: false, text: `Unstable environment — A1 vs A2 differ by ${d.noise?.toFixed(1)}ms (threshold: 50ms).` },
    d.degradation < 50 ? { ok: true, text: `Mean latency within acceptable range (+${d.degradation?.toFixed(1)}ms).` }
      : d.degradation < 150 ? { ok: null, text: `Measurable latency increase: +${d.degradation?.toFixed(1)}ms above baseline.` }
      : { ok: false, text: `Significant degradation — mean +${d.degradation?.toFixed(1)}ms above baseline.` },
    p95d < 50
      ? { ok: true,  text: `P95 acceptable: +${p95d.toFixed(1)}ms (${d.p95_baseline?.toFixed(0)} → ${d.p95_canary?.toFixed(0)}ms).` }
      : { ok: false, text: `P95 regression: +${p95d.toFixed(1)}ms (${d.p95_baseline?.toFixed(0)} → ${d.p95_canary?.toFixed(0)}ms).` },
    d.error_rate > 5 ? { ok: false, text: `High error rate: ${d.error_rate?.toFixed(1)}% of canary requests failed.` }
      : { ok: true, text: `Error rate nominal: ${d.error_rate?.toFixed(1)}%.` },
    { ok: null, text: `Mann-Whitney U confidence: ${d.confidence}% — probability the canary is slower than baseline.` },
    { ok: cd > 0.8 ? false : cd < 0.2 ? true : null, text: `Cohen's d = ${cd.toFixed(3)} (${cdLabel} effect size).` },
    d.status === "PASS" ? { ok: true, text: "Safe to promote the canary to production." }
      : d.status?.includes("FAIL") ? { ok: false, text: "Rollback required. Do not promote." }
      : { ok: null, text: "Manual review required before any promotion decision." },
  ];
  const dot = ok => ok === true ? GOOD : ok === false ? BAD : WARN;
  return (
    <section className="section">
      <Reveal as="h2" className="h2"><em>04</em>Why this decision</Reveal>
      <ul className="trail">
        {lines.map((l, i) => (
          <Reveal as="li" key={i} delay={i * 60}>
            <i style={{ background: dot(l.ok) }} /><span>{l.text}</span>
          </Reveal>
        ))}
      </ul>
    </section>
  );
}

/* ── How it works: tall panels with outlined gradient numerals ─────────────── */
const HOW = [
  { n: "1", title: "Deploy",        text: "Two stable baselines and one canary start as separate pods, so the canary can be compared with something known to be good." },
  { n: "2", title: "Break it",      text: "Chaos Mesh slows or disrupts the canary's network at the kernel level while all three services are probed." },
  { n: "3", title: "Decide",        text: "Mann-Whitney U and Cohen's d turn the numbers into one answer: promote, roll back, or rerun if the environment was too noisy." },
];

function HowItWorks() {
  return (
    <section className="how">
      <Reveal className="how-label">
        <span>Your release<br />safety net</span>
        <i className="grad-line" />
      </Reveal>
      {HOW.map((h, i) => (
        <Reveal key={h.n} className="how-card" delay={i * 120}>
          <b>{h.title}</b>
          <svg viewBox="0 0 160 200" className="numeral" aria-hidden="true">
            <defs>
              <linearGradient id={`ng${i}`} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#2ee6d6" />
                <stop offset="55%" stopColor="#6e7bff" />
                <stop offset="100%" stopColor="#ff5d9e" />
              </linearGradient>
            </defs>
            <text x="80" y="170" textAnchor="middle" fontSize="190" fontWeight="500" fill="none" stroke={`url(#ng${i})`} strokeWidth="2.2">{h.n}</text>
          </svg>
          <p>{h.text}</p>
        </Reveal>
      ))}
    </section>
  );
}

/* ── Verdict as a quote ────────────────────────────────────────────────────── */
function VerdictQuote({ d }) {
  if (!d || d.status === "NO DATA" || !d.reason) return null;
  const mark = (flip) => (
    <svg viewBox="0 0 120 120" className={`qmark ${flip ? "flip" : ""}`} aria-hidden="true">
      <defs>
        <linearGradient id={`qg${flip ? 1 : 0}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff5d9e" /><stop offset="100%" stopColor="#2ee6d6" />
        </linearGradient>
      </defs>
      <text x="60" y="118" textAnchor="middle" fontSize="190" fontFamily="Georgia, 'Times New Roman', serif" fontWeight="700"
        fill="none" stroke={`url(#qg${flip ? 1 : 0})`} strokeWidth="2.4">{"“"}</text>
    </svg>
  );
  return (
    <section className="section quote-wrap">
      {mark(false)}
      <Reveal className="quote">
        <i className="grad-line short" />
        <p>{d.reason}</p>
        <span>The judge's verdict · {d.n_samples || 0} samples per service</span>
      </Reveal>
      {mark(true)}
    </section>
  );
}

/* ── Skeleton ──────────────────────────────────────────────────────────────── */
function Skel({ w = "100%", h = 18 }) {
  return <div className="skel" style={{ width: w, height: h }} />;
}

/* ══════════════════════════════════════════════════════════════════════════════
   ABOUT
   ══════════════════════════════════════════════════════════════════════════════ */
const STACK = ["Kubernetes", "Chaos Mesh", "Python", "Flask + SSE", "React + Vite", "SQLite", "Mann-Whitney U", "Cohen's d", "Prometheus", "GitHub Actions"];
const STEPS = [
  { n: "01", title: "Deploy",       desc: "Three Kubernetes pods launch: two stable baselines and one canary release candidate." },
  { n: "02", title: "Inject chaos", desc: "Chaos Mesh applies real network faults to the canary at the Linux kernel level." },
  { n: "03", title: "Evaluate",     desc: "Twenty HTTP probes per service. Mann-Whitney U, Cohen's d and P95/P99 are computed." },
  { n: "04", title: "Decide",       desc: "Pass promotes. Fail rolls back. Inconclusive retries with exponential backoff." },
];

function About({ connected }) {
  const [open, setOpen] = useState(true);
  const [runOpen, setRunOpen] = useState(false);
  return (
    <section className="section about">
      <div className="about-head">
        <Reveal as="h2" className="h2"><em>05</em>About this project</Reveal>
        <button className="link" onClick={() => setOpen(o => !o)}>{open ? "Collapse" : "Expand"}</button>
      </div>
      <div className={`collapse ${open ? "open" : ""}`}>
        <div className="collapse-inner">
          <Reveal as="p" className="lead">
            A self-built <b>chaos engineering and canary deployment gate</b>, designed around how companies like Netflix, Google and Amazon ship code safely. It deploys three service variants, injects real network faults through Chaos Mesh, then uses <b>Mann-Whitney U and Cohen's d</b> to decide promote or rollback automatically.
          </Reveal>
          <Reveal as="p" className="body" delay={80}>
            The A/A/B design, with two baselines instead of one, is the key idea. It measures how stable the environment is before trusting any signal. If the baselines drift apart by more than 50ms, the answer is <span style={{ color: WARN, fontWeight: 500 }}>inconclusive</span> rather than a false one.
          </Reveal>

          <Reveal className="stack" delay={120}>
            {STACK.map(s => <span key={s}>{s}</span>)}
          </Reveal>

          <Reveal className="callout" delay={160}>
            <span className="label">Why isn't it updating live?</span>
            <p>
              The pipeline runs on a local Kubernetes cluster (minikube) because it injects real network-layer faults, which a free cloud VM can't reproduce. Results are pushed here after each local run using the <code>SENTINEL_API</code> variable. Live connection:{" "}
              <b style={{ color: connected ? GOOD : BAD }}>{connected ? "connected" : "offline"}</b>
              {!connected && " — no pipeline is running right now"}.
            </p>
            <button className="link" onClick={() => setRunOpen(o => !o)}>{runOpen ? "Hide steps" : "How to run it locally"}</button>
            <div className={`collapse ${runOpen ? "open" : ""}`}>
              <div className="collapse-inner">
                <pre className="cmd">{`minikube start\npython pipeline.py --chaos latency`}</pre>
              </div>
            </div>
          </Reveal>

        </div>
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <section className="empty">
      <Reveal as="h1" className="display muted-display">No data yet</Reveal>
      <Reveal as="p" className="lead center" delay={80}>
        The dashboard is ready. Start the pipeline locally and results will appear here as soon as a run finishes.
      </Reveal>
      <Reveal as="pre" className="cmd center-block" delay={160}>{`minikube start\npython pipeline.py --chaos none\npython pipeline.py --chaos latency`}</Reveal>
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   TEST YOUR OWN SERVICE
   ══════════════════════════════════════════════════════════════════════════════ */
const JOB_STEPS = ["queued", "building", "deploying", "injecting", "evaluating", "done"];
const JOB_LABEL = { queued: "Queued", building: "Building", deploying: "Deploying", injecting: "Injecting chaos", evaluating: "Evaluating", done: "Done", failed: "Failed" };

function JobRow({ job }) {
  const idx = Math.max(0, JOB_STEPS.indexOf(job.status));
  const failed = job.status === "failed";
  const done = job.status === "done";
  const color = failed ? BAD : done ? GOOD : BLUE;
  const lastLog = (job.log || "").trim().split("\n").filter(Boolean).pop();
  return (
    <div className="job">
      <div className="job-head">
        <b>{job.name}</b>
        <span style={{ color }}>{JOB_LABEL[job.status] || job.status}</span>
      </div>
      <div className="job-track">
        <div className="job-fill" style={{ width: failed ? "100%" : `${(idx / (JOB_STEPS.length - 1)) * 100}%`, background: color }} />
      </div>
      <p className="note">
        {failed ? (job.error || lastLog) : lastLog || "Waiting for the runner to pick this up…"}
      </p>
    </div>
  );
}

function TestPanel({ jobs, runner, onSubmit, onSample, busy, message }) {
  const [canary, setCanary] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [name, setName] = useState("");
  const [chaos, setChaos] = useState("latency");
  const [port, setPort] = useState("8080");
  const [health, setHealth] = useState("/");
  const [key, setKey] = useState(() => { try { return sessionStorage.getItem("sx_key") || ""; } catch (_) { return ""; } });
  const [adv, setAdv] = useState(false);

  const submit = (e) => {
    e.preventDefault();
    if (!canary) return;
    try { sessionStorage.setItem("sx_key", key); } catch (_) {}
    const fd = new FormData();
    fd.append("canary", canary);
    if (baseline) fd.append("baseline", baseline);
    fd.append("name", name || canary.name.replace(/\.zip$/i, ""));
    fd.append("chaos", chaos); fd.append("port", port); fd.append("health", health);
    onSubmit(fd, key);
  };

  return (
    <section className="section cta" id="test">
      <i className="spot" aria-hidden="true" />
      <Reveal as="h2" className="h2"><em>Try it</em>Test your own service</Reveal>
      <Reveal as="p" className="lead" delay={60}>
        Upload a zip with a Dockerfile. Sentinel-X builds it, runs it as three pods, breaks the network on the canary, and tells you whether it is safe to ship.
      </Reveal>

      <Reveal className="runner-line" delay={100}>
        <i className={runner?.online ? "on" : ""} />
        {runner?.online
          ? "Runner online — tests will start right away."
          : <>Runner offline. Start it on the machine with minikube: <code>py runner/agent.py</code></>}
      </Reveal>

      <div className="test-grid">
        <Reveal as="form" className="form" onSubmit={submit} delay={140}>
          <label className="field">
            <span className="label">Your service (.zip with a Dockerfile)</span>
            <input type="file" accept=".zip" onChange={e => setCanary(e.target.files[0] || null)} />
          </label>
          <label className="field">
            <span className="label">Current production version (optional .zip)</span>
            <input type="file" accept=".zip" onChange={e => setBaseline(e.target.files[0] || null)} />
            <span className="note">Leave empty to compare against an unmodified copy of your service.</span>
          </label>
          <label className="field">
            <span className="label">Chaos to inject</span>
            <select value={chaos} onChange={e => setChaos(e.target.value)}>
              <option value="latency">Latency (+200 ms)</option>
              <option value="packetloss">Packet loss (10%)</option>
              <option value="combined">Latency and packet loss</option>
              <option value="none">None (compare versions only)</option>
            </select>
          </label>

          <button type="button" className="link" onClick={() => setAdv(a => !a)}>{adv ? "Hide options" : "More options"}</button>
          <div className={`collapse ${adv ? "open" : ""}`}>
            <div className="collapse-inner">
              <div className="adv">
                <label className="field"><span className="label">Display name</span>
                  <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="My service" maxLength={60} /></label>
                <label className="field"><span className="label">Container port</span>
                  <input type="number" value={port} onChange={e => setPort(e.target.value)} min="1" max="65535" /></label>
                <label className="field"><span className="label">Health path</span>
                  <input type="text" value={health} onChange={e => setHealth(e.target.value)} placeholder="/" /></label>
                <label className="field"><span className="label">Access key (if your server needs one)</span>
                  <input type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" /></label>
              </div>
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" className="pill" disabled={!canary || busy}>{busy ? "Sending…" : "Start test"}</button>
            {message && <span className="form-msg" style={{ color: message.ok ? GOOD : BAD }}>{message.text}</span>}
          </div>
        </Reveal>

        <div>
          <Reveal className="samples-box" delay={180}>
            <span className="label">No code handy? Run a demo.</span>
            <div className="sample-btns">
              <button className="pill ghost" disabled={busy} onClick={() => onSample("good")}>Healthy release</button>
              <button className="pill ghost" disabled={busy} onClick={() => onSample("slow")}>Regressed release</button>
            </div>
            <span className="note">The healthy one should pass. The regressed one is 150 ms slower than its baseline and should be rejected.</span>
          </Reveal>

          <div className="jobs">
            {jobs.length === 0
              ? <p className="note">Tests you start will show up here.</p>
              : jobs.slice(0, 4).map(j => <JobRow key={j.id} job={j} />)}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   APP
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
  const [jobs,      setJobs]      = useState([]);
  const [runner,    setRunner]    = useState(null);
  const [busy,      setBusy]      = useState(false);
  const [message,   setMessage]   = useState(null);

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

  useEffect(() => {
    const es = new EventSource(`${API}/api/stream`);
    es.onopen    = () => setConnected(true);
    es.onerror   = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.heartbeat) { setConnected(true); return; }
        setConnected(true);
        if (data.event === "job") {
          setJobs(prev => [data, ...prev.filter(j => j.id !== data.id)].sort((a, b) => b.id - a.id));
          return;
        }
        setLatest(data);
        setFlashId(data.id);
        setHistory(prev => [data, ...prev.filter(r => r.id !== data.id)].slice(0, 20));
        setUpdated(new Date().toLocaleTimeString());
        fetch(`${API}/api/stats`).then(r => r.json()).then(setStats).catch(() => {});
      } catch (_) {}
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    const h = (e) => {
      if (e.key === "r" && !e.ctrlKey && !e.metaKey && !e.altKey
        && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") fetchAll();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [fetchAll]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const loadJobs = useCallback(() => {
    fetch(`${API}/api/jobs?limit=10`).then(r => r.json()).then(d => setJobs(d.jobs || [])).catch(() => {});
    fetch(`${API}/api/runner`).then(r => r.json()).then(setRunner).catch(() => setRunner(null));
  }, []);
  useEffect(() => { loadJobs(); const t = setInterval(loadJobs, 10000); return () => clearInterval(t); }, [loadJobs]);

  const post = async (path, init) => {
    setBusy(true); setMessage(null);
    try {
      const r = await fetch(`${API}${path}`, init);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      setMessage({ ok: true, text: "Queued. Watch the progress on the right." });
      loadJobs();
    } catch (err) {
      setMessage({ ok: false, text: err.message || "Something went wrong" });
    } finally { setBusy(false); }
  };
  const submitJob  = (fd, key) => post("/api/jobs", { method: "POST", body: fd, headers: key ? { "X-Upload-Key": key } : {} });
  const startSample = (which) => post("/api/jobs/sample", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sample: which }) });

  const exportJSON = () => {
    if (!latest) return;
    const blob = new Blob([JSON.stringify(latest, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `sentinel-x-run-${latest.id || Date.now()}.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  const hasData = latest && latest.status !== "NO DATA";
  const c       = scfg(latest?.status);
  const cohensD = latest?.cohens_d || 0;
  const degradColor = (latest?.degradation || 0) > 80 ? BAD : GOOD;
  const noiseColor  = (latest?.noise       || 0) > 50 ? BAD : "inherit";
  const errColor    = (latest?.error_rate  || 0) > 5  ? BAD : GOOD;
  const cdColor     = Math.abs(cohensD) > 0.8 ? BAD : Math.abs(cohensD) > 0.5 ? WARN : "inherit";

  return (
    <div className="app" style={{ "--tint": ({ "PASS": "#0f9a6e", "FAIL": "#c4243f", "CRITICAL FAIL": "#c91a3c", "INCONCLUSIVE": "#b07a08" })[latest?.status] || "#4b3bd1" }}>
      <style>{CSS}</style>
      <div className="ambient" aria-hidden="true"><span /><span /><span /></div>

      {/* ── NAV ── */}
      <header className="nav">
        <a className="brand" href="#top">sentinel<i style={{ background: c.c, boxShadow: `0 0 14px ${c.c}` }} />x</a>
        <div className="nav-right">
          <span className="live">
            <i className={connected ? "on" : ""} />
            {connected ? "Live" : "Offline"}
          </span>
          <a className="link" href="#test">Test your service</a>
          <button className="link" onClick={fetchAll} title="Refresh (R)">Refresh</button>
          <button className="pill" onClick={exportJSON} disabled={!latest}>Export JSON</button>
        </div>
      </header>

      <main id="top" className="wrap">
        {error && (
          <p className="error">The API couldn't be reached ({error}). Press R to try again.</p>
        )}

        {/* ── HERO ── */}
        {loading ? (
          <section className="hero"><Skel h={90} w="40%" /><div style={{ height: 18 }} /><Skel h={10} w="30%" /></section>
        ) : !hasData ? (
          <EmptyState />
        ) : (
          <section className="hero">
            <div className="hero-main">
              <p className="eyebrow fade-up">
                Canary resilience gate
                {latest?.chaos_mode && latest.chaos_mode !== "none" && <> · {latest.chaos_mode}</>}
                {(latest?.n_samples || 0) > 0 && <> · {latest.n_samples} samples</>}
              </p>
              <h1 className="display fade-up" style={{ color: c.c, animationDelay: "80ms", fontSize: (latest?.status || "").length > 8 ? "clamp(34px,6.2vw,84px)" : undefined }}>{latest?.status}</h1>
              <div className="fade-up" style={{ animationDelay: "160ms", maxWidth: 520 }}>
                <span className="label">Mann-Whitney U confidence</span>
                <ConfBar value={latest?.confidence || 0} color={c.c} />
              </div>
              <p className="lead fade-up" style={{ animationDelay: "240ms" }}>{latest?.reason}</p>
              {(latest?.eval_seconds || 0) > 0 && (
                <p className="note fade-up" style={{ animationDelay: "300ms" }}>
                  Evaluated in {latest.eval_seconds}s · {latest.timestamp}
                </p>
              )}
            </div>
            {stats && (
              <aside className="hero-side fade-up" style={{ animationDelay: "320ms" }}>
                <Ring value={stats.pass_rate} color={GOOD} />
                <span className="label" style={{ marginTop: 14 }}>Historical pass rate</span>
                <span className="note">{stats.total} runs · {stats.passed} passed · {stats.failed} failed</span>
              </aside>
            )}
          </section>
        )}

        <HowItWorks />

        {/* ── METRICS ── */}
        {hasData && (
          <section className="section glow">
            <i className="beam" aria-hidden="true" />
            <Reveal as="h2" className="h2"><em>01</em>The numbers</Reveal>
            <div className="metrics">
              <Metric label="Baseline average" value={latest?.baseline_avg || 0} unit="ms" color={BLUE} delay={0} />
              <Metric label="Canary average"   value={latest?.canary_avg   || 0} unit="ms" color={c.c} delay={60} />
              <Metric label="Degradation"      value={latest?.degradation  || 0} unit="ms" color={degradColor} delay={120}
                note={(latest?.degradation || 0) > 80 ? "Above threshold" : "Within bounds"} />
              <Metric label="Baseline noise"   value={latest?.noise || 0} unit="ms" color={noiseColor} delay={180}
                note={(latest?.noise || 0) > 50 ? "Environment unstable" : "Stable"} />
              <Metric label="Baseline spread"  value={latest?.baseline_std || 0} unit="ms" decimals={2} color={BLUE} delay={0} />
              <Metric label="Canary spread"    value={latest?.canary_std   || 0} unit="ms" decimals={2} color={c.c} delay={60} />
              <Metric label="Error rate"       value={latest?.error_rate   || 0} unit="%" color={errColor} delay={120} />
              <Metric label="Cohen's d"        value={cohensD} decimals={3} color={cdColor} delay={180}
                note={Math.abs(cohensD) < 0.2 ? "Negligible effect" : Math.abs(cohensD) < 0.5 ? "Small effect" : Math.abs(cohensD) < 0.8 ? "Medium effect" : "Large effect"} />
            </div>
            <div className="plats">
              <PLat label="P95 latency" baseline={latest?.p95_baseline || 0} canary={latest?.p95_canary || 0} statusColor={c.c} />
              <PLat label="P99 latency" baseline={latest?.p99_baseline || 0} canary={latest?.p99_canary || 0} statusColor={c.c} delay={80} />
            </div>
          </section>
        )}

        {/* ── SAMPLES + HISTORY ── */}
        <section className="section two-col">
          <div>
            <Reveal as="h2" className="h2"><em>02</em>Latency per request</Reveal>
            <Reveal delay={80}>
              {loading ? <Skel h={300} /> : (
                <LatencyChart series={[
                  { label: "Baseline 1", data: latest?.b1_samples || [],     color: BLUE },
                  { label: "Baseline 2", data: latest?.b2_samples || [],     color: "#9fc1ff" },
                  { label: "Canary",     data: latest?.canary_samples || [], color: c.c },
                ]} />
              )}
            </Reveal>
          </div>

          <div>
            <Reveal as="h2" className="h2">
              <em>03</em>Run history{history.length > 0 && <small> {history.length}</small>}
            </Reveal>
            <div className="history">
              {loading
                ? Array(4).fill(0).map((_, i) => <Skel key={i} h={22} />)
                : history.length === 0
                ? <p className="note">No runs yet. Start the pipeline.</p>
                : history.map((r, i) => <HistRow key={r.id ?? i} run={r} isNew={r.id === flashId && i === 0} />)}
            </div>
          </div>
        </section>

        <VerdictQuote d={latest} />
        <Explain d={latest} />
        <TestPanel jobs={jobs} runner={runner} onSubmit={submitJob} onSample={startSample} busy={busy} message={message} />
        <About connected={connected} />

        <footer className="footer">
          <span>Sentinel-X v4.2 · Kubernetes canary resilience gate</span>
          <span>{updated ? `Updated ${updated}` : "Built by Nitin Vikaas"}</span>
        </footer>
      </main>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   STYLES
   Font: drop Stagtic.woff2 (or .otf/.ttf) into dashboard/frontend/public/fonts/
   and it is picked up automatically; Unbounded is the close fallback.
   ══════════════════════════════════════════════════════════════════════════════ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Unbounded:wght@200;300;400;500;600&display=swap');
@font-face{font-family:"Stagtic";src:url("/fonts/Stagtic.woff2") format("woff2"),url("/fonts/Stagtic.otf") format("opentype"),url("/fonts/Stagtic.ttf") format("truetype");font-display:swap}

:root{
  --bg:#04050a; --ink:#f3f4f8; --muted:#8d92a8; --line:rgba(255,255,255,.10);
  --glass:rgba(255,255,255,.045); --glass-b:rgba(255,255,255,.13);
  --accent:#a496ff; --font:"Stagtic","Unbounded",system-ui,sans-serif;
  --grad:linear-gradient(90deg,#ff5d9e,#6e7bff 55%,#2ee6d6);
  --ease:cubic-bezier(.22,.8,.24,1);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;background:var(--bg)}
body{background:var(--bg);color:var(--ink);font-family:var(--font);font-size:17px;font-weight:300;line-height:1.7;-webkit-font-smoothing:antialiased;color-scheme:dark}
::selection{background:#6e7bff55}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:#ffffff22;border-radius:6px}

.app{min-height:100vh;position:relative;overflow-x:hidden}

/* status-tinted glow in the top corner */
.ambient{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.ambient span{position:absolute;border-radius:50%;filter:blur(130px);animation:drift 28s ease-in-out infinite alternate}
.ambient span:nth-child(1){width:50vw;height:50vw;left:-18vw;top:-24vw;background:var(--tint,#4b3bd1);opacity:.38;transition:background 1.4s ease}
.ambient span:nth-child(2){width:40vw;height:40vw;right:-16vw;top:30vh;background:#12388f;opacity:.28;animation-delay:-9s}
.ambient span:nth-child(3){width:34vw;height:34vw;left:20vw;bottom:-22vw;background:#6a1b4d;opacity:.26;animation-delay:-16s}
@keyframes drift{from{transform:translate3d(0,0,0) scale(1)}to{transform:translate3d(4vw,3vh,0) scale(1.12)}}

/* nav */
.nav{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;padding:18px clamp(20px,5vw,64px);
  background:rgba(4,5,10,.62);backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3)}
.brand{font-size:18px;font-weight:500;letter-spacing:.02em;color:var(--ink);text-decoration:none;display:inline-flex;align-items:center;gap:2px}
.brand i{width:9px;height:9px;border-radius:50%;margin:0 4px;transition:background .6s var(--ease),box-shadow .6s}
.nav-right{display:flex;align-items:center;gap:22px}
.live{display:inline-flex;align-items:center;gap:9px;font-size:16px;color:var(--muted)}
.live i{width:8px;height:8px;border-radius:50%;background:#4a4f63}
.live i.on{background:#3ee6a0;animation:ping 2.4s ease-out infinite}
@keyframes ping{0%{box-shadow:0 0 0 0 #3ee6a077}80%,100%{box-shadow:0 0 0 9px #3ee6a000}}

button{font-family:inherit;font-size:16px;font-weight:400;color:var(--ink);cursor:pointer;background:none;border:0}
a.link{text-decoration:none}
.link{position:relative;color:var(--muted);padding:2px 0;transition:color .25s;font-size:16px}
.link::after{content:"";position:absolute;left:0;right:0;bottom:-2px;height:1px;background:var(--grad);transform:scaleX(0);transform-origin:left;transition:transform .35s var(--ease)}
.link:hover{color:var(--ink)}.link:hover::after{transform:scaleX(1)}

/* gradient-outlined pill, like the reference call-to-action */
.pill{color:var(--ink);padding:11px 24px;border-radius:999px;border:1px solid transparent;
  background:linear-gradient(#090a12,#090a12) padding-box,var(--grad) border-box;
  transition:transform .3s var(--ease),box-shadow .4s,opacity .3s}
.pill:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 8px 34px -8px #6e7bffaa}
.pill:active:not(:disabled){transform:translateY(0)}
.pill:disabled{opacity:.35;cursor:default}
.pill.ghost{background:transparent;box-shadow:inset 0 0 0 1px var(--glass-b);border-color:transparent}
.pill.ghost:hover:not(:disabled){background:var(--glass);box-shadow:inset 0 0 0 1px #ffffff40}

.wrap{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:clamp(28px,6vw,72px) clamp(20px,5vw,64px) 40px}
.error{color:#ff5d73;margin-bottom:32px}

/* type */
.eyebrow{color:var(--muted);font-size:16px;margin-bottom:18px}
.display{font-weight:500;font-size:clamp(48px,10vw,128px);line-height:1;letter-spacing:-.02em;margin-bottom:34px;text-shadow:0 0 70px currentColor}
.muted-display{color:#2a2e40;text-align:center;text-shadow:none}
.h2{font-size:28px;font-weight:300;letter-spacing:-.01em;margin-bottom:38px;line-height:1.2}
.h2 em{display:block;font-style:normal;font-size:16px;font-weight:400;margin-bottom:12px;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;width:max-content}
.h2 small{font-size:17px;color:var(--muted);font-weight:300}
.lead{font-size:18px;line-height:1.75;max-width:680px;color:#c9ccda}
.lead b,.body b{font-weight:500;color:var(--ink)}
.body{font-size:17px;max-width:680px;color:var(--muted);margin-top:16px}
.label{display:block;font-size:16px;color:var(--muted);margin-bottom:8px}
.note{display:block;font-size:16px;color:var(--muted);margin-top:6px}
.sub{display:block;font-size:16px;color:var(--muted)}
.center{text-align:center;margin:0 auto}
code{font-family:inherit;color:#9fb0ff;font-weight:400}
.grad-line{display:block;width:64px;height:3px;border-radius:3px;background:var(--grad);margin-top:18px}
.grad-line.short{width:56px;margin:0 0 22px}

/* hero */
.hero{display:grid;grid-template-columns:1fr auto;gap:48px;align-items:end;padding-bottom:clamp(40px,7vw,80px)}
.hero .lead{margin-top:30px}
.hero-side{display:flex;flex-direction:column;align-items:center;text-align:center;gap:2px;min-width:230px;padding-bottom:6px}
.ring{width:176px;height:176px;color:var(--ink)}
.big{font-size:60px;font-weight:500;line-height:1.1}
.empty{padding:clamp(40px,10vw,120px) 0;text-align:center}
.empty .display{margin-bottom:24px}
.cmd{font-family:inherit;font-size:16px;line-height:2;color:#b5b9cc;text-align:left;margin-top:28px;white-space:pre-wrap;padding-left:20px;border-left:2px solid;border-image:var(--grad) 1}
.center-block{display:inline-block}

/* how it works — tall panels with outlined numerals */
.how{display:grid;grid-template-columns:200px repeat(3,1fr);gap:18px;align-items:stretch;margin-top:clamp(24px,4vw,48px)}
.how-label{display:flex;flex-direction:column;justify-content:center;font-size:22px;line-height:1.35;font-weight:300}
.how-card{display:flex;flex-direction:column;justify-content:space-between;min-height:420px;padding:22px 20px;
  background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));border-radius:6px;transition:transform .5s var(--ease),background .5s}
.how-card:hover{transform:translateY(-6px);background:linear-gradient(180deg,rgba(255,255,255,.09),rgba(255,255,255,.03))}
.how-card b{font-size:17px;font-weight:500}
.how-card p{font-size:16px;line-height:1.65;color:var(--muted);min-height:10.5em}
.numeral{width:100%;height:190px;flex-shrink:0;filter:drop-shadow(0 0 14px #6e7bff55)}

/* sections */
.section{position:relative;padding:clamp(48px,7vw,88px) 0 0;margin-top:clamp(48px,7vw,88px)}
.glow{isolation:isolate}
.beam{position:absolute;left:-30vw;right:-30vw;top:34%;height:230px;z-index:-1;pointer-events:none;
  background:linear-gradient(90deg,transparent,#ff5d9e99 18%,#e2557a99 34%,#6e7bff77 62%,#2ee6d6aa 84%,transparent);
  filter:blur(64px);opacity:.75;animation:beam 14s ease-in-out infinite alternate}
@keyframes beam{from{transform:translateX(-3vw) scaleY(.9)}to{transform:translateX(3vw) scaleY(1.15)}}

/* metrics as soft glass cards with a corner index */
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;counter-reset:m}
.metric{position:relative;display:flex;flex-direction:column;justify-content:space-between;min-height:166px;padding:20px 20px 18px;
  background:var(--glass);border:1px solid var(--glass-b);border-radius:16px;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
  transition:transform .4s var(--ease),border-color .4s,background .4s}
.metric:hover{transform:translateY(-4px);border-color:#ffffff40;background:rgba(255,255,255,.07)}
.metric::after{counter-increment:m;content:counter(m,decimal-leading-zero);align-self:flex-end;font-size:16px;color:var(--muted);margin-top:14px}
.metric-value{font-size:34px;font-weight:500;line-height:1.1;letter-spacing:-.01em}
.metric-value small{font-size:17px;font-weight:300;color:var(--muted);margin-left:4px}
.plats{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
.plat{padding:24px;background:var(--glass);border:1px solid var(--glass-b);border-radius:16px;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
.plat-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px}
.plat-head b{font-size:26px;font-weight:500}
.bar{display:grid;grid-template-columns:96px 1fr 84px;gap:14px;align-items:center;padding:7px 0;font-size:16px}
.bar-name{color:var(--muted)}
.bar-track{height:8px;border-radius:8px;background:var(--line);overflow:hidden}
.bar-fill{height:100%;border-radius:8px;transition:width 1.3s var(--ease);box-shadow:0 0 16px currentColor}
.bar-val{text-align:right;font-weight:500}

.two-col{display:grid;grid-template-columns:1.5fr 1fr;gap:clamp(40px,6vw,88px)}
.chart{width:100%;height:auto;display:block;cursor:crosshair;overflow:visible}
.chart-area{animation:fadeIn 1.6s var(--ease) .4s both}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.legend{display:flex;gap:36px;flex-wrap:wrap;margin-top:22px}
.legend div{display:flex;flex-direction:column;min-width:120px}
.legend span{display:inline-flex;align-items:center;gap:9px;color:var(--muted);font-size:16px}
.legend i{width:10px;height:10px;border-radius:50%;box-shadow:0 0 10px currentColor}
.legend b{font-size:26px;font-weight:500;line-height:1.3}
.legend small{color:var(--muted);font-size:16px}
.history{display:flex;flex-direction:column;max-height:340px;overflow-y:auto}
.hist-row{display:grid;grid-template-columns:10px 56px auto 1fr;gap:14px;align-items:center;padding:11px 0;font-size:16px;transition:transform .3s var(--ease),background .6s}
.hist-row:hover{transform:translateX(5px)}
.hist-row i{width:8px;height:8px;border-radius:50%}
.hist-time{color:var(--muted)}
.hist-status{font-weight:500;white-space:nowrap}
.hist-meta{color:var(--muted);text-align:right}
.hist-row.fresh{animation:fresh 1.4s var(--ease)}
@keyframes fresh{from{background:#6e7bff33;transform:translateY(-6px);opacity:0}to{background:transparent;transform:none;opacity:1}}

/* verdict quote */
.quote-wrap{display:block}
.quote-wrap .quote{max-width:640px;margin:0 auto}
.qmark{position:absolute;width:120px;height:120px;z-index:2;pointer-events:none;filter:drop-shadow(0 0 12px #6e7bff55);left:calc(50% - 395px);top:calc(clamp(48px,7vw,88px) - 26px)}
.qmark.flip{left:auto;right:calc(50% - 395px);top:auto;bottom:-34px;transform:rotate(180deg)}
.quote{padding:34px 36px;background:var(--glass);border:1px solid var(--glass-b);border-radius:16px;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);z-index:1}
.quote p{font-size:18px;line-height:1.8;color:#dfe1ec}
.quote span{display:block;margin-top:22px;font-size:16px;color:var(--muted);text-align:center}

.trail{list-style:none;display:flex;flex-direction:column;gap:16px;max-width:760px}
.trail li{display:flex;gap:16px;align-items:flex-start;font-size:17px;color:#c9ccda}
.trail i{width:8px;height:8px;border-radius:50%;margin-top:11px;flex-shrink:0;box-shadow:0 0 10px currentColor}

/* about */
.about-head{display:flex;justify-content:space-between;align-items:baseline}
.stack{display:flex;flex-wrap:wrap;gap:10px 26px;margin:38px 0;color:var(--muted);font-size:16px}
.stack span{transition:color .25s,transform .3s var(--ease)}
.stack span:hover{color:var(--ink);transform:translateY(-2px)}
.callout{max-width:700px;margin-bottom:24px}
.callout p{color:#c9ccda;margin-bottom:14px}

.collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .55s var(--ease)}
.collapse.open{grid-template-rows:1fr}
.collapse-inner{overflow:hidden;min-height:0}

.footer{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-top:clamp(64px,9vw,120px);padding-top:28px;border-top:1px solid var(--line);color:var(--muted);font-size:16px}

/* confidence */
.confbar{display:flex;align-items:center;gap:16px}
.confbar-track{flex:1;height:3px;background:var(--line);border-radius:3px;overflow:hidden}
.confbar-fill{height:100%;border-radius:3px;transition:width 1.3s var(--ease);box-shadow:0 0 14px currentColor}
.confbar span{font-size:18px;font-weight:500;min-width:54px;text-align:right}

.spark-line{stroke-dasharray:1;stroke-dashoffset:1;animation:draw 1.6s var(--ease) .15s forwards;filter:drop-shadow(0 0 5px currentColor)}
@keyframes draw{to{stroke-dashoffset:0}}

.skel{border-radius:8px;background:linear-gradient(90deg,#10121c 25%,#1a1d2c 50%,#10121c 75%);background-size:200% 100%;animation:shimmer 1.6s ease infinite}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* test panel = closing call-to-action under a teal spotlight */
.cta{isolation:isolate;padding-top:clamp(120px,14vw,190px)}
.spot{position:absolute;left:50%;top:0;width:min(520px,80vw);height:560px;transform:translateX(-50%);z-index:-1;pointer-events:none}
.spot::before{content:"";position:absolute;left:18%;right:18%;top:0;height:30px;background:linear-gradient(#3fe0e8,#1aa8b8);box-shadow:0 0 80px 26px #2ee6d655}
.spot::after{content:"";position:absolute;left:-30%;right:-30%;top:10px;bottom:0;
  background:radial-gradient(ellipse 50% 100% at 50% 0,#2ee6d655,#2ee6d610 55%,transparent 75%);filter:blur(10px)}
.cta>.h2,.cta>.lead,.cta>.runner-line{text-align:center;margin-left:auto;margin-right:auto}
.cta>.h2 em{margin-left:auto;margin-right:auto}
.runner-line{display:flex;align-items:center;justify-content:center;gap:10px;color:var(--muted);margin:22px 0 56px;font-size:16px}
.runner-line i{width:8px;height:8px;border-radius:50%;background:#4a4f63;flex-shrink:0}
.runner-line i.on{background:#3ee6a0;animation:ping 2.4s ease-out infinite}
.test-grid{display:grid;grid-template-columns:1.1fr 1fr;gap:clamp(40px,6vw,88px);align-items:start}
.form{display:flex;flex-direction:column;gap:26px}
.form>.link{align-self:flex-start}
.field{display:flex;flex-direction:column;gap:2px}
.field input[type=text],.field input[type=number],.field input[type=password],.field select{
  font:inherit;font-size:17px;color:var(--ink);background:transparent;border:0;border-bottom:1px solid var(--glass-b);
  padding:8px 0;outline:none;border-radius:0;transition:border-color .3s}
.field input:focus,.field select:focus{border-bottom-color:#6e7bff}
.field select{appearance:none;cursor:pointer}
.field select option{background:#0b0d16;color:var(--ink)}
.field input[type=file]{font:inherit;font-size:16px;color:var(--muted);padding:8px 0}
.field input[type=file]::file-selector-button{font:inherit;font-size:16px;color:var(--ink);background:var(--glass);border:1px solid var(--glass-b);border-radius:999px;padding:8px 18px;margin-right:14px;cursor:pointer;transition:background .3s}
.field input[type=file]::file-selector-button:hover{background:#6e7bff33}
.adv{display:grid;grid-template-columns:1fr 1fr;gap:22px 28px;padding-top:18px}
.form-actions{display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.form-msg{font-size:16px}
.sample-btns{display:flex;gap:14px;flex-wrap:wrap;margin:6px 0 12px}
.samples-box{margin-bottom:44px}
.jobs{display:flex;flex-direction:column;gap:28px}
.job-head{display:flex;justify-content:space-between;gap:16px;font-size:17px;margin-bottom:10px}
.job-head b{font-weight:500}
.job-track{height:3px;background:var(--line);border-radius:3px;overflow:hidden}
.job-fill{height:100%;border-radius:3px;transition:width .9s var(--ease),background .4s;box-shadow:0 0 12px currentColor}

/* entrance */
.fade-up{opacity:0;animation:fadeUp .9s var(--ease) forwards}
@keyframes fadeUp{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}
.reveal{opacity:0;transform:translateY(24px);transition:opacity .9s var(--ease),transform .9s var(--ease)}
.reveal.in{opacity:1;transform:none}

@media (max-width:980px){
  .how{grid-template-columns:1fr 1fr 1fr}.how-label{grid-column:1/-1;margin-bottom:8px}
  .how-card{min-height:340px}
}
@media (max-width:900px){
  .hero{grid-template-columns:1fr}
  .hero-side{align-items:flex-start;text-align:left;padding-top:12px}
  .metrics{grid-template-columns:repeat(2,1fr)}
  .plats,.two-col,.test-grid{grid-template-columns:1fr}
  .adv{grid-template-columns:1fr}
  .qmark{display:none}
}
@media (max-width:640px){.how{grid-template-columns:1fr}.how-card{min-height:300px}}
@media (max-width:520px){
  .metrics{grid-template-columns:1fr}
  .nav-right{gap:14px}.live{display:none}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
  .reveal,.fade-up{opacity:1;transform:none}
  .spark-line{stroke-dashoffset:0}
}
`;
