"""Fermeture PyPI (MÉTADONNÉES SEULES) d'une liste de racines arbitraires, avec le résolveur de `pypi_closure.py`.
Rien n'est téléchargé hors JSON de métadonnées. usage : py -3.12 scripts/pypi_closure_roots.py <nom> <sortie-requirements.txt> <racine> [<racine>…]
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pypi_closure as pc

name, out, roots = sys.argv[1], sys.argv[2], sys.argv[3:]
res = pc.resolve(roots)
rows, total = [], 0
for n in sorted(res):
    ver, f, kind, ex = res[n]
    info = pc.release(n, str(ver))["info"]
    rows.append(dict(name=n, version=str(ver), kind=kind, file=f["filename"], size=f["size"], sha256=f["digests"]["sha256"], license=pc.lic(info), requires_python=info.get("requires_python")))
    total += f["size"]
json.dump(dict(profile=name, roots=roots, total_bytes=total, packages=rows), open(os.path.join(pc.ROOT, ".work", f"closure-{name}.json"), "w", encoding="utf8"), indent=1)
nl = chr(10)
with open(out, "w", encoding="utf8", newline=nl) as fh:
    fh.write(f"# {name} : {len(rows)} wheels, résolus par les MÉTADONNÉES de l'API JSON de PyPI (aucun wheel téléchargé) pour cp312 / win_amd64.{nl}")
    fh.write(f"# Installation : pip install --no-deps --require-hashes --only-binary=:all: --no-cache-dir --isolated -r <ce fichier>{nl}")
    for r in rows:
        fh.write(f"{r['name']}=={r['version']} --hash=sha256:{r['sha256']}{nl}")
print(f"{name}: {len(rows)} paquets, {total} octets ({total/1048576:.1f} Mio)")
for r in rows:
    print(f"{r['name']:28} {r['version']:12} {r['kind']:6} {r['size']:>11}  {r['license'][:38]}")
