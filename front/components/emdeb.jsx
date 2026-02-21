

const { useEffect, useRef } = React;
const { HubWsClient, WrtcBinaryChannel } = await loadModule("utils.js");

export default function Emdeb() {
    const canvasRef = useRef(null);
    const wsRef = useRef(null);

    const lastAdminIdRef = useRef(null);

    const recvChunksRef = useRef(0);
    const recvBytesRef = useRef(0);

    const rtcRef = useRef(null);
    const rtcPeerIdRef = useRef(null);
    const rtcOpenRef = useRef(false);
    const rtcSignalHandlerRef = useRef(null);

    const videoRef = useRef(null);
    const mediaSourceRef = useRef(null);
    const sourceBufferRef = useRef(null);
    const appendQueueRef = useRef([]);
    const drawRafRef = useRef(null);

    const drawPlaceholder = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#0b1220";
        ctx.fillRect(0, 0, w, h);

        ctx.fillStyle = "#94a3b8";
        ctx.font = "14px sans-serif";
        ctx.fillText("EMDEB", 12, 24);
    };

    const resizeCanvasToDisplaySize = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const nextW = Math.max(1, Math.floor(rect.width * dpr));
        const nextH = Math.max(1, Math.floor(rect.height * dpr));

        if (canvas.width !== nextW || canvas.height !== nextH) {
            canvas.width = nextW;
            canvas.height = nextH;
            drawPlaceholder();
        }
    };

    const infosPayload = () => {
        const video = videoRef.current;
        const ms = mediaSourceRef.current;
        const sb = sourceBufferRef.current;
        return {
            role: "emdeb",
            ts: Date.now(),
            userAgent: navigator.userAgent,
            rtc: {
                peerId: rtcPeerIdRef.current,
                open: rtcOpenRef.current,
            },
            stream: {
                recvChunks: recvChunksRef.current,
                recvBytes: recvBytesRef.current,
                queue: appendQueueRef.current.length,
                mse: {
                    readyState: ms?.readyState ?? null,
                    sourceBuffer: !!sb,
                    updating: !!sb?.updating,
                },
                video: {
                    readyState: video?.readyState ?? null,
                    paused: video?.paused ?? null,
                },
            },
        };
    };

    const sendInfosBroadcast = () => {
        try {
            wsRef.current?.sendJsonBroadcast("infos", infosPayload());
        } catch {}
    };

    const sendInfosTo = (to) => {
        try {
            wsRef.current?.sendJsonTo(to, "infos", infosPayload());
        } catch {}
    };

    const sendInfosHeartbeat = () => {
        const adminId = lastAdminIdRef.current;
        if (adminId != null) return sendInfosTo(adminId);
        return sendInfosBroadcast();
    };

    const stopRtc = () => {
        try { rtcRef.current?.close?.(); } catch {}
        rtcRef.current = null;
        rtcPeerIdRef.current = null;
        rtcOpenRef.current = false;
        sendInfosBroadcast();
    };

    const ensureMediaPipeline = () => {
        if (videoRef.current && mediaSourceRef.current) return;

        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        videoRef.current = video;

        const ms = new MediaSource();
        mediaSourceRef.current = ms;

        const url = URL.createObjectURL(ms);
        video.src = url;

        ms.addEventListener("sourceopen", () => {
            try {
                const mime = 'video/webm;codecs="vp8,opus"';
                const sb = ms.addSourceBuffer(mime);
                sb.mode = "sequence";
                sourceBufferRef.current = sb;

                // Flush queued chunks as soon as SourceBuffer exists
                const q0 = appendQueueRef.current;
                if (!sb.updating && q0.length > 0) {
                    try { sb.appendBuffer(q0.shift()); } catch {}
                }

                sb.addEventListener("updateend", () => {
                    const q = appendQueueRef.current;
                    if (!sb.updating && q.length > 0) {
                        try { sb.appendBuffer(q.shift()); } catch {}
                    }
                });
            } catch {
                // ignore
            }
        });
    };

    const enqueueChunk = (ab) => {
        const sb = sourceBufferRef.current;
        if (!sb) {
            appendQueueRef.current.push(ab);
            return;
        }

        if (sb.updating || appendQueueRef.current.length > 0) {
            appendQueueRef.current.push(ab);
            return;
        }

        try {
            sb.appendBuffer(ab);
        } catch {
            appendQueueRef.current.push(ab);
        }
    };

    const startDrawingToCanvas = () => {
        if (drawRafRef.current) return;
        const tick = () => {
            drawRafRef.current = requestAnimationFrame(tick);
            const canvas = canvasRef.current;
            const video = videoRef.current;
            if (!canvas || !video) return;

            if (video.readyState < 2) return;

            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            try {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            } catch {}
        };
        drawRafRef.current = requestAnimationFrame(tick);
    };

    useEffect(() => {
        const onResize = () => resizeCanvasToDisplaySize();
        window.addEventListener("resize", onResize);

        resizeCanvasToDisplaySize();

        const ws = new HubWsClient({
            urlBase: "wss://wshnklvucl.zen-apps.com/ws",
            room: "screen-mirror",
        });
        wsRef.current = ws;

        ws.onJson((msg) => {
            if (msg?.action === "infos_req") {
                if (msg?.from == null) return;
                lastAdminIdRef.current = msg.from;
                sendInfosTo(msg.from);
                return;
            }

            if (msg?.action === "rtc") {
                if (msg?.from == null) return;

                const peerId = msg.from;

                // (re)start responder when first rtc arrives or peer changes
                if (!rtcRef.current || rtcPeerIdRef.current !== peerId) {
                    stopRtc();
                    rtcPeerIdRef.current = peerId;

                    const channel = new WrtcBinaryChannel({
                        sendSignal: (signal) => {
                            ws.sendJsonTo(peerId, "rtc", signal);
                        },
                        onSignal: (handler) => {
                            rtcSignalHandlerRef.current = handler;
                            return () => {};
                        },
                    });

                    rtcRef.current = channel;
                    rtcOpenRef.current = false;

                    channel.onBinary((buf) => {
                        try {
                            recvChunksRef.current += 1;
                            recvBytesRef.current += buf?.byteLength || 0;
                        } catch {}
                        ensureMediaPipeline();
                        enqueueChunk(buf);
                        startDrawingToCanvas();
                    });

                    channel.start(false).then(() => {
                        rtcOpenRef.current = true;
                        sendInfosBroadcast();
                    }).catch(() => {
                        stopRtc();
                    });
                }

                // IMPORTANT: deliver the current rtc signal too (first offer often arrives here)
                try {
                    rtcSignalHandlerRef.current?.(msg.data);
                } catch {}

                // Signal message will be consumed via onSignal subscription
                return;
            }
        });

        ws.connect().catch(() => {});

        return () => {
            window.removeEventListener("resize", onResize);
            if (drawRafRef.current) {
                cancelAnimationFrame(drawRafRef.current);
                drawRafRef.current = null;
            }
            stopRtc();

            try {
                const video = videoRef.current;
                if (video) {
                    try { URL.revokeObjectURL(video.src); } catch {}
                }
            } catch {}
            videoRef.current = null;
            mediaSourceRef.current = null;
            sourceBufferRef.current = null;
            appendQueueRef.current = [];
            try { wsRef.current?.close(); } catch {}
            wsRef.current = null;
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            style={{ width: "100vw", height: "100vh", display: "block" }}
        />
    );
}
