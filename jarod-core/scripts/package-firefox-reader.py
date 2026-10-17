"""Empaquette l'extension Firefox de lecture ponctuelle en une archive REPRODUCTIBLE (ordre fixe, horodatages fixes), prête à être soumise à la signature.

    python jarod-core/scripts/package-firefox-reader.py [dossier-de-sortie]
    python jarod-core/scripts/package-firefox-reader.py --verify <extension-signee.xpi>

Écrit `jarod-reader-<version>.zip` et son empreinte sha256. Ne signe rien, ne soumet rien, n'installe rien : la signature se fait avec le compte de l'utilisateur
(voir docs/E2-FIREFOX-READER-PLAN.md § 8).
"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "sidecars" / "firefox-reader"
FILES = ["manifest.json", "background.js", "options.html", "options.js"]  # liste fermée : rien d'autre n'entre dans le paquet


if len(sys.argv) == 3 and sys.argv[1] == "--verify":
    # Le paquet signé doit contenir EXACTEMENT nos quatre fichiers, octet pour octet (plus les fichiers de signature de Mozilla sous META-INF/).
    with zipfile.ZipFile(sys.argv[2]) as z:
        names = sorted(n for n in z.namelist() if not n.startswith("META-INF/") and not n.endswith("/"))
        bad = [n for n in names if n not in FILES or z.read(n) != (SRC / n).read_bytes()]
        missing = [n for n in FILES if n not in names]
        signed = any(n.startswith("META-INF/") for n in z.namelist())
    if bad or missing or not signed:
        sys.exit(f"NON CONFORME : différents ou en trop {bad}, manquants {missing}, signature {'présente' if signed else 'ABSENTE'}")
    print("conforme : mêmes quatre fichiers, mêmes octets, signature présente")
    sys.exit(0)

manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
out = Path(sys.argv[1]) if len(sys.argv) > 1 else SRC.parent.parent / "dist" / "firefox-reader"
out.mkdir(parents=True, exist_ok=True)
target = out / f"jarod-reader-{manifest['version']}.zip"
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
    for name in FILES:
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, (SRC / name).read_bytes())
extra = sorted(p.name for p in SRC.iterdir() if p.name not in FILES)
if extra:
    sys.exit(f"fichiers non listés dans {SRC} : {extra} (ajoutez-les à FILES après examen, ou retirez-les)")
digest = hashlib.sha256(target.read_bytes()).hexdigest()
(out / f"{target.name}.sha256").write_text(f"{digest}  {target.name}\n", encoding="utf-8")
print(f"{target}\nsha256 {digest}")
