# 🎬 Google Cast Mini-Projet

Projet web complet pour envoyer et recevoir des vidéos via Google Cast (Chromecast).

## 📁 Structure du projet

```
chrome-cast/
├── sender.html       # Page web pour envoyer des vidéos
├── sender.js         # Logique du sender (Google Cast Web Sender SDK)
├── receiver.html     # Page receiver pour Chromecast
├── receiver.js       # Logique du receiver (CAF Web Receiver SDK)
├── style.css         # Styles communs
└── README.md         # Ce fichier
```

## 🚀 Guide de démarrage rapide

### Étape 1 : Héberger les fichiers

Les fichiers doivent être servis via **HTTPS** pour que Google Cast fonctionne.

#### Option A : Serveur local avec HTTPS (recommandé pour les tests)

1. Installez un serveur local avec support HTTPS :
   ```bash
   npm install -g http-server
   ```

2. Générez un certificat auto-signé (ou utilisez un outil comme `mkcert`) :
   ```bash
   # Avec mkcert (recommandé)
   mkcert -install
   mkcert localhost 127.0.0.1 ::1
   ```

3. Lancez le serveur HTTPS :
   ```bash
   http-server -S -C localhost+2.pem -K localhost+2-key.pem -p 8443
   ```

4. Accédez à : `https://localhost:8443/sender.html`

#### Option B : Hébergement en ligne (pour tests réels)

Hébergez les fichiers sur un service gratuit avec HTTPS :
- **GitHub Pages** (gratuit, HTTPS automatique)
- **Netlify** (gratuit, HTTPS automatique)
- **Vercel** (gratuit, HTTPS automatique)

Exemple avec GitHub Pages :
1. Créez un repo GitHub
2. Uploadez les fichiers
3. Activez GitHub Pages dans Settings
4. Votre URL sera : `https://username.github.io/repo-name/`

---

### Étape 2 : Enregistrer un Custom Web Receiver

⚠️ **IMPORTANT** : Pour utiliser votre propre receiver, vous devez l'enregistrer sur Google Cast SDK Developer Console.

#### 2.1 Créer un compte développeur Google Cast

1. Allez sur : https://cast.google.com/publish/
2. Connectez-vous avec votre compte Google
3. Payez les frais d'inscription unique (5 USD)

#### 2.2 Enregistrer votre Custom Receiver

1. Dans la console, cliquez sur **"Add New Application"**
2. Sélectionnez **"Custom Receiver"**
3. Remplissez les informations :
   - **Name** : `Mon Cast Receiver` (ou autre nom)
   - **Receiver Application URL** : L'URL HTTPS de votre `receiver.html`
     - Exemple : `https://votre-domaine.com/receiver.html`
     - Ou : `https://username.github.io/repo-name/receiver.html`
   - **Category** : Choisissez une catégorie (ex: Video)
   - **Guest Mode** : Activez si vous voulez permettre le cast sans WiFi

4. Cliquez sur **"Save"**

5. **Notez votre Application ID** (format : `12345ABC`)
   - Il apparaît dans la liste de vos applications
   - Vous en aurez besoin pour configurer le sender

---

### Étape 3 : Configurer l'Application ID

#### Dans `sender.js` :

Ouvrez `sender.js` et remplacez la ligne suivante :

```javascript
// ⚠️ À CONFIGURER ICI
const RECEIVER_APP_ID = 'CC1AD845'; // ← Remplacez par votre APP_ID
```

Par votre propre Application ID :

```javascript
const RECEIVER_APP_ID = '12345ABC'; // ← Votre APP_ID obtenu à l'étape 2
```

**Note** : `CC1AD845` est le **Default Media Receiver** de Google. Il fonctionne pour les tests basiques mais ne charge pas votre `receiver.html` personnalisé.

---

### Étape 4 : Tester avec une vidéo

#### 4.1 Préparer un appareil Chromecast

1. Assurez-vous que votre Chromecast est sur le **même réseau WiFi** que votre ordinateur
2. Ouvrez Chrome/Edge sur votre ordinateur

#### 4.2 Ouvrir la page sender

1. Ouvrez `https://localhost:8443/sender.html` (ou votre URL hébergée)
2. Vous devriez voir l'interface du sender

#### 4.3 Se connecter au Chromecast

1. Cliquez sur l'**icône Cast** (📡) en haut à droite de la page
2. Sélectionnez votre appareil Chromecast dans la liste
3. Le statut devrait passer à **"Connecté"**

#### 4.4 Envoyer une vidéo

1. Dans le champ URL, entrez une URL de vidéo MP4 accessible publiquement :
   - **Exemple de test** (déjà pré-rempli) :
     ```
     https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4
     ```
   - Ou une autre URL MP4 publique

2. Cliquez sur **"📤 Envoyer la vidéo"**

3. La vidéo devrait commencer à jouer sur votre Chromecast !

---

## 🎥 URLs de test

Voici quelques URLs de vidéos publiques pour tester :

### MP4 (recommandé pour les tests)
```
https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4
https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4
https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4
```

### HLS (M3U8)
```
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8
```

---

## ❌ Erreurs fréquentes et solutions

### 1. "Google Cast API non disponible"

**Cause** : Le SDK Cast n'est pas chargé ou vous n'utilisez pas Chrome/Edge.

**Solution** :
- Utilisez **Google Chrome** ou **Microsoft Edge**
- Vérifiez que le script SDK est bien chargé dans `sender.html` :
  ```html
  <script src="https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"></script>
  ```
