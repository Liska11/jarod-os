"""extract.py FILE NAME... : imprime la déclaration exportée NAME (avec son JSDoc) et sa plage de lignes."""
import re, sys

STR = re.compile(r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|`(?:[^`\\]|\\.)*`')


def extract(path, name):
    L = open(path, encoding="utf-8").read().split("\n")
    pat = re.compile(r"^export (declare )?(abstract )?(interface|type|const|function|async function|class|enum) " + re.escape(name) + r"\b")
    for i, l in enumerate(L):
        if pat.match(l):
            break
    else:
        raise SystemExit(f"{name} introuvable dans {path}")
    s = i
    j = i - 1
    if j >= 0 and L[j].strip().endswith("*/"):
        while j >= 0 and not L[j].lstrip().startswith("/*"):
            j -= 1
        s = j
    while s - 1 >= 0 and L[s - 1].lstrip().startswith("//"):
        s -= 1
    depth = 0
    started = False
    e = i
    in_comment = False
    for k in range(i, len(L)):
        code = STR.sub('""', L[k])
        if in_comment:
            if "*/" not in code:
                continue
            code = code.split("*/", 1)[1]
            in_comment = False
        code = re.sub(r"/\*.*?\*/", "", code)
        if "/*" in code:
            code = code.split("/*", 1)[0]
            in_comment = True
        code = re.sub(r"//.*", "", code)
        for ch in code:
            if ch in "{[(":
                depth += 1
                started = True
            elif ch in "}])":
                depth -= 1
        e = k
        if (started and depth <= 0 and not code.rstrip().endswith((",", "|", "&", "=", "=>"))) or (not started and code.rstrip().endswith(";")):
            break
    return s + 1, e + 1, "\n".join(L[s : e + 1])


if __name__ == "__main__":
    path = sys.argv[1]
    for n in sys.argv[2:]:
        a, b, t = extract(path, n)
        print(f"// {path}:{a}-{b}")
        print(t)
        print()
