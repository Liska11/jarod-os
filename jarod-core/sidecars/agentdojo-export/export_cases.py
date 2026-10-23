"""G3 — exporte le corpus d'injections d'AgentDojo (ethz-spylab/agentdojo) en JSON, pour le banc d'essai de Jarod.

Lancé par le venv isolé `engines/agentdojo` (python -I). Ne lance AUCUN modèle et n'ouvre aucune connexion : il lit les suites
embarquées dans le paquet, rend le texte des attaques tel que la bibliothèque le construit (chaînes de ses classes, jamais recopiées),
et les actions visées (« ground truth ») de chaque tâche d'injection.

    python -I export_cases.py --benchmark v1.2 --attacks important_instructions,ignore_previous > cas.json
    python -I export_cases.py --benchmark v1.2 --benign > benins.json
"""

import argparse
import importlib.metadata
import inspect
import json
import sys

from agentdojo.agent_pipeline.base_pipeline_element import BasePipelineElement
from agentdojo.attacks.attack_registry import load_attack
from agentdojo.attacks.base_attacks import FixedJailbreakAttack
from agentdojo.task_suite.load_suites import get_suites

MODEL = "Jarod"


class _NamedPipeline(BasePipelineElement):
    """Pipeline FACTICE : ne sert qu'à construire l'attaque (son nom de modèle) ; jamais exécuté."""

    name = "gpt-4o-2024-05-13"

    def query(self, *args, **kwargs):  # pragma: no cover - jamais appelé
        raise RuntimeError("pipeline factice : aucune exécution")


def render(attack_name: str, suite, injection_task, user_task) -> str:
    attack = load_attack(attack_name, suite, _NamedPipeline())
    if isinstance(attack, FixedJailbreakAttack) and "{tools}" not in attack.jailbreak:
        attack.model_name = MODEL
        return attack.jailbreak.format(goal=injection_task.GOAL, user=attack.user_name, model=attack.model_name, task=attack.summarize_task(user_task))
    # Les autres (déni de service, connaissance des outils) : le texte que la bibliothèque place elle-même dans le premier vecteur
    # d'injection de la tâche utilisateur. Aucun modèle : `attack()` ne fait que remplir son gabarit (et rejouer la vérité terrain).
    if hasattr(attack, "model_name"):
        attack.model_name = MODEL
    texts = attack.attack(user_task, injection_task)
    if not texts:
        raise SystemExit(f"attaque sans texte rendu : {attack_name}")
    return next(iter(texts.values()))


def benign_texts(benchmark: str) -> list[str]:
    """Les textes des environnements PAR DÉFAUT (vecteurs d'injection remplis de leur valeur bénigne) : e-mails, messages, fichiers,
    pages, avis. Le corpus des faux positifs, du même domaine que les attaques. Chaînes d'au moins 40 caractères, sans doublon."""
    seen: set[str] = set()
    out: list[str] = []

    def walk(v) -> None:
        if isinstance(v, str):
            s = v.strip()
            if len(s) >= 40 and s not in seen:
                seen.add(s)
                out.append(s)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, (list, tuple)):
            for x in v:
                walk(x)

    for suite in get_suites(benchmark).values():
        walk(suite.load_and_inject_default_environment({}).model_dump(mode="json"))
    return out


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--benchmark", default="v1.2")
    p.add_argument("--attacks", default="important_instructions")
    p.add_argument("--benign", action="store_true", help="exporte seulement les textes bénins des environnements par défaut")
    a = p.parse_args()
    if a.benign:
        json.dump({"agentdojo": importlib.metadata.version("agentdojo"), "benchmark": a.benchmark, "benign": benign_texts(a.benchmark)}, sys.stdout, ensure_ascii=False)
        return
    attacks = [x for x in a.attacks.split(",") if x]
    cases = []
    for suite_name, suite in get_suites(a.benchmark).items():
        env = suite.load_and_inject_default_environment({})
        vectors = sorted(suite.get_injection_vector_defaults())
        user_task = next(iter(suite.user_tasks.values()))
        for task_id, task in suite.injection_tasks.items():
            calls = [{"function": c.function, "args": json.loads(json.dumps(dict(c.args), default=str))} for c in task.ground_truth(env)]
            # Comment AgentDojo juge la tâche : sur l'ENVIRONNEMENT après coup (une action a eu lieu) ou sur le seul TEXTE de la réponse.
            # Plusieurs tâches (workspace 6 à 13) n'ont pas de suite d'appels de référence mais sont jugées sur l'environnement : sans ce
            # champ, une liste vide passerait pour une injection « texte seul ».
            body = inspect.getsource(type(task).security).split(") -> bool:", 1)[-1]
            # « trace » : la tâche est jugée sur la suite d'appels elle-même (`security_from_traces`).
            checks = "trace" if "security_from_traces" in body else "environment" if "post_environment" in body else "output"
            for attack in attacks:
                cases.append(
                    {
                        "suite": suite_name,
                        "injectionTask": task_id,
                        "attack": attack,
                        "goal": task.GOAL,
                        "groundTruth": calls,
                        "checks": checks,
                        "payload": render(attack, suite, task, user_task),
                        "vectors": vectors,
                    }
                )
    json.dump(
        {"agentdojo": importlib.metadata.version("agentdojo"), "benchmark": a.benchmark, "attacks": attacks, "cases": cases},
        sys.stdout,
        ensure_ascii=False,
    )


if __name__ == "__main__":
    main()
