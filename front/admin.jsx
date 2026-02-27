const { useEffect, useMemo, useRef, useState } = React;
const { HubWsClient } = await loadModule("utils.js");

export default function Admin() {
    const [status, setStatus] = useState("idle");
    const [lastUpdateTs, setLastUpdateTs] = useState(null);
    const [lastError, setLastError] = useState("");
    const [lastWsError, setLastWsError] = useState("");
    const [filter, setFilter] = useState("");
    const [selectedAgentId, setSelectedAgentId] = useState("");
    const [targetEmbedId, setTargetEmbedId] = useState("");
    const wsRef = useRef(null);
    const reconnectTimerRef = useRef(null);
    const infosIntervalRef = useRef(null);
    const purgeIntervalRef = useRef(null);
    const [peersById, setPeersById] = useState({});

    const closeWs = () => {
        try { wsRef.current?.close(); } catch {}
        wsRef.current = null;
    };

    const scheduleReconnect = (delayMs = 1500) => {
        if (reconnectTimerRef.current) return;
        setStatus((s) => (s === "connected" ? "reconnecting" : s));
        reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connectWs();
        }, delayMs);
    };

    const connectWs = async () => {
        closeWs();

        try {
            setStatus("reconnecting");
            setLastError("");
            setLastWsError("");

            const ws = new HubWsClient({
                urlBase: "wss://wshnklvucl.zen-apps.com/ws",
                room: "screen-mirror",
                onStatus: (s) => {
                    if (s?.type === "open") setStatus("connected");
                    else if (s?.type === "close") {
                        setStatus("error");
                        setLastWsError(`close ${s?.detail?.code ?? ""} ${s?.detail?.reason ?? ""}`.trim());
                        scheduleReconnect(2000);
                    } else if (s?.type === "error") {
                        setStatus("error");
                        setLastWsError("ws error");
                    }
                },
            });

            ws.onJson((msg) => {
                if (msg?.action !== "infos") return;

                const from = msg.from;
                if (from == null) return;

                setPeersById((prev) => {
                    const next = { ...prev };
                    next[from] = {
                        id: from,
                        lastSeenTs: Date.now(),
                        data: msg.data,
                    };
                    return next;
                });
                setLastUpdateTs(Date.now());
            });

            wsRef.current = ws;
            await ws.connect();
        } catch (e) {
            setStatus("error");
            setLastError(String(e?.message || e));
            scheduleReconnect(3000);
        }
    };

    const broadcastInfos = () => {
        try {
            wsRef.current?.sendJsonBroadcast("infos_req", {
                ts: Date.now(),
            });
        } catch {}
    };

    const sendCmd = (to, data) => {
        try {
            wsRef.current?.sendJsonTo(Number(to), "cmd", data);
        } catch {}
    };

    const startCapture = () => {
        if (!selectedAgentId) return;
        sendCmd(selectedAgentId, { type: "start_capture" });
    };

    const stopCapture = () => {
        if (!selectedAgentId) return;
        sendCmd(selectedAgentId, { type: "stop_capture" });
    };

    const connectEmbed = () => {
        if (!selectedAgentId) return;
        if (!targetEmbedId) return;
        sendCmd(selectedAgentId, { type: "connect_embed", targetId: Number(targetEmbedId) });
    };

    const disconnectEmbed = () => {
        if (!selectedAgentId) return;
        sendCmd(selectedAgentId, { type: "disconnect_embed" });
    };

    useEffect(() => {
        connectWs();

        broadcastInfos();
        infosIntervalRef.current = setInterval(() => {
            broadcastInfos();
        }, 5000);

        purgeIntervalRef.current = setInterval(() => {
            const now = Date.now();
            setPeersById((prev) => {
                let changed = false;
                const next = { ...prev };
                for (const [id, peer] of Object.entries(prev)) {
                    const lastSeenTs = peer?.lastSeenTs || 0;
                    if (lastSeenTs && now - lastSeenTs > 10_000) {
                        delete next[id];
                        changed = true;
                    }
                }
                return changed ? next : prev;
            });
        }, 1000);

        return () => {
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            if (infosIntervalRef.current) {
                clearInterval(infosIntervalRef.current);
                infosIntervalRef.current = null;
            }
            if (purgeIntervalRef.current) {
                clearInterval(purgeIntervalRef.current);
                purgeIntervalRef.current = null;
            }
            closeWs();
        };
    }, []);

    const agentsList = useMemo(() => {
        return Object.values(peersById).sort((a, b) => {
            const ia = Number(a?.id ?? 0);
            const ib = Number(b?.id ?? 0);
            return ia - ib;
        });
    }, [peersById]);

    const { agents, embeds } = useMemo(() => {
        const agents = [];
        const embeds = [];
        for (const p of agentsList) {
            const role = p?.data?.role;
            if (role === "agent") agents.push(p);
            else if (role === "emdeb") embeds.push(p);
        }
        return { agents, embeds };
    }, [agentsList]);

    const filteredDevices = useMemo(() => {
        const q = filter.trim().toLowerCase();
        if (!q) return agentsList;
        return agentsList.filter((a) => String(a.id).toLowerCase().includes(q));
    }, [agentsList, filter]);

    const lastUpdateLabel = (() => {
        if (!lastUpdateTs) return "-";
        const sec = Math.max(0, Math.round((Date.now() - lastUpdateTs) / 1000));
        return `${sec}s`;
    })();

    return (
        <div className="bg-gray-900 text-white min-h-screen p-4">
            <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
                <div>
                    <h1 className="text-3xl font-bold">Admin</h1>
                    <div className="text-sm text-gray-400 mt-1">
                        <span className="mr-4">Status: <StatusPill status={status} /></span>
                        <span>Dernière mise à jour: {lastUpdateLabel}</span>
                    </div>
                    {lastWsError ? (
                        <div className="text-xs text-red-200 mt-2 break-all">{lastWsError}</div>
                    ) : null}
                    {lastError ? (
                        <div className="text-xs text-red-200 mt-2 break-all">{lastError}</div>
                    ) : null}
                </div>

                <div className="flex items-center gap-2">
                    <input
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filtrer par ID..."
                        className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-blue-500"
                    />
                    <select
                        value={selectedAgentId}
                        onChange={(e) => setSelectedAgentId(e.target.value)}
                        className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-blue-500"
                    >
                        <option value="">Agent...</option>
                        {agents.map((a) => (
                            <option key={a.id} value={String(a.id)}>
                                {a.id}
                            </option>
                        ))}
                    </select>
                    <select
                        value={targetEmbedId}
                        onChange={(e) => setTargetEmbedId(e.target.value)}
                        className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-blue-500"
                    >
                        <option value="">Embed...</option>
                        {embeds.map((e) => (
                            <option key={e.id} value={String(e.id)}>
                                {e.id}
                            </option>
                        ))}
                    </select>
                    <button
                        onClick={() => connectWs()}
                        className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-3 py-2 rounded"
                    >
                        Reconnect
                    </button>
                    <button
                        onClick={() => startCapture()}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm px-3 py-2 rounded"
                    >
                        Start cap
                    </button>
                    <button
                        onClick={() => stopCapture()}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm px-3 py-2 rounded"
                    >
                        Stop cap
                    </button>
                    <button
                        onClick={() => connectEmbed()}
                        className="bg-purple-600 hover:bg-purple-700 text-white text-sm px-3 py-2 rounded"
                    >
                        Connect embed
                    </button>
                    <button
                        onClick={() => disconnectEmbed()}
                        className="bg-purple-600 hover:bg-purple-700 text-white text-sm px-3 py-2 rounded"
                    >
                        Disc embed
                    </button>
                </div>
            </div>

            <div className="text-sm text-gray-300 mb-4">
                Peers: <span className="font-semibold">{agentsList.length}</span>
                <span className="ml-3 text-gray-400">Agents: {agents.length}</span>
                <span className="ml-3 text-gray-400">Embeds: {embeds.length}</span>
                {filter.trim() ? (
                    <span className="ml-3 text-gray-400">Filtrés: {filteredDevices.length}</span>
                ) : null}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 w-full max-w-6xl">
                {filteredDevices.length === 0 ? (
                    <div className="text-gray-400 col-span-full">
                        {agentsList.length === 0 ? "Aucun agent détecté." : "Aucun résultat."}
                    </div>
                ) : (
                    filteredDevices.map((agent) => (
                        <DeviceInfoCard key={agent.id} peer={agent} />
                    ))
                )}
            </div>
        </div>
    );
}

