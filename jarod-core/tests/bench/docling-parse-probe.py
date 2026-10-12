"""
Sonde de diagnostic (DECISIONS 2026-09-30, gate B) : pour des pages d'un PDF, rappel des MOTS de docling-parse (couche d'extraction
commune à TOUS les profils Docling, avant tout pipeline) face à pdfium, séparément pour le texte situé DANS la page et HORS page.
Usage : python docling-parse-probe.py <pdf> <pages séparées par des virgules>. Lecture seule, hors ligne.
"""
import sys, re, unicodedata
from collections import Counter
import pypdfium2 as pdfium
from docling_parse.pdf_parser import DoclingPdfParser
from docling_core.types.doc.page import TextCellUnit

def toks(s):
    s = unicodedata.normalize("NFD", unicodedata.normalize("NFKC", s).lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.findall(r"[^\W_]+", s)

path = sys.argv[1]
pdf = pdfium.PdfDocument(path)
dp = DoclingPdfParser(loglevel="fatal").load(path_or_stream=path)
for pno in [int(x) for x in sys.argv[2].split(",")]:
    pg = pdf[pno - 1]
    W, H = pg.get_size()
    tp = pg.get_textpage()
    inside, outside = [], []
    for i in range(tp.count_rects()):
        l, b, r, t = tp.get_rect(i)
        txt = tp.get_text_bounded(l, b, r, t)
        cx, cy = (l + r) / 2, (b + t) / 2
        (inside if 0 <= cx <= W and 0 <= cy <= H else outside).append(txt)
    got = Counter(toks(" ".join(c.text for c in dp.get_page(pno).iterate_cells(TextCellUnit.WORD))))
    def rec(parts):
        ref = Counter(toks(" ".join(parts))); tot = sum(ref.values())
        return (tot, round(sum(min(n, got.get(t, 0)) for t, n in ref.items()) / tot, 3) if tot else None)
    print("page", pno, "dans la page: (jetons, rappel docling-parse) =", rec(inside), "| hors page:", rec(outside))
