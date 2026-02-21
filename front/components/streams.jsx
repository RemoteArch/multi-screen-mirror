const { useEffect, useRef, useState } = React;

export default function ScreenStreams() {
    const [devices, setDevices] = useState([]);
    const eventSourceRef = useRef(null);

    useEffect(() => {
        eventSourceRef.current = new EventSource('/settings?action=devices-list');
        
        eventSourceRef.current.onmessage = (event) => {
            const devicesData = JSON.parse(event.data);
            setDevices(devicesData);
        };

        return () => {
            eventSourceRef.current?.close();
        };
    }, []);

    const sendSignal = async (id, signal) => {
        try {
            const res = await fetch(`/settings?action=send-signal&id=${id}&data=${signal}`);
            if (res.ok) {
                console.log(`[✓] Signal '${signal}' envoyé à ${id}`);
            } else {
                console.error(`[ERREUR] Envoi du signal '${signal}' à ${id} a échoué`);
            }
        } catch (err) {
            console.error('[ERREUR] Problème de connexion avec le serveur:', err);
        }
    };

    const pause = (id) => {
        sendSignal(id, 'pause');
    };

    const resume = (id) => {
        sendSignal(id, 'resume');
    };

    return (
        <div className="bg-gray-900 text-white min-h-screen p-4">
            <h1 className="text-3xl font-bold mb-6">🖥️ Clients connectés</h1>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10 w-full max-w-6xl">
                {devices.length === 0 ? (
                    <p className="text-gray-400 text-center col-span-full">Aucun device connecté.</p>
                ) : (
                    devices.map((id) => (
                        <DeviceCard 
                            key={id} 
                            id={id} 
                            onPause={pause} 
                            onResume={resume} 
                        />
                    ))
                )}
            </div>
        </div>
    );
}

function DeviceCard({ id, onPause, onResume }) {
    const [imgSrc, setImgSrc] = useState('');
    const [showImage, setShowImage] = useState(false);

    const handleResume = () => {
        onResume(id);
        setImgSrc(`/stream?id=${id}`);
        setShowImage(true);
    };

    const handleImageError = () => {
        setTimeout(() => {
            setImgSrc(`/stream?id=${id}&t=${Date.now()}`);
        }, 1000);
    };

    return (
        <div className="device-card group relative bg-gray-800 p-6 rounded shadow hover:border-blue-500 hover:border flex flex-col items-center justify-center h-48">
            {showImage && (
                <img 
                    src={imgSrc} 
                    alt={`Stream ${id}`}
                    className="absolute w-full h-full object-cover"
                    onError={handleImageError}
                />
            )}
            
            <div className="device-id absolute top-2 left-3 text-sm text-gray-300">
                🖥️ {id}
            </div>
            
            <div className="center-actions flex gap-3 my-4 hidden group-hover:flex relative z-10">
                <button 
                    onClick={() => onPause(id)}
                    className="pause-btn bg-yellow-600 hover:bg-yellow-700 text-white text-xl px-3 py-1 rounded"
                >
                    ⏸️
                </button>
                <button 
                    onClick={handleResume}
                    className="resume-btn bg-green-600 hover:bg-green-700 text-white text-xl px-3 py-1 rounded"
                >
                    ▶️
                </button>
            </div>
        </div>
    );
}
