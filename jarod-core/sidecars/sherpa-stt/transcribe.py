"""Sidecar sherpa-onnx : reconnaissance vocale locale (transducteur en flux). Hors ligne, aucun accès réseau.

Usage : transcribe.py <dossier_modèle> <pcm_float32.raw> [fréquence]. Sortie : {"text": "..."} (JSON, une ligne).
"""
import json
import sys
from pathlib import Path

import numpy as np
import sherpa_onnx

model = Path(sys.argv[1])
pcm = np.fromfile(sys.argv[2], dtype=np.float32)
rate = int(sys.argv[3]) if len(sys.argv) > 3 else 16000
rec = sherpa_onnx.OnlineRecognizer.from_transducer(
    tokens=str(model / "tokens.txt"),
    encoder=str(model / "encoder-epoch-99-avg-1.int8.onnx"),
    decoder=str(model / "decoder-epoch-99-avg-1.int8.onnx"),
    joiner=str(model / "joiner-epoch-99-avg-1.int8.onnx"),
    num_threads=1,
    sample_rate=16000,
    feature_dim=80,
    decoding_method="greedy_search",
)
stream = rec.create_stream()
stream.accept_waveform(rate, pcm)
stream.accept_waveform(rate, np.zeros(int(0.6 * rate), dtype=np.float32))
stream.input_finished()
while rec.is_ready(stream):
    rec.decode_stream(stream)
text = rec.get_result(stream)
text = text if isinstance(text, str) else text.text
print(json.dumps({"text": text.strip()}))
