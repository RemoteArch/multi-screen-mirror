let HubWsClient;
if (typeof loadModule === 'function') {
    const { HubWsClient: HubWsClientModule } = await loadModule("./utils.js");
    HubWsClient = HubWsClientModule;
} else {
    const { HubWsClient: HubWsClientImport } = await import("./utils.js");
    HubWsClient = HubWsClientImport;
}

const ROOM = "quizz";
const URL = "wss://wshnklvucl.zen-apps.com/ws";

export const startListener = async ({ onMessage } = {}) => {
    const client = new HubWsClient({
        urlBase: URL,
        room: ROOM,
        onStatus: (evt) => {

            try {
                console.log('🔌 Embed WebSocket:', evt.type);
            } finally {
                if (evt?.type === 'close' || evt?.type === 'error') {
                    try { if (broadcastInterval) clearInterval(broadcastInterval); } catch {}
                    broadcastInterval = null;
                }
            }
        }
    });

    client.onJson((msg) => {
        console.log('📩 Embed reçu (JSON):', msg);
        if (onMessage) onMessage(msg);
    });

    let broadcastInterval = null;
    const announce = () => {
        try {
            client.sendJsonBroadcast('embed_announce', {
                role: 'embed',
                ts: Date.now(),
            });
        } catch {}
    };

    await client.connect();
    console.log('✅ Embed connecté à la room:', ROOM);

    announce();
    broadcastInterval = setInterval(() => {
        announce();
    }, 10_000);
};

export const initSender = async ({ onStatus } = {}) => {
    const senderState = {
        registeredEmbeds: new Set(),
        client: null,
    };

    const client = new HubWsClient({
        urlBase: URL,
        room: ROOM,
        onStatus: (evt) => {
            console.log('🔌 Sender WebSocket:', evt.type);
            if (onStatus) onStatus(evt);
        }
    });
    senderState.client = client;

    client.onJson((msg) => {
        const { from, action } = msg;
        if (action === 'embed_announce') {
            senderState.registeredEmbeds.add(from);
            console.log(`📝 Embed ${from} enregistré. Total: ${senderState.registeredEmbeds.size}`);
        }
    });

    await client.connect();
    console.log('✅ Sender connecté à la room:', ROOM);

    const sendQuizz = (jsonData) => {
        if (!senderState.client) {
            console.error('❌ Sender non initialisé');
            return 0;
        }

        let sent = 0;
        for (const embedId of senderState.registeredEmbeds) {
            try {
                senderState.client.sendJsonTo(embedId, 'quizz', jsonData);
                sent++;
            } catch (e) {
                console.error(`❌ Erreur envoi quizz à embed ${embedId}:`, e);
            }
        }

        console.log(`📤 Quizz envoyé à ${sent} embeds`);
        return sent;
    };

    sendQuizz.getEmbeds = () => Array.from(senderState.registeredEmbeds);
    sendQuizz.getCount = () => senderState.registeredEmbeds.size;
    sendQuizz.stop = () => {
        try { senderState.client?.close(); } catch {}
        senderState.client = null;
        senderState.registeredEmbeds.clear();
    };

    window.sendQuizz = sendQuizz;
    console.log('✅ window.sendQuizz(data) prêt');
};