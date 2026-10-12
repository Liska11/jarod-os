// Portage de packages/core/test/hardware.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import { classifyAccelerator } from "../src/local.js";

describe("classification du matériel", () => {
  it("reconnaît la carte dédiée et son backend", () => {
    expect(classifyAccelerator("NVIDIA RTX 4000 Ada Generation")).toMatchObject({
      kind: "dgpu",
      backend: "cuda",
      sharedMemory: false,
    });
    expect(classifyAccelerator("Intel(R) Arc(TM) A770 Graphics")).toMatchObject({ kind: "dgpu", backend: "vulkan" });
  });

  it("distingue l'Arc intégré de l'Arc dédié, et dit que sa mémoire est partagée", () => {
    // La distinction qui compte : « Arc(TM) Graphics » sans lettre de modèle est l'iGPU du portable.
    expect(classifyAccelerator("Intel(R) Arc(TM) Graphics")).toMatchObject({
      kind: "igpu",
      backend: "sycl",
      sharedMemory: true,
    });
    expect(classifyAccelerator("AMD Radeon(TM) Graphics")).toMatchObject({ kind: "igpu", backend: "vulkan" });
    // Le nom exact que cette machine annonce, relevé par sonde : sans cette règle il tombait en « cpu ».
    expect(classifyAccelerator("Intel(R) Graphics")).toMatchObject({ kind: "igpu", backend: "sycl" });
  });

  it("reconnaît un NPU, et le déclare à mémoire partagée", () => {
    expect(classifyAccelerator("Intel(R) AI Boost")).toMatchObject({ kind: "npu", backend: "openvino" });
    expect(classifyAccelerator("AMD Ryzen AI NPU")).toMatchObject({ kind: "npu", backend: "qnn" });
  });

  it("ne range pas de force ce qu'il ne sait pas nommer", () => {
    expect(classifyAccelerator("Contrôleur d'affichage de base")).toMatchObject({ kind: "cpu", backend: "cpu" });
  });
});
