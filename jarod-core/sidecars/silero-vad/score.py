"""Sidecar silero-vad (modèle ONNX v5) : probabilités de parole par trame de 512 échantillons (16 kHz), sur du PCM float32 brut.

Usage : score.py <modèle.onnx> <pcm_float32.raw>. Sortie : une liste JSON de probabilités. Aucun accès réseau.
"""
import json
import sys

import numpy as np
import onnxruntime as ort

model_path, pcm_path = sys.argv[1], sys.argv[2]
pcm = np.fromfile(pcm_path, dtype=np.float32)
session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
state = np.zeros((2, 1, 128), dtype=np.float32)
context = np.zeros((1, 64), dtype=np.float32)
sr = np.array(16000, dtype=np.int64)
probs = []
for i in range(0, len(pcm) - 511, 512):
    x = np.concatenate([context, pcm[i : i + 512][None, :]], axis=1)
    out, state = session.run(None, {"input": x, "state": state, "sr": sr})
    context = x[:, -64:]
    probs.append(round(float(out[0][0]), 4))
print(json.dumps(probs))
