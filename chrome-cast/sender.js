// ============================================
// CONFIGURATION À MODIFIER
// ============================================

// ⚠️ À CONFIGURER ICI : Remplacez par votre Application ID Google Cast
// Obtenu après enregistrement de votre Custom Receiver sur Google Cast SDK Developer Console
const RECEIVER_APP_ID = 'CC1AD845'; // Exemple : utilisez le Default Media Receiver pour les tests
// Pour un Custom Receiver, remplacez par votre propre APP_ID (ex: '12345ABC')

// ============================================
// VARIABLES GLOBALES
// ============================================

let castSession = null;
let castContext = null;

// ============================================
// INITIALISATION DU CAST CONTEXT
// ============================================

window['__onGCastApiAvailable'] = function(isAvailable) {
    if (isAvailable) {
        initializeCastApi();
    } else {
        showError('Google Cast API non disponible. Vérifiez que vous utilisez Chrome/Edge.');
    }
};

function initializeCastApi() {
    try {
        // Initialisation du CastContext avec l'APP_ID
        castContext = cast.framework.CastContext.getInstance();
        
        castContext.setOptions({
            receiverApplicationId: RECEIVER_APP_ID,
            autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
        });

        // Écouter les changements de session
        castContext.addEventListener(
            cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
            onSessionStateChanged
        );

        // Écouter les changements d'état de Cast
        castContext.addEventListener(
            cast.framework.CastContextEventType.CAST_STATE_CHANGED,
            onCastStateChanged
        );

        console.log('✅ Cast API initialisée avec APP_ID:', RECEIVER_APP_ID);
        updateStatus('Non connecté', 'disconnected');
        
    } catch (error) {
        console.error('❌ Erreur initialisation Cast API:', error);
        showError('Erreur lors de l\'initialisation : ' + error.message);
    }
}

// ============================================
// GESTION DES ÉVÉNEMENTS CAST
// ============================================

function onSessionStateChanged(event) {
    console.log('📡 Session state changed:', event.sessionState);
    
    switch (event.sessionState) {
        case cast.framework.SessionState.SESSION_STARTED:
        case cast.framework.SessionState.SESSION_RESUMED:
            castSession = castContext.getCurrentSession();
            updateStatus('Connecté', 'connected');
            enableSendButton(true);
            updateDebugInfo();
            break;
            
        case cast.framework.SessionState.SESSION_ENDED:
            castSession = null;
            updateStatus('Déconnecté', 'disconnected');
            enableSendButton(false);
            updateDebugInfo();
            break;
    }
}

function onCastStateChanged(event) {
    console.log('🔄 Cast state changed:', event.castState);
    
    switch (event.castState) {
        case cast.framework.CastState.NO_DEVICES_AVAILABLE:
            updateDebugInfo('Aucun appareil Cast détecté sur le réseau');
            break;
        case cast.framework.CastState.NOT_CONNECTED:
            updateStatus('Non connecté', 'disconnected');
            break;
        case cast.framework.CastState.CONNECTING:
            updateStatus('Connexion en cours...', 'connecting');
            break;
        case cast.framework.CastState.CONNECTED:
            updateStatus('Connecté', 'connected');
            break;
    }
}

// ============================================
// ENVOI DE LA VIDÉO
// ============================================

function sendVideo() {
    // Vérifier qu'une session existe
    if (!castSession) {
        showError('Aucune session Cast active. Connectez-vous d\'abord à un appareil.');
        return;
    }

    // Récupérer l'URL de la vidéo
    const videoUrl = document.getElementById('videoUrl').value.trim();
    
    if (!videoUrl) {
        showError('Veuillez saisir une URL de vidéo.');
        return;
    }

    // Valider l'URL
    try {
        new URL(videoUrl);
    } catch (e) {
        showError('URL invalide. Vérifiez le format.');
        return;
    }

    console.log('📤 Envoi de la vidéo:', videoUrl);
    updateStatus('Envoi en cours...', 'connecting');

    // Déterminer le type MIME en fonction de l'extension
    let contentType = 'video/mp4';
    if (videoUrl.includes('.m3u8')) {
        contentType = 'application/x-mpegURL'; // HLS
    } else if (videoUrl.includes('.webm')) {
        contentType = 'video/webm';
    }

    // Créer le MediaInfo
    const mediaInfo = new chrome.cast.media.MediaInfo(videoUrl, contentType);
    mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
    mediaInfo.metadata.title = 'Ma vidéo';
    mediaInfo.metadata.subtitle = 'Envoyée depuis Cast Sender';

    // Créer la requête de chargement
    const request = new chrome.cast.media.LoadRequest(mediaInfo);
    request.autoplay = true;
    request.currentTime = 0;

    // Envoyer la requête au receiver
    castSession.loadMedia(request)
        .then(() => {
            console.log('✅ Vidéo envoyée avec succès');
            updateStatus('Vidéo envoyée', 'video-sent');
            hideError();
            updateDebugInfo('Vidéo en cours de lecture sur le Chromecast');
        })
        .catch((error) => {
            console.error('❌ Erreur lors de l\'envoi:', error);
            showError('Impossible d\'envoyer la vidéo : ' + error.message);
            updateStatus('Erreur', 'error');
        });
}

// ============================================
// GESTION DE L'INTERFACE
// ============================================

function updateStatus(text, className) {
    const statusEl = document.getElementById('status');
    statusEl.textContent = text;
    statusEl.className = 'status status-' + className;
}

function enableSendButton(enabled) {
    const btn = document.getElementById('sendVideoBtn');
    btn.disabled = !enabled;
}

function showError(message) {
    const errorSection = document.getElementById('errorSection');
    const errorMessage = document.getElementById('errorMessage');
    errorMessage.textContent = message;
    errorSection.style.display = 'block';
}

function hideError() {
    const errorSection = document.getElementById('errorSection');
    errorSection.style.display = 'none';
}

function updateDebugInfo(customMessage) {
    const debugInfo = document.getElementById('debugInfo');
    
    if (customMessage) {
        debugInfo.innerHTML = `<p>${customMessage}</p>`;
        return;
    }
    
    if (castSession) {
        const sessionId = castSession.getSessionId();
        const deviceName = castSession.getCastDevice().friendlyName;
        
        debugInfo.innerHTML = `
            <p><strong>Appareil :</strong> ${deviceName}</p>
            <p><strong>Session ID :</strong> ${sessionId}</p>
            <p><strong>État :</strong> Connecté</p>
        `;
    } else {
        debugInfo.innerHTML = `<p>En attente de connexion...</p>`;
    }
}

// ============================================
// ÉVÉNEMENTS DOM
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    // Bouton d'envoi de vidéo
    const sendBtn = document.getElementById('sendVideoBtn');
    sendBtn.addEventListener('click', sendVideo);
    
    // Permettre l'envoi avec la touche Entrée
    const urlInput = document.getElementById('videoUrl');
    urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !sendBtn.disabled) {
            sendVideo();
        }
    });
    
    console.log('🎬 Sender initialisé. En attente du Cast SDK...');
});
