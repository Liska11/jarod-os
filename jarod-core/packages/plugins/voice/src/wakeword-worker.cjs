/**
 * Processus dédié du mot d'activation (Q9, option A) — Jarod-cordis. Lancé par `IsolatedWakeWordRuntime`
 * (`wakeword-isolated.ts`) : `utilityProcess.fork` sous Electron, `child_process.fork` ailleurs. Il porte
 * SEUL openvino-node pour le détecteur : un plantage natif (0xC0000005 observé dans `inferAsync` sur NPU,
 * DECISIONS 2026-09-27 « Incident ») tue ce processus, plus le main ; l'hôte le relance et rejoue l'appel.
 *
 * Mêmes appels OpenVINO que `openVinoRuntime()` (wakeword.ts) : `readModel` → `reshape` → `compileModel`
 * → une `InferRequest` par modèle compilé. Messages : `compile {seq, id, path, shape, device}`,
 * `infer {seq, id, input: Float32Array}` → `result {seq, ok, value | error}`. CommonJS sans compilation.
 */
"use strict";

const port = process.parentPort; // utilityProcess
const send = (m) => (port ? port.postMessage(m) : process.send(m));
const onMessage = (fn) => (port ? port.on("message", (e) => fn(e.data)) : process.on("message", fn));

let ov = null;
let core = null;
const models = new Map();

function load() {
  if (!core) {
    ov = require("openvino-node").addon;
    core = new ov.Core();
  }
}

async function compile(m) {
  load();
  const model = await core.readModel(m.path);
  model.reshape(`[${m.shape.join(",")}]`);
  const compiled = await core.compileModel(model, m.device);
  models.set(m.id, { request: compiled.createInferRequest(), shape: m.shape });
  return null;
}

async function infer(m) {
  const h = models.get(m.id);
  if (!h) throw new Error(`WAKEWORD_WORKER_UNKNOWN_MODEL: modèle ${m.id} non compilé dans ce processus`);
  const out = await h.request.inferAsync([new ov.Tensor(ov.element.f32, h.shape, m.input)]);
  return Float32Array.from(Object.values(out)[0].data);
}

onMessage(async (m) => {
  if (!m || typeof m !== "object") return;
  try {
    const value = m.t === "compile" ? await compile(m) : m.t === "infer" ? await infer(m) : undefined;
    if (value === undefined) throw new Error(`message inconnu : ${m.t}`);
    send({ t: "result", seq: m.seq, ok: true, value });
  } catch (e) {
    send({ t: "result", seq: m.seq, ok: false, error: String((e && e.message) || e) });
  }
});

send({ t: "ready", pid: process.pid });
