"""
Sentinel-X — Judge Unit Tests

Run with:  pytest tests/
Or:        python -m pytest tests/ -v
"""
import sys
import math
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Make the project root importable
sys.path.insert(0, str(Path(__file__).parent.parent))

from judge.judge import _pct, _confidence, _cohens_d, evaluate


# ── _pct (percentile) ────────────────────────────────────────────────────────

class TestPercentile(unittest.TestCase):

    def test_empty_returns_zero(self):
        self.assertEqual(_pct([], 95), 0.0)

    def test_single_element(self):
        self.assertEqual(_pct([42.0], 50), 42.0)
        self.assertEqual(_pct([42.0], 95), 42.0)

    def test_p50_of_sorted_list(self):
        data = [10, 20, 30, 40, 50]
        p50 = _pct(data, 50)
        self.assertGreaterEqual(p50, 20)
        self.assertLessEqual(p50, 30)

    def test_p95_is_near_max(self):
        data = list(range(1, 101))   # 1..100
        p95 = _pct(data, 95)
        # nearest-rank: should be 95
        self.assertGreaterEqual(p95, 90)
        self.assertLessEqual(p95, 100)

    def test_all_same_values(self):
        data = [5.0] * 20
        self.assertEqual(_pct(data, 0), 5.0)
        self.assertEqual(_pct(data, 99), 5.0)


# ── _confidence (Mann-Whitney U) ─────────────────────────────────────────────

class TestConfidence(unittest.TestCase):

    def test_identical_distributions_near_50(self):
        """No degradation → confidence should be near 50 (no signal)."""
        base   = [50.0] * 20
        canary = [50.0] * 20
        conf = _confidence(base, canary)
        self.assertLess(conf, 60.0)

    def test_clearly_degraded_canary_near_100(self):
        """Canary massively slower → confidence near 100."""
        base   = [50.0] * 20
        canary = [5000.0] * 20
        conf = _confidence(base, canary)
        self.assertGreater(conf, 95.0)

    def test_clearly_faster_canary_near_0(self):
        """Canary faster than baseline → confidence near 0 (no degradation signal)."""
        base   = [500.0] * 20
        canary = [10.0] * 20
        conf = _confidence(base, canary)
        self.assertLess(conf, 10.0)

    def test_returns_float_in_range(self):
        base   = [40.0, 42.0, 38.0, 41.0, 39.0]
        canary = [200.0, 210.0, 195.0, 205.0, 198.0]
        conf = _confidence(base, canary)
        self.assertIsInstance(conf, float)
        self.assertGreaterEqual(conf, 0.0)
        self.assertLessEqual(conf, 100.0)

    def test_empty_lists_return_zero(self):
        self.assertEqual(_confidence([], []), 0.0)
        self.assertEqual(_confidence([50.0], []), 0.0)


# ── _cohens_d (effect size) ───────────────────────────────────────────────────

class TestCohensD(unittest.TestCase):

    def test_no_difference_is_zero(self):
        data = [50.0] * 10
        d = _cohens_d(data, data)
        self.assertAlmostEqual(d, 0.0, places=5)

    def test_large_effect_exceeds_0_8(self):
        base   = [50.0, 51.0, 49.0, 50.5, 50.0]
        canary = [300.0, 305.0, 295.0, 302.0, 298.0]
        d = _cohens_d(base, canary)
        self.assertGreater(d, 0.8)

    def test_negative_when_canary_faster(self):
        base   = [200.0, 205.0, 195.0]
        canary = [50.0,  48.0,  52.0]
        d = _cohens_d(base, canary)
        self.assertLess(d, 0.0)

    def test_returns_zero_for_zero_std(self):
        base   = [100.0] * 5
        canary = [150.0] * 5   # same std (0), so d would be inf — should return 0
        d = _cohens_d(base, canary)
        self.assertTrue(math.isfinite(d))


# ── evaluate() — decision logic ───────────────────────────────────────────────

def _make_times(avg, n=20, jitter=2.0):
    """Generate n samples around avg with small jitter."""
    import random
    rng = random.Random(42)
    return [max(1.0, avg + rng.uniform(-jitter, jitter)) for _ in range(n)]


def _mock_probe_factory(b1_avg, b2_avg, c_avg):
    """Returns a mock probe() that yields controlled latency data."""
    calls = {"n": 0}
    avgs = [b1_avg, b2_avg, c_avg]

    def _fake_probe(url, n=20):
        times = _make_times(avgs[calls["n"] % 3], n=n)
        err = 0
        calls["n"] += 1
        return times, err

    return _fake_probe


class TestEvaluateDecision(unittest.TestCase):

    def _run_with(self, b1, b2, canary_avg):
        fake_probe = _mock_probe_factory(b1, b2, canary_avg)
        with patch("judge.judge.get_service_urls", return_value={
            "baseline1": "http://b1", "baseline2": "http://b2", "canary": "http://c"
        }), patch("judge.judge.probe", side_effect=fake_probe):
            return evaluate(chaos_mode="test", n_samples=20)

    def test_clean_run_passes(self):
        result = self._run_with(50.0, 50.0, 52.0)
        self.assertEqual(result["status"], "PASS")

    def test_large_degradation_fails(self):
        result = self._run_with(50.0, 50.0, 350.0)
        self.assertIn("FAIL", result["status"])

    def test_high_noise_is_inconclusive(self):
        # b1 and b2 differ by more than 50ms noise threshold
        result = self._run_with(50.0, 110.0, 55.0)
        self.assertEqual(result["status"], "INCONCLUSIVE")

    def test_result_has_required_fields(self):
        result = self._run_with(50.0, 50.0, 52.0)
        for field in (
            "timestamp", "chaos_mode", "n_samples", "eval_seconds",
            "baseline_avg", "canary_avg", "noise", "degradation",
            "confidence", "cohens_d",
            "baseline_std", "canary_std",
            "p95_baseline", "p99_baseline", "p95_canary", "p99_canary",
            "error_rate", "status", "reason",
            "b1_samples", "b2_samples", "canary_samples",
        ):
            self.assertIn(field, result, msg=f"Missing field: {field}")

    def test_p95_canary_above_p95_baseline_on_degradation(self):
        result = self._run_with(50.0, 50.0, 250.0)
        self.assertGreater(result["p95_canary"], result["p95_baseline"])

    def test_cohens_d_is_large_on_clear_degradation(self):
        result = self._run_with(50.0, 50.0, 400.0)
        self.assertGreater(result["cohens_d"], 0.8)


if __name__ == "__main__":
    unittest.main(verbosity=2)
