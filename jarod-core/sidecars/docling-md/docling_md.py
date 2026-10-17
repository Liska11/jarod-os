"""Conversion Docling d'un fichier vers Markdown sur stdout (profil sans PyTorch : pipeline PDF natif, texte et pages)."""
import os
import sys
from pathlib import Path

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import NativePdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.pipeline.native_pdf_pipeline import NativePdfPipeline

path = Path(sys.argv[1])
# JAROD_DOCLING_PROFILE=full : profil complet (PyTorch, modèles de mise en page et de tableaux) ; sinon pipeline PDF natif, texte et pages.
if path.suffix.lower() == ".pdf" and os.environ.get("JAROD_DOCLING_PROFILE") != "full":
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_cls=NativePdfPipeline, pipeline_options=NativePdfPipelineOptions())})
else:
    converter = DocumentConverter()
result = converter.convert(str(path))
if result.status.name != "SUCCESS":
    sys.exit(f"CONVERSION_FAILED:{result.status.name}")
sys.stdout.reconfigure(encoding="utf-8")
sys.stdout.write(result.document.export_to_markdown())
