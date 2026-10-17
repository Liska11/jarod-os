// Le code d'appairage « jarod1.<port>.<64 caractères hexadécimaux> » est rangé dans storage.local et n'en sort jamais.
const state = document.getElementById("state");
const code = document.getElementById("code");
const FORMAT = /^jarod1\.(\d{2,5})\.([0-9a-f]{64})$/;

async function refresh() {
  const { pairing } = await browser.storage.local.get("pairing");
  state.textContent = pairing ? "Appairé (la valeur n'est pas affichée)." : "Non appairé.";
}

document.getElementById("save").addEventListener("click", async () => {
  const m = FORMAT.exec(code.value.trim());
  if (!m) {
    state.textContent = "Code invalide.";
    return;
  }
  await browser.storage.local.set({ pairing: { port: Number(m[1]), key: m[2] } });
  code.value = "";
  await refresh();
});

document.getElementById("forget").addEventListener("click", async () => {
  await browser.storage.local.remove("pairing");
  await refresh();
});

refresh();
