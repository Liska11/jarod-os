"""
Réécrit le `If` « vérificateur » d'un classifieur openWakeWord en `Where`, sans aucune dépendance.

    python scripts/onnx_if_to_where.py <entrée.onnx> <sortie.onnx>

Pourquoi : `hey_jarvis_v0.1.onnx` (openWakeWord v0.5.1) se termine par
`If(Cast(p1 >= c), then: p2 = vérificateur(x), else: p1)` avec une condition de forme [1,1] ;
le frontal ONNX d'OpenVINO 2026.4 exige une condition de rang 0 ou 1 et refuse le modèle
(« Rank of If condition input must be equal to 0 or 1 »). onnxruntime, lui, l'accepte.

Réécriture (même résultat, graphe statique, compatible NPU) :
    nœuds de la branche `then` remontés dans le graphe principal (ils ne lisent que `x` et des
    initialiseurs du graphe principal), branche `else` = Identity(p1) supprimée,
    `If` remplacé par `Where(cond, p2, p1)` (les deux petites branches sont calculées).
Le script échoue sur toute forme inattendue (un seul `If`, `else` = une Identity, noms sans collision).
Le fichier d'entrée n'est jamais modifié. Vérification numérique : voir DECISIONS (onnxruntime).
Protobuf ONNX lu et écrit au niveau du format filaire : champs inconnus recopiés octet pour octet.
"""
import sys

# ModelProto.graph = 7 ; GraphProto.node = 1 ; NodeProto : input 1, output 2, name 3, op_type 4,
# attribute 5 ; AttributeProto : name 1, g 6 ; GraphProto.output = 12 ; ValueInfoProto.name = 1.


def varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        s += 7
        if c < 0x80:
            return r, i


def fields(b):
    i, out = 0, []
    while i < len(b):
        k, i = varint(b, i)
        f, w = k >> 3, k & 7
        if w == 0:
            v, i = varint(b, i)
        elif w == 2:
            n, i = varint(b, i)
            v = bytes(b[i : i + n])
            i += n
        elif w == 1:
            v = bytes(b[i : i + 8])
            i += 8
        elif w == 5:
            v = bytes(b[i : i + 4])
            i += 4
        else:
            raise SystemExit(f"type filaire {w} non pris en charge")
        out.append((f, w, v))
    return out


def enc_varint(n):
    out = bytearray()
    while True:
        c = n & 0x7F
        n >>= 7
        if n:
            out.append(c | 0x80)
        else:
            out.append(c)
            return bytes(out)


def enc(fs):
    out = bytearray()
    for f, w, v in fs:
        out += enc_varint((f << 3) | w)
        if w == 0:
            out += enc_varint(v)
        elif w == 2:
            out += enc_varint(len(v)) + v
        else:
            out += v
    return bytes(out)


def strs(fs, f):
    return [v.decode() for ff, _, v in fs if ff == f]


def names_in(graph_fields):
    """Toutes les sorties de nœuds d'un graphe (pour détecter les collisions)."""
    return {o for f, _, v in graph_fields if f == 1 for o in strs(fields(v), 2)}


def main(src, dst):
    model = fields(open(src, "rb").read())
    gi = [i for i, (f, _, _) in enumerate(model) if f == 7]
    if len(gi) != 1:
        raise SystemExit("ModelProto sans graphe unique")
    graph = fields(model[gi[0]][2])
    ifs = [i for i, (f, _, v) in enumerate(graph) if f == 1 and strs(fields(v), 4) == ["If"]]
    if len(ifs) != 1:
        raise SystemExit(f"{len(ifs)} nœud(s) If : attendu exactement 1")
    node = fields(graph[ifs[0]][2])
    cond, (out,) = strs(node, 1), strs(node, 2)
    if len(cond) != 1:
        raise SystemExit("If sans condition unique")
    branches = {}
    for f, _, v in node:
        if f == 5:
            a = fields(v)
            (name,) = strs(a, 1)
            branches[name] = fields([vv for ff, _, vv in a if ff == 6][0])
    then_b, else_b = branches.get("then_branch"), branches.get("else_branch")
    if then_b is None or else_b is None:
        raise SystemExit("If sans branches then/else")
    then_nodes = [(f, w, v) for f, w, v in then_b if f == 1]
    (then_out,) = [strs(fields(v), 1)[0] for f, _, v in then_b if f == 12]
    else_nodes = [fields(v) for f, _, v in else_b if f == 1]
    if len(else_nodes) != 1 or strs(else_nodes[0], 4) != ["Identity"]:
        raise SystemExit("branche else inattendue (attendu : une Identity)")
    (else_in,) = strs(else_nodes[0], 1)
    if [f for f, _, _ in then_b if f not in (1, 2, 11, 12, 13)]:
        raise SystemExit("branche then avec initialiseurs propres : non pris en charge")
    clash = names_in(graph) & names_in(then_b)
    if clash:
        raise SystemExit(f"collision de noms : {sorted(clash)}")
    where = enc([(1, 2, cond[0].encode()), (1, 2, then_out.encode()), (1, 2, else_in.encode()),
                 (2, 2, out.encode()), (3, 2, b"Where_verifier"), (4, 2, b"Where")])
    graph = graph[: ifs[0]] + then_nodes + [(1, 2, where)] + graph[ifs[0] + 1 :]
    model[gi[0]] = (7, 2, enc(graph))
    open(dst, "wb").write(enc(model))
    print(f"If({cond[0]}) -> Where({cond[0]}, {then_out}, {else_in}) = {out} ; {len(then_nodes)} nœuds remontés")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
