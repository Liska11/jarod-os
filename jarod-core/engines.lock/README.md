# Moteurs externes réels (phase 5)

Les moteurs ne sont pas dans le dépôt : ils vivent dans `engines/` à la racine (ignoré par git) et sont recréés à partir des
fichiers de ce dossier. Les tests `*.engine.test.ts` les utilisent quand ils sont présents et le disent quand ils manquent
(`describe.skipIf`), jamais en silence : un moteur absent ne rend pas un test vert, il l'ignore avec un message.

| Moteur | Où | Reconstruire |
|---|---|---|
| Python 3.12 : markitdown, pymupdf, Presidio, spaCy `en_core_web_sm`, pywinauto, sherpa-onnx, onnxruntime | `engines/py` | `uv venv engines/py --python 3.12` puis `uv pip install -r jarod-core/engines.lock/py312-requirements.txt` (le modèle spaCy est une URL de la liste) |
| Docling 2.140 (profil sans PyTorch) | `engines/docling` | `uv venv engines/docling --python 3.12` puis `uv pip install -r jarod-core/engines.lock/docling-requirements.txt` |
| Docling 2.140 COMPLET (PyTorch, modèles de mise en page et de tableaux, téléchargés au premier usage) | `engines/docling-full` | `uv venv engines/docling-full --python 3.12` puis `uv pip install -r jarod-core/engines.lock/docling-full-requirements.txt` ; utiliser `JAROD_DOCLING_PROFILE=full` |
| promptfoo 0.124.1 | `engines/promptfoo` | `npm ci` dans ce dossier, avec `node/promptfoo/package*.json` |
| @huggingface/transformers 4.3.1 | `engines/transformers` | idem avec `node/transformers/` |
| @microsoft/mxc-sdk 1.0.1 | `engines/mxc` | idem avec `node/mxc/` (Node 24+) |
| browser-harness 0.1.13 (E2, pilotage CDP d'un Chrome JETABLE) | `engines/browser-harness` | `uv venv engines/browser-harness --python 3.12` puis `uv pip install --require-hashes -r jarod-core/engines.lock/browser-harness-requirements.txt` (généré par `uv pip compile browser-harness.in --generate-hashes`) ; navigateur : le Chromium de Playwright (`%LOCALAPPDATA%\ms-playwright\chromium-1243`), lancé par Jarod sur un profil neuf |
| FlaUI 5.0.0 (sidecar .NET) | `engines/flaui` | `dotnet build -c Release -o ../../../engines/flaui` dans `jarod-core/sidecars/uia-flaui` |
| silero-vad v5.1.2 | `engines/models/silero/silero_vad.onnx` | https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx, sha256 `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f` |
| sherpa-onnx zipformer-en-20M | `engines/models/sherpa/` | archive `sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2` des releases `asr-models`, sha256 `9c559283e8498d3fe95913c79ca1cb454bb26281ac2b102b41306c7d752765d9` |
| all-MiniLM-L6-v2 (Xenova), révision 751bff3 | `engines/models/minilm/` | fichiers `config.json`, `tokenizer*.json`, `special_tokens_map.json`, `onnx/model_quantized.onnx` (sha256 `afdb6f1a…bdb1`) de cette révision |
| Firefox ESR 153.5.0 (E2/Firefox, build de TEST séparé du Firefox de l'utilisateur) | `engines/firefox-test/firefox/core/firefox.exe` | `https://download-installer.cdn.mozilla.net/pub/firefox/releases/153.5.0esr/win64/en-US/Firefox%20Setup%20153.5.0esr.exe`, sha256 `514838292732780a4af39a6bf3a302c12bafd79e99416fa7776c5ececcc8794e`, signature Authenticode « Mozilla Corporation » vérifiée ; extraction SANS installation : `Firefox Setup 153.5.0esr.exe /ExtractDir=<dossier>` |
| geckodriver 0.37.1 (pilote du Firefox de test) | `engines/firefox-test/geckodriver/geckodriver.exe` | `https://github.com/mozilla/geckodriver/releases/download/v0.37.1/geckodriver-v0.37.1-win64.zip`, sha256 `dfed9315abe8d2fbc1b6161a2ee8002452e79cf05ee92fdc653a4e26bc35edd8` ; lancé avec `--allow-system-access` pour simuler le geste sur le bouton de l'extension (build de test seulement) |

sqlite-vec, oauth4webapi, better-sqlite3-multiple-ciphers, @modelcontextprotocol/sdk sont des dépendances exactes du dépôt
(`pnpm-lock.yaml`). Rien de personnel n'est utilisé : documents, fenêtres, voix et phrases des tests sont fabriqués.
