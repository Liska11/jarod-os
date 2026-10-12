/**
 * Fixtures Q16 (DECISIONS 2026-09-29 « Q16 — … critère figé AVANT les chiffres ») : 60 requêtes maison en
 * français, 5 intents × 12, chacune avec sa traduction anglaise, étiquetées AVANT tout run. `effect` = la
 * demande change quelque chose (fichiers, applications, planification) au lieu de seulement répondre :
 * vrai pour `action` et `reminder` (24/60), faux sinon (classe majoritaire 36/60).
 *
 * Les questions sont en anglais (checkpoint anglais `receptron/laya-onnx`) ; les descriptions d'options
 * servent aussi à l'alternative simple (bge-m3 zéro-exemple) — mêmes textes pour les deux moteurs.
 */
import type { DecisionQuestion } from "@jarod/contracts";

export const INTENTS = ["chat", "docs", "action", "reminder", "web"] as const;
export type Intent = (typeof INTENTS)[number];

/** Registre fermé : description de chaque option (Laya `criteria`, requête bge-m3). */
export const INTENT_DESCRIPTIONS: Record<Intent, string> = {
  chat: "small talk, opinion, general knowledge or writing help that needs no tool",
  docs: "a question about the user's own files, notes or documents",
  action: "run a command, open, move, delete or edit files or apps on the computer",
  reminder: "create a reminder, alarm, timer or scheduled task",
  web: "needs fresh information from the internet: news, weather, prices, live results",
};

export const QUESTIONS: readonly DecisionQuestion[] = [
  { id: "intent", type: "choice", options: [...INTENTS], instructions: "Classify the user's request to route it to the right handler." },
  {
    id: "effect",
    type: "noul",
    instructions: "Does fulfilling this request change something (files, apps, schedules, devices) rather than only answer?",
  },
];

export interface Fixture {
  intent: Intent;
  fr: string;
  en: string;
}

const f = (intent: Intent, pairs: [string, string][]): Fixture[] => pairs.map(([fr, en]) => ({ intent, fr, en }));

