"""
Porte des tests de packages/core/test vers un plugin (lecture seule sur la source).

    python scripts/port_tests.py <plugin cible> <fichier.test.ts> [...]

- imports `../src/<module>` → module du plugin cible (`../src/x.js`) ou package qui l'héberge ;
- `import … from "./helpers.js"` conservé (chaque plugin a son helpers.ts) ;
- `makeCore(` synchrone → `await makeCore(` ; toute fonction qui se met à attendre devient `async`,
  et ses appels sont à leur tour attendus (point fixe) ;
- le type `JarodCore` devient `TestCore` (helpers.ts) ; `new JarodCore(` est signalé.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from porter import MAP, spec_of  # noqa: E402

TEST_SRC = "S:/Jarod-one/packages/core/test/"
ROOT = "S:/store/projet/jarod-cordis/packages/plugins/"

AGG = {"core.ts": "plugins/agent", "index.ts": "plugins/agent", "types.ts": "contracts", "providers/types.ts": "contracts"}
TEST_DECL = re.compile(r'\b(it|test)(\.skip|\.only|\.runIf\([^)]*\)|\.skipIf\([^)]*\))?\((\s*"(?:[^"\\]|\\.)*"|\s*`[^`]*`|\s*\'[^\']*\'),(\s*\{[^}]*\},)?\s*\(\)\s*=>')
FN_DECL = re.compile(r"^(\s*)(export )?function (\w+)\(")
ARROW_DECL = re.compile(r"^(\s*)(export )?const (\w+) = (\([^)]*\)|\w+)(: [^=]+)? =>")


def make_async_enclosing(lines, i, notes, made):
    """Rend async la fonction qui contient la ligne i. Retourne le nom si c'est une fonction nommée."""
    for j in range(i, -1, -1):
        lj = lines[j]
        if TEST_DECL.search(lj):
            lines[j] = TEST_DECL.sub(lambda m: m.group(0).replace("() =>", "async () =>"), lj, count=1)
            return None
        if re.search(r"\basync\b", lj) and ("=>" in lj or "function" in lj or re.search(r"async \w+\(", lj)):
            return None
        m = FN_DECL.match(lj)
        if m:
            lines[j] = lj.replace("function ", "async function ", 1)
            made.add(m.group(3))
            notes.append(f"async: {m.group(3)}")
            return m.group(3)
        m = ARROW_DECL.match(lj)
        if m:
            lines[j] = lj.replace(" = ", " = async ", 1)
            made.add(m.group(3))
            notes.append(f"async: {m.group(3)}")
            return m.group(3)
        # méthode d'objet / callback anonyme : on s'arrête à l'ouverture de bloc de niveau fonction
        if re.search(r"\(\) => \{\s*$|\) => \{\s*$", lj) and not TEST_DECL.search(lj):
            lines[j] = re.sub(r"(\((?:[^()]*)\)) => \{\s*$", r"async \1 => {", lj, count=1)
            return None
    return None


def port(plugin, name):
    text = open(TEST_SRC + name, encoding="utf-8").read()
    notes = []

    def rewrite(m):
        rel = m.group(2)[len("../src/"):]
        rel = rel[:-3] + ".ts" if rel.endswith(".js") else rel
        if rel in MAP:
            pkg, f = MAP[rel]
        elif rel in AGG:
            pkg, f = AGG[rel], None
        else:
            notes.append(rel)
            return m.group(0)
        if f and pkg == "plugins/" + plugin:
            return f'{m.group(1)}"../src/{f[:-3]}.js"'
        if pkg == "plugins/" + plugin:
            return f'{m.group(1)}"../src/index.js"'
        return f'{m.group(1)}"{spec_of(pkg)}"'

    text = re.sub(r'(from\s+)"(\.\./src/[^"]+)"', rewrite, text)
    # le type JarodCore → TestCore
    text = re.sub(r"import type \{ JarodCore \} from \"[^\"]+\";\n", 'import type { TestCore as JarodCore } from "./helpers.js";\n', text)
    text = re.sub(r"import \{ JarodCore \} from \"[^\"]+\";\n", 'import type { TestCore as JarodCore } from "./helpers.js";\n', text)
    text = re.sub(r"\btype JarodCore, ", "", text)
    text = text.replace("ReturnType<typeof makeCore>", "Awaited<ReturnType<typeof makeCore>>")
    # `new JarodCore(opts)` → `makeCore(opts)` (le helper accepte dataDir/keyStores/cipher…)
    text = text.replace("new JarodCore(", "makeCore(")
    text = re.sub(r"(?<!await )(?<!function )\bmakeCore\(", "await makeCore(", text)

    made = set()
    pending = {"makeCore"}
    seen = set()
    while pending:
        fn = pending.pop()
        seen.add(fn)
        lines = text.split("\n")
        for i, l in enumerate(lines):
            if fn != "makeCore":
                l2 = re.sub(r"(?<!await )(?<!function )(?<![\w.])" + fn + r"\(", "await " + fn + "(", l)
                if l2 != l and not FN_DECL.match(l) and not ARROW_DECL.match(l):
                    lines[i] = l = l2
            if f"await {fn}(" in l:
                got = make_async_enclosing(lines, i, notes, made)
                if got and got not in seen:
                    pending.add(got)
        text = "\n".join(lines)
    if "new JarodCore(" in text:
        notes.append("new JarodCore( à adapter")
    out = ROOT + plugin + "/test/" + name
    os.makedirs(os.path.dirname(out), exist_ok=True)
    header = f"// Portage de packages/core/test/{name} (rév. 2e180305).\n"
    open(out, "w", encoding="utf-8", newline="\n").write(header + text)
    print(f"{name} -> {plugin}" + (f"  NOTES: {notes}" if notes else ""))


if __name__ == "__main__":
    for n in sys.argv[2:]:
        port(sys.argv[1], n)
