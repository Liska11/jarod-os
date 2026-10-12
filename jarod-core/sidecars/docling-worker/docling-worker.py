#!/usr/bin/env python3
"""
Docling worker for Jarod-cordis (PLAN §10 phase 2, lot B ⑥).
Implements the JSON-line protocol over stdio:
  -> {"op":"hello"}                            <- {"ok":true,"name","version","protocol":1,"pid"}
  -> {"op":"parse","id":n,"path","name","mime"} <- {"id":n,"ok":true,"manifest":{...},"text":"..."}
                                                   or {"id":n,"ok":false,"code":"..."}
  -> {"op":"quit"}
stderr is DISCARDED (may contain document text); only the response line counts.
"""

import sys
import json
import os
import hashlib
from pathlib import Path
from typing import Any, Dict, Optional

# Ensure stdout is line-buffered and stderr is silenced
sys.stdout.reconfigure(line_buffering=True)
sys.stderr = open(os.devnull, 'w')

try:
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.pipeline.native_pdf_pipeline import NativePdfPipeline
    from docling.datamodel.pipeline_options import NativePdfPipelineOptions
    DOCLING_AVAILABLE = True
except ImportError as e:
    DOCLING_AVAILABLE = False
    IMPORT_ERROR = str(e)

VERSION = "1.0.0"
PROTOCOL = 1
PARSER_NAME = "docling"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).digest().hex()


MIME = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".html": "text/html",
}


def locate(text: str, needle: str, cursor: int):
    """Position RÉELLE de `needle` dans le texte exporté, à partir de `cursor` ; None si introuvable (jamais inventée)."""
    if not needle:
        return None
    at = text.find(needle, cursor)
    return None if at < 0 else (at, at + len(needle))


def item_page(item):
    prov = getattr(item, "prov", None)
    return int(prov[0].page_no) if prov else None


def make_manifest(source_bytes: bytes, text: str, docling_doc=None, errors=None, suffix: str = "") -> Dict[str, Any]:
    """Manifeste compatible avec @jarod/contracts ; chaque empan désigne une plage réelle de `text`."""
    sections = []
    tables = []
    images = []
    errors = list(errors or [])
    pages = None

    if docling_doc is not None:
        cursor = 0  # les éléments sont parcourus dans l'ordre de l'export : la recherche ne recule jamais
        missed = set()
        for item, _depth in docling_doc.iterate_items():
            kind = type(item).__name__
            if kind == "SectionHeaderItem":
                found = locate(text, item.text, cursor)
                if found is None:
                    missed.add("SPAN_SECTION_NOT_LOCATED")
                    continue
                sections.append({"start": found[0], "end": found[1], "page": item_page(item), "level": max(1, int(getattr(item, "level", 1))), "title": item.text})
                cursor = found[1]
            elif kind == "TableItem":
                md = item.export_to_markdown(doc=docling_doc)
                found = locate(text, md, cursor)
                if found is None:  # rendu légèrement différent : on garde la PREMIÈRE ligne (plage réelle mais partielle), dite dans les erreurs
                    found = locate(text, md.split(chr(10), 1)[0], cursor)
                    if found is not None:
                        missed.add("SPAN_TABLE_PARTIAL")
                if found is None:
                    missed.add("SPAN_TABLE_NOT_LOCATED")
                    continue
                tables.append({"start": found[0], "end": found[1], "page": item_page(item)})
                cursor = found[1]
            elif kind == "PictureItem":
                found = locate(text, "<!-- image -->", cursor)
                if found is None:
                    missed.add("SPAN_IMAGE_NOT_LOCATED")
                    continue
                images.append({"start": found[0], "end": found[1], "page": item_page(item)})
                cursor = found[1]
        errors.extend({"code": code, "page": None} for code in sorted(missed))
        if hasattr(docling_doc, "pages"):
            pages = len(docling_doc.pages)

    return {
        "manifestVersion": 1,
        "parser": {"name": PARSER_NAME, "version": VERSION},
        "source": {"sha256": sha256_bytes(source_bytes), "bytes": len(source_bytes), "mime": MIME.get(suffix, "application/octet-stream")},
        "language": None,
        "pages": pages,
        "sections": sections,
        "tables": tables,
        "images": images,
        "errors": errors,
    }


def convert_document(file_path: Path) -> tuple[str, Dict[str, Any], Optional[str]]:
    """Convert document with Docling, return (text, manifest, error_code)."""
    if not DOCLING_AVAILABLE:
        return "", {}, f"IMPORT_ERROR:{IMPORT_ERROR}"
    
    try:
        # Read file bytes
        source_bytes = file_path.read_bytes()
        
        # Determine format and converter
        suffix = file_path.suffix.lower()
        
        if suffix == ".pdf":
            # Use NativePdfPipeline for PDF (model-free, text + pages only)
            converter = DocumentConverter(
                format_options={
                    InputFormat.PDF: PdfFormatOption(
                        pipeline_cls=NativePdfPipeline,
                        pipeline_options=NativePdfPipelineOptions()
                    )
                }
            )
        else:
            # Default converter for DOCX, PPTX, XLSX, HTML
            converter = DocumentConverter()
        
        result = converter.convert(str(file_path))
        
        if result.status.name != "SUCCESS":
            return "", {}, f"CONVERSION_FAILED:{result.status.name}"
        
        # Export to markdown
        text = result.document.export_to_markdown()
        
        # Build manifest
        manifest = make_manifest(source_bytes, text, result.document, suffix=suffix)
        
        return text, manifest, None
        
    except Exception as e:
        return "", {}, f"EXCEPTION:{type(e).__name__}:{str(e)[:200]}"


def main():
    # Le message de bienvenue n'est envoyé QUE en réponse à {"op":"hello"} : une ligne spontanée serait prise par
    # l'adaptateur pour la réponse de la commande suivante (protocole : une ligne de réponse par commande).
    hello = {
        "ok": True,
        "name": PARSER_NAME,
        "version": VERSION,
        "protocol": PROTOCOL,
        "pid": os.getpid()
    }

    # Process commands
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
            file_path = Path(msg.get("path", ""))
            name = msg.get("name", "")
            
            if not file_path.exists():
                response = {"id": msg_id, "ok": False, "code": "FILE_NOT_FOUND"}
                print(json.dumps(response), flush=True)
                continue
            
            text, manifest, error_code = convert_document(file_path)
            
            if error_code:
                response = {"id": msg_id, "ok": False, "code": error_code}
            else:
                response = {
                    "id": msg_id,
                    "ok": True,
                    "manifest": manifest,
                    "text": text
                }
            print(json.dumps(response), flush=True)
            
        else:
            # Unknown operation
            print(json.dumps({"ok": False, "code": f"UNKNOWN_OP:{op}"}), flush=True)


if __name__ == "__main__":
    main()