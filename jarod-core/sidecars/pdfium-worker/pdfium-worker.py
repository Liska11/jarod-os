#!/usr/bin/env python3
"""
Worker PDF de Jarod-cordis (PLAN §10 phase 2, lot B, décision « option b » du 2026-09-30) : lit la COUCHE TEXTE d'un PDF
avec pdfium (pypdfium2), sans Docling. Même protocole que le worker Docling (une ligne JSON par message, stdio) :
  -> {"op":"hello"}                            <- {"ok":true,"name":"pdfium","version","protocol":1,"pid"}
  -> {"op":"parse","id":n,"path","name","mime"} <- {"id":n,"ok":true,"manifest":{...},"text":"..."}
                                                   ou {"id":n,"ok":false,"code":"..."}
  -> {"op":"quit"}
Choix (DECISIONS 2026-09-30) : Docling perd du texte visible dans `docling-parse` sur des PDF réels ; pdfium n'en perd pas.
  - Le texte est celui de la zone de la page (boîte de recadrage) : le texte placé HORS de la page visible, que pdfium
    extrait aussi, est écarté (il est invisible pour un lecteur et gonflait ma référence de 1 à 12 %).
  - Ni sections, ni tableaux, ni images dans le manifeste (pdfium n'en fournit pas) ; pages = nombre de pages.
  - Pas d'OCR : une page sans texte est signalée par {"code":"PAGE_WITHOUT_TEXT","page":n}, jamais remplie.
stderr est JETÉ (il peut contenir du texte de document) ; seule la ligne de réponse compte. Aucun réseau.
"""
import hashlib
import json
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(line_buffering=True)
sys.stderr = open(os.devnull, "w")

try:
    import pypdfium2 as pdfium

    PDFIUM_AVAILABLE = True
except ImportError:
    PDFIUM_AVAILABLE = False

VERSION = "1.0.0"
PROTOCOL = 1
PARSER_NAME = "pdfium"
MAX_PAGE_ERRORS = 200


def extract(path: Path):
    """(texte, pages, erreurs) ; lève une exception pour un document illisible ou protégé."""
    doc = pdfium.PdfDocument(str(path))
    try:
        pages = len(doc)
        parts, errors = [], []
        for i in range(pages):
            page = doc[i]
            try:
                box = page.get_cropbox()  # (gauche, bas, droite, haut) dans l'espace de la page
                tp = page.get_textpage()
                try:
                    text = tp.get_text_bounded(*box)
                finally:
                    tp.close()
            finally:
                page.close()
            text = "\n".join(line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")).strip()
            if not text and len(errors) < MAX_PAGE_ERRORS:
                errors.append({"code": "PAGE_WITHOUT_TEXT", "page": i + 1})
            parts.append(text)
        return "\n\n".join(parts), pages, errors
    finally:
        doc.close()


def convert(path: Path):
    if not PDFIUM_AVAILABLE:
        return "", {}, "PDFIUM_UNAVAILABLE"
    try:
        data = path.read_bytes()
        text, pages, errors = extract(path)
        manifest = {
            "manifestVersion": 1,
            "parser": {"name": PARSER_NAME, "version": VERSION},
            "source": {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "mime": "application/pdf"},
            "language": None,
            "pages": pages,
            "sections": [],
            "tables": [],
            "images": [],
            "errors": errors,
        }
        return text, manifest, None
    except Exception as e:  # noqa: BLE001 — fichier illisible, protégé, tronqué : erreur du DOCUMENT, le worker continue
        return "", {}, f"PDF_UNREADABLE:{type(e).__name__}"


def main():
    hello = {"ok": True, "name": PARSER_NAME, "version": VERSION, "protocol": PROTOCOL, "pid": os.getpid()}
    # Le message d'accueil n'est envoyé QU'en réponse à {"op":"hello"} (une ligne de réponse par commande).
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "code": "INVALID_JSON"}), flush=True)
            continue
        op = msg.get("op")
        if op == "quit":
            break
        elif op == "hello":
            print(json.dumps(hello), flush=True)
        elif op == "parse":
            msg_id = msg.get("id")
            path = Path(msg.get("path", ""))
            if not path.exists():
                print(json.dumps({"id": msg_id, "ok": False, "code": "FILE_NOT_FOUND"}), flush=True)
                continue
            text, manifest, error = convert(path)
            if error:
                print(json.dumps({"id": msg_id, "ok": False, "code": error}), flush=True)
            else:
                print(json.dumps({"id": msg_id, "ok": True, "manifest": manifest, "text": text}), flush=True)
        else:
            print(json.dumps({"ok": False, "code": f"UNKNOWN_OP:{op}"}), flush=True)


if __name__ == "__main__":
    main()
