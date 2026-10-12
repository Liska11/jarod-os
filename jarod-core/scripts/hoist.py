"""
hoist.py : les déclarations déplacées dans @jarod/contracts sont retirées des fichiers portés et
remplacées par un import + ré-export (les importeurs existants continuent de marcher tels quels).

    python scripts/hoist.py <fichier porté> NAME [NAME...]
"""
import re
import sys

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from extract_lib import extract  # noqa: E402


def hoist(path, names):
    text = open(path, encoding="utf-8").read()
    values, types = [], []
    for n in names:
        tmp = path + ".tmp"
        open(tmp, "w", encoding="utf-8", newline="\n").write(text)
        a, b, block = extract(tmp, n)
        lines = text.split("\n")
        kind = re.search(r"^export (?:declare )?(interface|type|const|function|class|enum) ", block, re.M).group(1)
        (types if kind in ("interface", "type") else values).append(n)
        lines[a - 1 : b] = [f"// {n} : déplacé dans @jarod/contracts (ré-exporté ci-dessous)."]
        text = "\n".join(lines)
    import os

    os.remove(path + ".tmp")
    spec = ", ".join([f"type {t}" for t in types] + values)
    imp = f'import {{ {spec} }} from "@jarod/contracts";\n'
    exp = "export { " + ", ".join(values) + " };\n" if values else ""
    exp += "export type { " + ", ".join(types) + " };\n" if types else ""
    # après le dernier import en tête de fichier
    lines = text.split("\n")
    last = max((i for i, l in enumerate(lines[:80]) if l.startswith("import ") or l.startswith("} from ")), default=0)
    lines.insert(last + 1, imp + exp.rstrip("\n"))
    open(path, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
    print(path, "->", spec)


if __name__ == "__main__":
    hoist(sys.argv[1], sys.argv[2:])
