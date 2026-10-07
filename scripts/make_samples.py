"""Zip the sample services into dashboard/backend/samples/ (bundled with the API)."""
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dashboard" / "backend" / "samples"
OUT.mkdir(parents=True, exist_ok=True)

for name in ("good-service", "slow-service"):
    src = ROOT / "samples" / name
    dest = OUT / f"{name}.zip"
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(src.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(src).as_posix())
    print("wrote", dest.relative_to(ROOT), dest.stat().st_size, "bytes")
