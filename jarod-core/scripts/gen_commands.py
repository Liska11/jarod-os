"""
Extrait les commandes intégrées de core.ts (registerBuiltinCommands, rév. 2e180305) par nom et les
réécrit en fonction `registerXCommands(core)` : `this.` → `core.`. Corps inchangés.

    python scripts/gen_commands.py <sortie.ts> <fonction> <nom> [<nom>...]
"""
import re
import sys

SRC = "S:/Jarod-one/packages/core/src/core.ts"
lines = open(SRC, encoding="utf-8").read().split("\n")
start = next(i for i, l in enumerate(lines) if l.startswith("  private registerBuiltinCommands(): void {"))
end = start + 1
depth = 1
while depth > 0:
    depth += lines[end].count("{") - lines[end].count("}")
    end += 1
body = lines[start + 1 : end - 1]

# prologue (jusqu'au premier add("…")) puis blocs `add(` / `add(\n "nom"`
first = next(i for i, l in enumerate(body) if re.match(r'\s{4}add\(', l))
prologue = body[:first]
blocks = []
i = first
while i < len(body):
    if not re.match(r"\s{4}add\(", body[i]):
        i += 1
        continue
    j = i
    d = 0
    while True:
        d += body[j].count("(") - body[j].count(")")
        j += 1
        if d <= 0 and body[j - 1].rstrip().endswith(");"):
            break
    block = body[i:j]
    m = re.search(r'add\(\s*"([a-z-]+)"', "\n".join(block))
    blocks.append((m.group(1), block, start + 2 + i, start + 1 + j))
    i = j

out_path, fn, names = sys.argv[1], sys.argv[2], sys.argv[3:]
chosen = [b for b in blocks if b[0] in names]
missing = set(names) - {b[0] for b in chosen}
if missing:
    raise SystemExit(f"introuvables : {missing}")
text = [
    f"  // Prologue — core.ts:{start + 2}-{start + 1 + first}",
    *prologue,
]
for name, block, a, b in chosen:
    text.append(f"    // /{name} — core.ts:{a}-{b}")
    text.extend(block)
src = "\n".join(text).replace("this.", "core.")
open(out_path, "w", encoding="utf-8", newline="\n").write(
    f"export function {fn}(core: CommandHost): void {{\n{src}\n}}\n"
)
print(f"{len(chosen)} commandes ; toutes : {[b[0] for b in blocks]}")
