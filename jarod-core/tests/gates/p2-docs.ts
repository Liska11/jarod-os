/**
 * Les 24 documents-témoins de la gate P2 et leur requête : extraits tels quels de `gates/p2.test.ts`
 * pour être partagés avec le banc de référence écosystème (bench/eco-baseline.test.ts).
 */
export const DOCS: [id: string, text: string, query: string][] = [
  ["paris", "Paris est la capitale de la France, traversée par la Seine.", "Quelle est la capitale de la France ?"],
  ["photosynthese", "La photosynthèse permet aux plantes de transformer la lumière en énergie chimique.", "Comment les plantes produisent-elles leur énergie ?"],
  ["sqlite", "SQLite en mode WAL autorise des lectures concurrentes pendant une écriture.", "Lecture et écriture simultanées dans SQLite"],
  ["npu", "Le NPU Intel AI Boost exécute les réseaux de neurones quantifiés en INT8 à faible consommation.", "Quel accélérateur pour l'inférence INT8 basse consommation ?"],
  ["whisper", "Whisper transcrit la parole en texte ; large-v3-turbo offre un bon compromis qualité vitesse.", "Modèle de transcription vocale rapide"],
  ["cron", "Une expression cron à cinq champs décrit minute, heure, jour du mois, mois et jour de semaine.", "Format d'une planification cron"],
  ["velo", "Le Tour de France est une course cycliste par étapes disputée chaque été.", "Course de vélo estivale en France"],
  ["cafe", "Le café arabica pousse en altitude et donne une tasse plus douce que le robusta.", "Différence entre arabica et robusta"],
  ["volcan", "Le Piton de la Fournaise, sur l'île de La Réunion, est l'un des volcans les plus actifs.", "Volcan actif à La Réunion"],
  ["impots", "La déclaration de revenus se fait en ligne au printemps sur le site des impôts.", "Quand déclarer ses revenus ?"],
  ["recette", "Pour une pâte à crêpes : farine, œufs, lait, une pincée de sel et du beurre fondu.", "Ingrédients des crêpes"],
  ["chiffrement", "ChaCha20 est un chiffrement par flot rapide, adapté aux processeurs sans AES matériel.", "Chiffrement par flot rapide sans AES"],
  ["jardin", "Les tomates se plantent après les dernières gelées, au soleil, avec un tuteur.", "Quand planter les tomates ?"],
  ["astronomie", "Jupiter est la plus grande planète du système solaire, une géante gazeuse.", "Plus grosse planète du système solaire"],
  ["sante", "Boire suffisamment d'eau aide à réguler la température du corps.", "Pourquoi s'hydrater ?"],
  ["musique", "La sonate au clair de lune est une œuvre pour piano de Beethoven.", "Œuvre pour piano de Beethoven"],
  ["histoire", "La prise de la Bastille le 14 juillet 1789 marque le début de la Révolution française.", "Début de la Révolution française"],
  ["ocean", "Le Pacifique est le plus vaste océan de la planète.", "Plus grand océan du monde"],
  ["train", "Le TGV relie Paris à Lyon en environ deux heures.", "Temps de trajet Paris Lyon en train"],
  ["git", "git rebase réécrit l'historique en rejouant les commits sur une nouvelle base.", "Réécrire l'historique des commits"],
  ["docker", "Un conteneur Docker isole un processus avec son propre système de fichiers.", "Isoler une application avec son système de fichiers"],
  ["meteo", "Un anticyclone apporte généralement un temps sec et ensoleillé.", "Pourquoi fait-il beau avec un anticyclone ?"],
  ["chien", "Le berger australien est un chien de troupeau énergique et intelligent.", "Race de chien de troupeau"],
  ["rust", "Rust garantit la sûreté mémoire sans ramasse-miettes grâce au système de possession.", "Langage sûr en mémoire sans garbage collector"],
];
