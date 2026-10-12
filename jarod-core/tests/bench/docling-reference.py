#!/usr/bin/env python3
"""
Référence AUTOMATIQUE de la gate B (DECISIONS 2026-09-30 ; v2 : cellules fusionnées et dates XLSX), indépendante de Docling :
  - PDF  : texte de la couche texte par pdfium (pypdfium2 ; moteur distinct de docling-parse) + nombre de pages ;
  - DOCX/PPTX/XLSX : texte brut lu dans le XML de l'archive (zipfile + lxml ; PAS python-docx/pptx/openpyxl,
    que Docling utilise lui-même).
Entrée : un fichier JSON [{"id","path","format"}, ...] ; sortie : <out>/<id>.txt (texte de référence) et
<out>/<id>.json (structure : pages, tables, headings, cells). Le texte vit dans .work/ (ignoré par git, local).
Lecture seule sur les documents ; aucun réseau.
"""
import json
import re
import sys
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

from lxml import etree

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
HEADING = re.compile(r"^(heading|titre)\s*\d", re.I)
BUILTIN_DATE = set(range(14, 23)) | {45, 46, 47}
# Éléments d'un format de nombre qui ne sont pas des codes de date : texte entre guillemets, [couleur/locale], \x, _x, *x.
NON_CODE = re.compile(r'"[^"]*"|\[[^\]]*\]|\\.|_.|\*.')


def xml(z: zipfile.ZipFile, name: str):
    return etree.fromstring(z.read(name), etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True))


def docx(path: Path):
    with zipfile.ZipFile(path) as z:
        root = xml(z, "word/document.xml")
        paras = []
        headings = 0
        for p in root.iter(W + "p"):
            style = p.find(f"{W}pPr/{W}pStyle")
            if style is not None and HEADING.match(style.get(W + "val", "")):
                headings += 1
            paras.append("".join(t.text or "" for t in p.iter(W + "t")))
        tables = sum(1 for _ in root.iter(W + "tbl"))
    return "\n".join(paras), {"tables": tables, "headings": headings}


def pptx(path: Path):
    with zipfile.ZipFile(path) as z:
        slides = sorted((n for n in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)), key=lambda n: int(re.findall(r"\d+", n)[0]))
        out = []
        for n in slides:
            out.append(" ".join(t.text or "" for t in xml(z, n).iter(A + "t")))
    return "\n".join(out), {"slides": len(slides)}


def is_date_code(code: str) -> bool:
    """Un format personnalisé est une date/heure s'il contient y, m, d, h ou s HORS guillemets, crochets et échappements."""
    code = NON_CODE.sub("", code)
    return code.lower() != "general" and re.search(r"[ymdhs]", code, re.I) is not None


def date_styles(z: zipfile.ZipFile) -> set:
    """Indices des styles de cellule (cellXfs) dont le format de nombre est une date/heure."""
    if "xl/styles.xml" not in z.namelist():
        return set()
    root = xml(z, "xl/styles.xml")
    custom = {int(n.get("numFmtId")): n.get("formatCode", "") for n in root.iter(S + "numFmt")}
    xfs = root.find(S + "cellXfs")
    out = set()
    for k, xf in enumerate(xfs if xfs is not None else []):
        fid = int(xf.get("numFmtId", "0"))
        if fid in BUILTIN_DATE or (fid in custom and is_date_code(custom[fid])):
            out.add(k)
    return out


def coord(ref: str):
    m = re.fullmatch(r"([A-Z]+)(\d+)", ref)
    col = 0
    for ch in m.group(1):
        col = col * 26 + ord(ch) - 64
    return col, int(m.group(2))


def xlsx(path: Path):
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in xml(z, "xl/sharedStrings.xml").iter(S + "si"):
                shared.append("".join(t.text or "" for t in si.iter(S + "t")))
        dates = date_styles(z)
        parts = []
        cells = 0
        for n in sorted(n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)):
            root = xml(z, n)
            values = {}
            for c in root.iter(S + "c"):
                v = c.find(S + "v")
                inline = c.find(f"{S}is")
                text = None
                if inline is not None:
                    text = "".join(t.text or "" for t in inline.iter(S + "t"))
                elif v is not None and v.text is not None:
                    t = c.get("t")
                    if t == "s" and v.text.isdigit() and int(v.text) < len(shared):
                        text = shared[int(v.text)]
                    elif t in (None, "n") and int(c.get("s", "0")) in dates:  # t="n" : écrit explicitement par openpyxl
                        # Date/heure : rendue comme Docling (AAAA-MM-JJ HH:MM:SS), lue dans le XML brut.
                        d = datetime(1899, 12, 30) + timedelta(days=float(v.text))
                        text = (d + timedelta(microseconds=500000)).strftime("%Y-%m-%d %H:%M:%S")
                    else:
                        text = v.text
                if text is None:
                    continue
                cells += 1
                parts.append(text)
                if c.get("r"):
                    values[coord(c.get("r"))] = text
            # Cellules fusionnées : le rendu en tableau répète la valeur sur toute la plage (le XML ne la porte qu'une fois).
            for mc in root.iter(S + "mergeCell"):
                a, b = mc.get("ref").split(":")
                (c1, r1), (c2, r2) = coord(a), coord(b)
                tl = values.get((c1, r1))
                if tl:
                    parts.extend([tl] * ((c2 - c1 + 1) * (r2 - r1 + 1) - 1))
    return "\n".join(parts), {"cells": cells}


def pdf(path: Path):
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(path))
    try:
        pages = len(doc)
        text = []
        for i in range(pages):
            tp = doc[i].get_textpage()
            text.append(tp.get_text_range())
            tp.close()
    finally:
        doc.close()
    return "\n".join(text), {"pages": pages}


FORMATS = {"docx": docx, "pptx": pptx, "xlsx": xlsx, "pdf": pdf}


def main():
    jobs = json.loads(Path(sys.argv[1]).read_text(encoding="utf8"))
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    for j in jobs:
        try:
            text, meta = FORMATS[j["format"]](Path(j["path"]))
            (out / f"{j['id']}.txt").write_text(text, encoding="utf8")
            (out / f"{j['id']}.json").write_text(json.dumps({"ok": True, **meta}), encoding="utf8")
        except Exception as e:  # noqa: BLE001 — la référence d'un fichier ne doit pas arrêter les autres
            (out / f"{j['id']}.json").write_text(json.dumps({"ok": False, "error": type(e).__name__}), encoding="utf8")
        print(j["id"], flush=True)


if __name__ == "__main__":
    main()
