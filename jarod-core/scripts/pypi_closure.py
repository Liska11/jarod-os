"""Résolution PAR MÉTADONNÉES SEULES (API JSON de PyPI) de la fermeture d'un profil docling-slim (dernière version compatible).
Rien n'est téléchargé hors JSON de métadonnées : aucun paquet, aucune roue (`pip --dry-run` en télécharge : non utilisé).
Interpréteur ciblé : celui qui l'exécute (py -3.12 : cp312 / win_amd64). Cache JSON dans .work/pypi-cache/ (ignoré par Git).
usage : py -3.12 scripts/pypi_closure.py <profil> <extra1,extra2,...> [requirements-sortie.txt]
Sortie : résumé sur stdout, .work/closure-<profil>.json, et (si demandé) le fichier `nom==version --hash=sha256:…` pour
`pip install --no-deps --require-hashes --only-binary=:all:`.
"""
import json, os, sys, time, urllib.request, urllib.error
from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.version import Version, InvalidVersion
from pip._vendor.packaging.specifiers import SpecifierSet
from pip._vendor.packaging.utils import canonicalize_name, parse_wheel_filename
from pip._vendor.packaging.tags import sys_tags
from pip._vendor.packaging.markers import default_environment

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".work", "pypi-cache")
os.makedirs(CACHE, exist_ok=True)
TAGS = set(sys_tags())
ENV = default_environment()


def fetch(url, key):
    path = os.path.join(CACHE, key + ".json")
    if os.path.exists(path):
        return json.load(open(path, encoding="utf8"))
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "jarod-cordis-metadata-only"}), timeout=60) as r:
                data = json.load(r)
            json.dump(data, open(path, "w", encoding="utf8"))
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(1 + attempt)
        except Exception:
            time.sleep(1 + attempt)
    raise RuntimeError("échec réseau : " + url)


def project(name):
    return fetch(f"https://pypi.org/pypi/{name}/json", f"p-{name}")


def release(name, version):
    return fetch(f"https://pypi.org/pypi/{name}/{version}/json", f"r-{name}-{version}")


def pick_file(files):
    """Roue compatible (win_amd64/cp312) la plus spécifique ; sinon sdist (à signaler)."""
    wheels = []
    sdist = None
    for f in files:
        if f.get("yanked"):
            continue
        fn = f["filename"]
        if f["packagetype"] == "bdist_wheel":
            try:
                _, _, _, tags = parse_wheel_filename(fn)
            except Exception:
                continue
            if any(t in TAGS for t in tags):
                wheels.append((min(i for i, t in enumerate(sys_tags()) if t in tags), f))
        elif f["packagetype"] == "sdist":
            sdist = f
    if wheels:
        return sorted(wheels, key=lambda x: x[0])[0][1], "wheel"
    return sdist, "sdist"


def best(name, spec):
    p = project(name)
    if p is None:
        raise RuntimeError("projet introuvable : " + name)
    cands = []
    for v, files in p["releases"].items():
        try:
            ver = Version(v)
        except InvalidVersion:
            continue
        if ver.is_prerelease and not spec.prereleases:
            continue
        if not files or ver not in spec:
            continue
        f, kind = pick_file(files)
        if f is None:
            continue
        cands.append((ver, f, kind))
    if not cands:
        raise RuntimeError(f"aucune version de {name} ne satisfait {spec} pour cet interpréteur")
    cands.sort(key=lambda c: c[0], reverse=True)
    return cands[0]


