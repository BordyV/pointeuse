# Pointeuse

Pointage arrivée / pause / fin de pause / départ, historique, solde d'heures
(« l'entreprise te doit » / « tu dois à l'entreprise ») et pointage automatique
de l'arrivée par GPS après 2 min sur place.

```
shared/core.js   logique commune (calculs, solde, règles GPS) — web et mobile
web/             version web de test (PWA installable, hors connexion)
mobile/          version mobile Expo / React Native (GPS en arrière-plan)
```

## Version web

Servir le dossier racine (pas `web/` seul, car il importe `../shared/core.js`) :

```bash
npx http-server D:/dev/claude/pointeuse -p 8080 -c-1
```

Puis ouvrir http://localhost:8080/web/.

- Réglages → « Charger des données de démo » pour voir l'historique et le solde.
- Réglages → « Mode test : simuler ma présence » pour tester le pointage auto sans bouger
  (mets le délai à 0.1 min pour ne pas attendre 2 min).
- Limite : un navigateur ne donne la position que quand la page est ouverte.
  Le GPS demande aussi du HTTPS (ou localhost).

### Sur le téléphone, sans store

```bash
node scripts/build-web.mjs
```

Le contenu de `dist/` s'héberge tel quel en HTTPS (GitHub Pages par exemple).
Le HTTPS est obligatoire pour le GPS et l'installation. Sur le téléphone :
ouvrir le lien, puis « Ajouter à l'écran d'accueil » (Safari : bouton Partager ;
Chrome : menu ⋮ → Installer). L'app s'ouvre alors en plein écran et marche hors connexion.

Limite d'une webapp : le GPS ne tourne que pendant que l'app est ouverte à l'écran.
Le pointage automatique ne se fait donc que si tu ouvres l'app en arrivant.

Les icônes PNG se régénèrent avec `scripts/make-icons.ps1`.

## Version mobile (Expo, optionnelle)

```bash
cd mobile
npx expo start
```

- **Expo Go** (scanner le QR code) : tout marche sauf le pointage GPS app fermée.
- **Pointage auto en arrière-plan** : il faut un build de développement
  (`npx expo run:android` avec Android Studio, ou `npx eas-cli@latest build --profile development`).
  Accepter « Toujours autoriser » la localisation.

Fonctionnement du GPS mobile : le système surveille une zone autour du travail
(peu gourmand en batterie). À l'entrée, un suivi plus fin démarre ; si tu es
toujours dans la zone après le délai, l'arrivée est pointée, une notification
s'affiche et le suivi fin s'arrête. Rayon minimum 100 m (en dessous, les
geofences système sont peu fiables).

## Planning par photo

Onglet **Planning** → prendre en photo le planning affiché au magasin. L'app
envoie la photo à Claude (`claude-opus-5-5`, code dans `shared/planning.js`),
qui lit la ligne correspondant au nom saisi dans Réglages. Avant d'enregistrer,
tu vois un aperçu à vérifier, avec des alertes si la somme des créneaux ne
correspond pas aux totaux imprimés.

- Il faut une clé API Anthropic (console.anthropic.com), à saisir dans Réglages.
  Elle reste sur l'appareil : `localStorage` à part sur le web, SecureStore sur mobile,
  et n'est jamais incluse dans les sauvegardes. Compte quelques centimes par photo.
- Les fallbacks côté serveur sont activés (`fallbacks: "default"`) : si le
  modèle refuse la requête, l'API la relance sur un autre modèle.
- Le planning remplace les horaires contractuels pour les jours concernés.
  Un jour férié ou de repos compte 0 h prévue, et le pointage GPS automatique
  ne se déclenche pas ces jours-là.

## À faire

- **Import du planning depuis le fichier PDF ou Excel** reçu chaque semaine :
  lecture locale, gratuite, hors ligne et exacte (valeurs et couleurs des cases),
  à la place de la photo envoyée à Claude, qui resterait en option.
- Saisie rapide d'une semaine à la main, avec des raccourcis (matin, après-midi, repos, férié).

## Règles de calcul

- Solde = Σ (travaillé − prévu) sur les jours **terminés** + ajustement manuel.
  La journée en cours n'entre dans le solde qu'à sa fin.
- Un jour sans aucun pointage ne compte pas (congé, maladie, férié…).
- Un service qui passe minuit est rattaché au jour d'arrivée.
- Alerte si plus de 6 h travaillées avec moins de 20 min de pause (Code du travail, L3121-16).
- Un seul pointage auto par jour.