function StatusPill({ status }) {
    const cls =
        status === "connected"
            ? "bg-green-700/40 text-green-200 border-green-700"
            : status === "reconnecting"
                ? "bg-yellow-700/30 text-yellow-200 border-yellow-700"
                : status === "error"
                    ? "bg-red-700/30 text-red-200 border-red-700"
                    : "bg-gray-700/30 text-gray-200 border-gray-600";

    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs ${cls}`}>
            {status}
        </span>
    );
}

function DeviceInfoCard({ peer }) {
    const id = peer?.id;
    const data = peer?.data;
    const lastSeenTs = peer?.lastSeenTs;
    const lastCmd = data?.lastCmd;

    const lastSeenLabel = (() => {
        if (!lastSeenTs) return "-";
        const sec = Math.max(0, Math.round((Date.now() - lastSeenTs) / 1000));
        return `${sec}s`;
    })();

    const lastCmdLabel = (() => {
        if (!lastCmd?.ts) return "-";
        const sec = Math.max(0, Math.round((Date.now() - lastCmd.ts) / 1000));
        return `${sec}s`;
    })();

    return (
        <div className="bg-gray-800 p-5 rounded border border-gray-700">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <div className="text-sm text-gray-400">Device</div>
                    <div className="text-lg font-semibold break-all">{id}</div>
                </div>
                <span className="text-xs bg-gray-700/40 border border-gray-600 px-2 py-0.5 rounded">vu il y a {lastSeenLabel}</span>
            </div>

            <div className="mt-3 text-xs text-gray-300">
                <div className="flex justify-between gap-2">
                    <span className="text-gray-400">role</span>
                    <span className="break-all">{data?.role ?? "-"}</span>
                </div>
                <div className="flex justify-between gap-2 mt-1">
                    <span className="text-gray-400">userAgent</span>
                    <span className="break-all text-right">{data?.userAgent ?? "-"}</span>
                </div>
            </div>

            <div className="mt-4 text-sm text-gray-300">
                <div className="flex justify-between gap-2 mt-2">
                    <span className="text-gray-400">Dernière action</span>
                    <span className="break-all text-right">
                        {lastCmd?.type ? (
                            <span className={lastCmd.ok ? "text-green-300" : "text-red-300"}>
                                {lastCmd.type} {lastCmd.ok ? "ok" : "error"} (il y a {lastCmdLabel})
                            </span>
                        ) : (
                            "-"
                        )}
                    </span>
                </div>
                {!lastCmd?.ok && (lastCmd?.error || lastCmd?.errorName) ? (
                    <div className="mt-1 text-xs text-red-200 break-all">
                        {lastCmd?.errorName ? `${lastCmd.errorName}: ` : ""}{lastCmd?.error || ""}
                    </div>
                ) : null}
            </div>

            <details className="mt-4">
                <summary className="cursor-pointer text-sm text-gray-300">infos</summary>
                <pre className="mt-2 text-xs whitespace-pre-wrap break-words bg-gray-900/40 border border-gray-700 rounded p-3">
                    {JSON.stringify(data ?? {}, null, 2)}
                </pre>
            </details>
        </div>
    );
}
