"""Sidecar Presidio : lit {"text", "language"} sur stdin, rend les entités trouvées (type, début, fin, score), jamais le texte."""
import json
import sys

from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider

req = json.loads(sys.stdin.read())
engine = NlpEngineProvider(nlp_configuration={"nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}]}).create_engine()
analyzer = AnalyzerEngine(nlp_engine=engine, supported_languages=["en"])
found = analyzer.analyze(text=req["text"][:200000], language="en")
print(json.dumps([{"entity": r.entity_type, "start": r.start, "end": r.end, "score": round(r.score, 2)} for r in found]))
