// ============================================
// CONFIGURATION
// ============================================

// Activer les logs de debug (mettre à false en production)
const DEBUG_MODE = true;

// ============================================
// VARIABLES GLOBALES
// ============================================

let castReceiverContext = null;
let playerManager = null;
let videoElement = null;

// ============================================
// INITIALISATION DU RECEIVER
// ============================================

function initializeReceiver() {
    try {
        // Récupérer le contexte du receiver
        castReceiverContext = cast.framework.CastReceiverContext.getInstance();
        
        // Récupérer le player manager
        playerManager = castReceiverContext.getPlayerManager();
        
        // Récupérer l'élément vidéo
        videoElement = document.getElementById('videoElement');

        // Configuration des options du receiver
        const options = new cast.framework.CastReceiverOptions();
        
        // Désactiver le timeout si pas de sender (utile pour le debug)
        options.disableIdleTimeout = DEBUG_MODE;
        
        // Configurer les types de média supportés
        options.supportedCommands = cast.framework.messages.Command.ALL_BASIC_MEDIA;

        logDebug('🎬 Initialisation du Cast Receiver...');

        // Écouter les événements du player
        setupPlayerListeners();

        // Démarrer le receiver avec les options
        castReceiverContext.start(options);
        
        logDebug('✅ Receiver démarré avec succès');
        updateStatus('Prêt à recevoir du contenu');

    } catch (error) {
        logDebug('❌ Erreur lors de l\'initialisation : ' + error.message);
        console.error('Erreur initialisation receiver:', error);
    }
}

// ============================================
// GESTION DES ÉVÉNEMENTS PLAYER
// ============================================

function setupPlayerListeners() {
    // Événement LOAD : quand une nouvelle vidéo est demandée
    playerManager.setMessageInterceptor(
        cast.framework.messages.MessageType.LOAD,
        (loadRequestData) => {
            logDebug('📥 Requête LOAD reçue');
            
            // Récupérer les informations du média
            const mediaInfo = loadRequestData.media;
            
            if (!mediaInfo || !mediaInfo.contentId) {
                logDebug('⚠️ Aucune URL de vidéo reçue');
                updateStatus('Erreur : aucune URL de vidéo');
                return loadRequestData;
            }

            const videoUrl = mediaInfo.contentId;
            const contentType = mediaInfo.contentType || 'video/mp4';
            const title = mediaInfo.metadata?.title || 'Vidéo sans titre';

            logDebug('🎥 URL vidéo : ' + videoUrl);
            logDebug('📝 Type : ' + contentType);
            logDebug('📌 Titre : ' + title);

            // Masquer l'overlay d'info
            hideInfoOverlay();

            // Charger et lire la vidéo
            loadAndPlayVideo(videoUrl, contentType);

            // Retourner les données modifiées (ou non) au player
            return loadRequestData;
        }
    );

    // Événement de changement d'état du player
    playerManager.addEventListener(
        cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
        () => {
            logDebug('✅ Vidéo chargée avec succès');
            updateStatus('Lecture en cours...');
        }
    );

    playerManager.addEventListener(
        cast.framework.events.EventType.ERROR,
        (event) => {
            logDebug('❌ Erreur player : ' + JSON.stringify(event.detailedErrorCode));
            updateStatus('Erreur de lecture');
            showInfoOverlay();
        }
    );

    playerManager.addEventListener(
        cast.framework.events.EventType.ENDED,
        () => {
            logDebug('🏁 Lecture terminée');
            updateStatus('Lecture terminée');
            showInfoOverlay();
        }
    );
}

// ============================================
// GESTION DE LA VIDÉO
// ============================================

function loadAndPlayVideo(url, contentType) {
    try {
        // Vérifier que l'élément vidéo existe
        if (!videoElement) {
            logDebug('❌ Élément vidéo introuvable');
            return;
        }

        // Définir la source de la vidéo
        videoElement.src = url;
        videoElement.type = contentType;

        // Lire la vidéo
        videoElement.play()
            .then(() => {
                logDebug('▶️ Lecture démarrée');
                updateStatus('Lecture en cours...');
            })
            .catch((error) => {
                logDebug('❌ Erreur lecture : ' + error.message);
                updateStatus('Erreur de lecture');
                console.error('Erreur play():', error);
            });

    } catch (error) {
        logDebug('❌ Erreur chargement vidéo : ' + error.message);
        console.error('Erreur loadAndPlayVideo:', error);
    }
}

// ============================================
// GESTION DE L'INTERFACE
// ============================================

function updateStatus(message) {
    const statusEl = document.getElementById('receiverStatus');
    if (statusEl) {
        statusEl.textContent = message;
    }
}

function hideInfoOverlay() {
    const overlay = document.getElementById('infoOverlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

function showInfoOverlay() {
    const overlay = document.getElementById('infoOverlay');
    if (overlay) {
        overlay.style.display = 'flex';
    }
}

function logDebug(message) {
    // Toujours logger dans la console
    console.log(message);
    
    // Afficher dans le panneau de debug si activé
    if (DEBUG_MODE) {
        const debugLog = document.getElementById('debugLog');
        if (debugLog) {
            const timestamp = new Date().toLocaleTimeString();
            const logEntry = document.createElement('div');
            logEntry.className = 'debug-entry';
            logEntry.textContent = `[${timestamp}] ${message}`;
            debugLog.appendChild(logEntry);
            
            // Limiter le nombre d'entrées (garder les 50 dernières)
            while (debugLog.children.length > 50) {
                debugLog.removeChild(debugLog.firstChild);
            }
            
            // Scroller vers le bas
            debugLog.scrollTop = debugLog.scrollHeight;
        }
    }
}

// ============================================
// DÉMARRAGE
// ============================================

// Attendre que le DOM soit chargé
document.addEventListener('DOMContentLoaded', () => {
    logDebug('📺 DOM chargé, initialisation du receiver...');
    initializeReceiver();
});

// Gestion des erreurs globales
window.addEventListener('error', (event) => {
    logDebug('❌ Erreur globale : ' + event.message);
    console.error('Erreur globale:', event);
});
