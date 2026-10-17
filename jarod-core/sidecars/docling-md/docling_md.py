"""Conversion Docling d'un fichier vers Markdown sur stdout (profil sans PyTorch : pipeline PDF natif, texte et pages)."""
import sys
from pathlib import Path

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import NativePdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.pipeline.native_pdf_pipeline import NativePdfPipeline

path = Path(sys.argv[1])
if path.suffix.lower() == ".pdf":
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_cls=NativePdfPipeline, pipeline_options=NativePdfPipelineOptions())})
else:
    converter = DocumentConverter()
result = converter.convert(str(path))
if result.status.name != "SUCCESS":
    sys.exit(f"CONVERSION_FAILED:{result.status.name}")
sys.stdout.reconfigure(encoding="utf-8")
sys.stdout.write(result.document.export_to_markdown())