def resolve(roots):
    """roots : liste de chaînes de requirement. Retourne {nom: (version, fichier, genre, extras)}."""
    chosen = {}
    for _ in range(25):
        constraints, extras, queue = {}, {}, []
        for r in roots:
            queue.append((Requirement(r), "racine"))
        seen = set()
        while queue:
            req, origin = queue.pop()
            name = canonicalize_name(req.name)
            constraints.setdefault(name, SpecifierSet())
            constraints[name] &= req.specifier
            new_extras = extras.setdefault(name, set())
            before = set(new_extras)
            new_extras |= set(canonicalize_name(e) for e in req.extras)
            key = (name, str(constraints[name]), tuple(sorted(new_extras)), chosen.get(name, (None,))[0])
            if name not in chosen:
                ver, f, kind = best(name, constraints[name])
                chosen[name] = (ver, f, kind, set())
            ver = chosen[name][0]
            if ver not in constraints[name]:
                ver, f, kind = best(name, constraints[name])
                chosen[name] = (ver, f, kind, set())
            if (name, str(ver), tuple(sorted(new_extras))) in seen and before == new_extras:
                continue
            seen.add((name, str(ver), tuple(sorted(new_extras))))
            rel = release(name, str(ver))
            for line in (rel["info"].get("requires_dist") or []):
                d = Requirement(line)
                if d.marker is None:
                    queue.append((d, name))
                    continue
                if any(d.marker.evaluate({**ENV, "extra": e}) for e in (new_extras or {""}) ) or (not new_extras and d.marker.evaluate({**ENV, "extra": ""})):
                    queue.append((d, name))
        # stabilité : chaque choix satisfait toutes les contraintes
        ok = True
        for n, (ver, f, kind, _) in list(chosen.items()):
            if n not in constraints:
                del chosen[n]
                ok = False
            elif ver not in constraints[n]:
                del chosen[n]
                ok = False
        if ok:
            return {n: (c[0], c[1], c[2], extras.get(n, set())) for n, c in chosen.items()}
    raise RuntimeError("pas de point fixe (conflit de contraintes ?)")


def lic(info):
    e = info.get("license_expression")
    if e:
        return e
    cl = [c.split("::")[-1].strip() for c in (info.get("classifiers") or []) if c.startswith("License ::")]
    if cl:
        return "; ".join(cl)
    l = (info.get("license") or "").strip().splitlines()
    return (l[0][:60] if l else "inconnue")


if __name__ == "__main__":
    prof, extras = sys.argv[1], [e for e in sys.argv[2].split(",") if e]
    root = "docling-slim[" + ",".join(extras) + "]==2.131.0"
    res = resolve([root])
    rows = []
    total = 0
    for n in sorted(res):
        ver, f, kind, ex = res[n]
        info = release(n, str(ver))["info"]
        rows.append(dict(name=n, version=str(ver), kind=kind, file=f["filename"], size=f["size"], sha256=f["digests"]["sha256"], url=f["url"],
                         upload=f.get("upload_time_iso_8601"), license=lic(info), requires_python=info.get("requires_python")))
        total += f["size"]
    out = dict(profile=prof, root=root, python=sys.version.split()[0], platform=ENV["sys_platform"] + "/" + ENV["platform_machine"], total_bytes=total, packages=rows)
    json.dump(out, open(os.path.join(ROOT, ".work", f"closure-{prof}.json"), "w", encoding="utf8"), indent=1)
    if len(sys.argv) > 3:
        nl = chr(10)
        with open(sys.argv[3], "w", encoding="utf8", newline=nl) as fh:
            fh.write(f"# {prof} : {len(rows)} wheels, résolus par les MÉTADONNÉES de l'API JSON de PyPI (aucun wheel téléchargé) pour cp312 / win_amd64.{nl}")
            fh.write(f"# Installation : pip install --no-deps --require-hashes --only-binary=:all: --no-cache-dir --isolated -r <ce fichier>{nl}")
            for r in rows:
                fh.write(f"{r['name']}=={r['version']} --hash=sha256:{r['sha256']}{nl}")
    print(f"{prof}: {len(rows)} paquets, {total} octets ({total/1048576:.1f} Mio), python {out['python']}")
    for r in rows:
        print(f"{r['name']:28} {r['version']:12} {r['kind']:6} {r['size']:>11}  {r['license'][:38]:38} {r['file'] if r['kind']!='wheel' else ''}")
