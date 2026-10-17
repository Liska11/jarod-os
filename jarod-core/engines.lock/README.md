# Moteurs externes réels (phase 5)

Les moteurs ne sont pas dans le dépôt : ils vivent dans `engines/` à la racine (ignoré par git) et sont recréés à partir des
fichiers de ce dossier. Les tests `*.engine.test.ts` les utilisent quand ils sont présents et le disent quand ils manquent
(`describe.skipIf`), jamais en silence : un moteur absent ne rend pas un test vert, il l'ignore avec un message.

| Moteur | Où | Reconstruire |
|---|---|---|
| Python 3.12 : markitdown, pymupdf, Presidio, spaCy `en_core_web_sm`, pywinauto, sherpa-onnx, onnxruntime | `engines/py` | `uv venv engines/py --python 3.12` puis `uv pip install -r jarod-core/engines.lock/py312-requirements.txt` (le modèle spaCy est une URL de la liste) |
| Docling 2.140 (profil sans PyTorch) | `engines/docling` | `uv venv engines/docling --python 3.12` puis `uv pip install -r jarod-core/engines.lock/docling-requirements.txt` |
| promptfoo 0.124.1 | `engines/promptfoo` | `npm ci` dans ce dossier, avec `node/promptfoo/package*.json` |
| @huggingface/transformers 4.3.1 | `engines/transformers` | idem avec `node/transformers/` |
| @microsoft/mxc-sdk 1.0.1 | `engines/mxc` | idem avec `node/mxc/` (Node 24+) |
| FlaUI 5.0.0 (sidecar .NET) | `engines/flaui` | `dotnet build -c Release -o ../../../engines/flaui` dans `jarod-core/sidecars/uia-flaui` |
| silero-vad v5.1.2 | `engines/models/silero/silero_vad.onnx` | https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx, sha256 `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f` |
| sherpa-onnx zipformer-en-20M | `engines/models/sherpa/` | archive `sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2` des releases `asr-models`, sha256 `9c559283e8498d3fe95913c79ca1cb454bb26281ac2b102b41306c7d752765d9` |
| all-MiniLM-L6-v2 (Xenova), révision 751bff3 | `engines/models/minilm/` | fichiers `config.json`, `tokenizer*.json`, `special_tokens_map.json`, `onnx/model_quantized.onnx` (sha256 `afdb6f1a…bdb1`) de cette révision |

sqlite-vec, oauth4webapi, better-sqlite3-multiple-ciphers, @modelcontextprotocol/sdk sont des dépendances exactes du dépôt
(`pnpm-lock.yaml`). Rien de personnel n'est utilisé : documents, fenêtres, voix et phrases des tests sont fabriqués.