export const FIXTURES: readonly Fixture[] = [
  ...f("chat", [
    ["Salut, comment tu vas ce matin ?", "Hi, how are you this morning?"],
    ["Raconte-moi une blague sur les chats.", "Tell me a joke about cats."],
    ["Quelle est la différence entre un virus et une bactérie ?", "What is the difference between a virus and a bacterium?"],
    [
      "Aide-moi à reformuler cette phrase pour qu'elle soit plus polie : envoie-moi le fichier.",
      "Help me rephrase this sentence to sound more polite: send me the file.",
    ],
    ["Tu penses quoi du télétravail ?", "What do you think about remote work?"],
    ["Explique-moi simplement ce qu'est une fonction récursive.", "Explain simply what a recursive function is."],
    ["Traduis « bonne nuit » en japonais.", "Translate 'good night' into Japanese."],
    ["Donne-moi trois idées de prénoms pour un chien.", "Give me three name ideas for a dog."],
    ["Merci pour ton aide, c'était parfait.", "Thanks for your help, that was perfect."],
    ["Écris un petit poème sur l'automne.", "Write a short poem about autumn."],
    ["Combien font 15 % de 240 ?", "What is 15% of 240?"],
    ["Qui a peint la Joconde ?", "Who painted the Mona Lisa?"],
  ]),
  ...f("docs", [
    ["Qu'est-ce que dit mon contrat de bail sur le préavis ?", "What does my lease say about the notice period?"],
    ["Retrouve dans mes notes ce que j'avais écrit sur le projet Cordis.", "Find what I wrote in my notes about the Cordis project."],
    [
      "Dans le compte rendu de la réunion de mardi, qui devait envoyer le devis ?",
      "In the minutes of Tuesday's meeting, who was supposed to send the quote?",
    ],
    ["Résume le PDF de mon assurance habitation.", "Summarize my home insurance PDF."],
    ["Quel est le montant total de ma dernière facture d'électricité ?", "What is the total amount of my last electricity bill?"],
    ["D'après ma documentation, comment on lance la gate P4 ?", "According to my documentation, how do I run the P4 gate?"],
    ["Est-ce que mon mémoire parle de la quantification des vecteurs ?", "Does my thesis mention vector quantization?"],
    ["Cherche dans mes documents la recette de gâteau de ma grand-mère.", "Search my documents for my grandmother's cake recipe."],
    ["Quelles sont les dates de congés indiquées dans mon contrat de travail ?", "What leave dates are listed in my employment contract?"],
    [
      "Dans mes fichiers, où est-ce que j'ai noté le numéro de série de l'imprimante ?",
      "Where in my files did I write down the printer's serial number?",
    ],
    ["Que disent mes notes de cours sur la Révolution française ?", "What do my lecture notes say about the French Revolution?"],
    ["Liste les décisions prises sur la voix dans mon fichier DECISIONS.", "List the decisions about voice in my DECISIONS file."],
  ]),
  ...f("action", [
    ["Ouvre le dossier Téléchargements.", "Open the Downloads folder."],
    ["Supprime les fichiers temporaires du bureau.", "Delete the temporary files on the desktop."],
    ["Lance Spotify et mets ma playlist du matin.", "Launch Spotify and play my morning playlist."],
    ["Renomme toutes les photos de vacances avec la date.", "Rename all the vacation photos with the date."],
    ["Déplace le rapport final dans le dossier Archives.", "Move the final report into the Archives folder."],
    ["Mets le volume à 30 %.", "Set the volume to 30%."],
    ["Crée un nouveau fichier notes.txt sur le bureau.", "Create a new notes.txt file on the desktop."],
    ["Compresse le dossier projet en zip.", "Compress the project folder into a zip."],
    ["Ferme toutes les fenêtres de Chrome.", "Close all the Chrome windows."],
    ["Exécute les tests du dépôt jarod-cordis.", "Run the tests of the jarod-cordis repository."],
    ["Copie la présentation sur la clé USB.", "Copy the presentation to the USB drive."],
    ["Allume la lumière du salon.", "Turn on the living room light."],
  ]),
  ...f("reminder", [
    ["Rappelle-moi d'appeler Marie demain à 9h.", "Remind me to call Marie tomorrow at 9am."],
    ["Mets un minuteur de vingt minutes pour les pâtes.", "Set a twenty-minute timer for the pasta."],
    ["Réveille-moi à 6h30 demain matin.", "Wake me up at 6:30 tomorrow morning."],
    ["Programme une sauvegarde tous les dimanches soir.", "Schedule a backup every Sunday evening."],
    ["N'oublie pas de me rappeler l'anniversaire de Paul le 12 octobre.", "Don't forget to remind me of Paul's birthday on October 12."],
    ["Rappelle-moi de prendre mes médicaments à 20h.", "Remind me to take my medication at 8pm."],
    ["Préviens-moi dans une heure pour sortir le linge.", "Let me know in an hour to take out the laundry."],
    ["Ajoute un rappel pour payer le loyer le 1er de chaque mois.", "Add a reminder to pay the rent on the 1st of every month."],
    ["Planifie le rapport hebdomadaire chaque lundi à 8h.", "Schedule the weekly report every Monday at 8am."],
    ["Rappelle-moi de rappeler le plombier cet après-midi.", "Remind me to call the plumber back this afternoon."],
    ["Mets une alarme à 14h pour la réunion.", "Set an alarm at 2pm for the meeting."],
    ["Dans trois jours, rappelle-moi de renouveler mon abonnement.", "In three days, remind me to renew my subscription."],
  ]),
  ...f("web", [
    ["Quel temps fera-t-il à Lyon demain ?", "What will the weather be in Lyon tomorrow?"],
    ["Quelles sont les actualités du jour ?", "What are today's news?"],
    ["Quel est le cours de l'euro en dollars aujourd'hui ?", "What is the euro to dollar exchange rate today?"],
    ["Qui a gagné le match du PSG hier soir ?", "Who won the PSG match last night?"],
    ["Quels sont les horaires du prochain train pour Paris ?", "What are the times of the next train to Paris?"],
    ["Trouve-moi les avis récents sur l'Asus Zenbook 14.", "Find me recent reviews of the Asus Zenbook 14."],
    ["Est-ce que la pharmacie du centre est ouverte maintenant ?", "Is the downtown pharmacy open right now?"],
    ["Quelle est la dernière version de Node.js sortie ?", "What is the latest released version of Node.js?"],
    ["Y a-t-il des bouchons sur l'A7 en ce moment ?", "Is there traffic on the A7 right now?"],
    ["Cherche sur internet un tutoriel pour réparer une fuite de robinet.", "Search the internet for a tutorial on fixing a leaking tap."],
    ["Quels films passent au cinéma ce soir ?", "What movies are showing at the cinema tonight?"],
    ["Quel est le prix actuel de l'essence ?", "What is the current price of gasoline?"],
  ]),
];

export const effectOf = (intent: Intent) => intent === "action" || intent === "reminder";

/**
 * États longs (> `max_len`) : un passage réel du dépôt (~3 000 caractères) avec la demande AVANT puis
 * APRÈS. Laya tronque l'état par la fin : la demande placée après est perdue (relevé sans seuil).
 */
export function longStates(passage: string): { before: string; after: string; intent: Intent } {
  const ask = "Rappelle-moi de relire ce texte demain à 10h.";
  return { before: `${ask}\n\n${passage}`, after: `${passage}\n\n${ask}`, intent: "reminder" };
}