- Vérifiez votre connexion internet

---

### 2. "Aucun appareil Cast détecté"

**Cause** : Votre Chromecast n'est pas sur le même réseau ou n'est pas détectable.

**Solution** :
- Vérifiez que votre Chromecast et votre ordinateur sont sur le **même réseau WiFi**
- Redémarrez votre Chromecast
- Ouvrez l'application Google Home sur votre téléphone pour vérifier que le Chromecast est bien connecté
- Désactivez temporairement les VPN/pare-feu qui pourraient bloquer la découverte

---

### 3. "Erreur lors de l'envoi de la vidéo"

**Cause** : URL invalide, vidéo non accessible, ou problème de CORS.

**Solution** :
- Vérifiez que l'URL de la vidéo est **publiquement accessible**
- Testez l'URL dans votre navigateur pour vérifier qu'elle fonctionne
- Assurez-vous que le serveur hébergeant la vidéo autorise les requêtes CORS
- Utilisez une URL de test fournie ci-dessus pour vérifier que le système fonctionne

---

### 4. "Le receiver ne charge pas ma page personnalisée"

**Cause** : Vous utilisez le Default Media Receiver (`CC1AD845`) au lieu de votre Custom Receiver.

**Solution** :
- Vérifiez que vous avez bien remplacé `RECEIVER_APP_ID` dans `sender.js` par **votre propre APP_ID**
- Vérifiez que votre `receiver.html` est accessible via HTTPS
- Attendez quelques minutes après l'enregistrement du receiver (propagation)
- Testez l'URL du receiver directement dans Chrome pour vérifier qu'elle charge

---

### 5. "Mixed Content" ou erreurs HTTPS

**Cause** : Le sender est en HTTPS mais la vidéo ou le receiver est en HTTP.

**Solution** :
- Assurez-vous que **tout** est en HTTPS :
  - Le sender (`sender.html`)
  - Le receiver (`receiver.html`)
  - L'URL de la vidéo
- Les navigateurs modernes bloquent le contenu HTTP chargé depuis une page HTTPS

---

### 6. "Session Cast se déconnecte immédiatement"

**Cause** : Le receiver ne répond pas ou crash.

**Solution** :
- Ouvrez la console du receiver (voir section Debug ci-dessous)
- Vérifiez les logs d'erreur
- Assurez-vous que le SDK CAF est bien chargé dans `receiver.html` :
  ```html
  <script src="https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js"></script>
  ```

---

## 🐛 Debug et logs

### Logs du sender

Ouvrez la **console développeur** de Chrome (F12) sur la page `sender.html` pour voir :
- Les événements de connexion Cast
- Les erreurs d'envoi de vidéo
- Les changements d'état de session

### Logs du receiver

Pour voir les logs du receiver sur votre Chromecast :

1. Trouvez l'**adresse IP** de votre Chromecast :
   - Ouvrez l'application Google Home
   - Sélectionnez votre Chromecast
   - Allez dans Paramètres → Informations

2. Ouvrez dans Chrome :
   ```
   http://[IP_CHROMECAST]:9222
   ```
   Exemple : `http://192.168.1.100:9222`

3. Cliquez sur le lien de votre receiver pour ouvrir les DevTools

4. Vous verrez tous les logs de `receiver.js` dans la console

---

## 🔧 Configuration avancée

### Changer le timeout du receiver

Dans `receiver.js`, modifiez :

```javascript
const DEBUG_MODE = true; // false en production
```

En mode debug, le receiver ne se déconnecte pas automatiquement après 5 secondes d'inactivité.

### Personnaliser l'interface du receiver

Modifiez `receiver.html` et `style.css` pour changer :
- Le logo affiché
- Les couleurs
- Les messages
- L'apparence du player vidéo

### Ajouter des métadonnées à la vidéo

Dans `sender.js`, modifiez la section `MediaInfo` :

```javascript
mediaInfo.metadata.title = 'Mon titre personnalisé';
mediaInfo.metadata.subtitle = 'Sous-titre';
mediaInfo.metadata.images = [
    new chrome.cast.Image('https://example.com/poster.jpg')
];
```

---

## 📚 Ressources utiles

- **Documentation officielle Google Cast** :
  - Web Sender SDK : https://developers.google.com/cast/docs/web_sender
  - CAF Receiver SDK : https://developers.google.com/cast/docs/web_receiver

- **Console développeur** :
  - https://cast.google.com/publish/

- **Exemples de code** :
  - https://github.com/googlecast/CastVideos-chrome

---

## ✅ Checklist de vérification

Avant de tester, assurez-vous que :

- [ ] Les fichiers sont servis en **HTTPS**
- [ ] Vous avez enregistré un **Custom Receiver** sur Google Cast Console
- [ ] Vous avez remplacé `RECEIVER_APP_ID` dans `sender.js` par votre APP_ID
- [ ] L'URL du receiver est correcte et accessible
- [ ] Votre Chromecast et votre ordinateur sont sur le **même réseau WiFi**
- [ ] Vous utilisez **Chrome** ou **Edge**
- [ ] L'URL de la vidéo est **publique** et en **HTTPS**

---

## 🎉 Bon casting !

Si tout fonctionne, vous devriez pouvoir :
1. Ouvrir `sender.html`
2. Vous connecter à votre Chromecast
3. Envoyer une vidéo
4. La voir jouer sur votre TV !

En cas de problème, consultez la section **Erreurs fréquentes** ci-dessus ou les logs de debug.
