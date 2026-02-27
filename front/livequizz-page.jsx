const { useEffect, useMemo, useRef, useState } = React;

const { startListener } = await loadModule("./livequizz.js");

const MAX_ITEMS_DEFAULT = 8;
const TTL_MS_DEFAULT = 8000;

export default function LiveQuizFeed({
  maxItems = MAX_ITEMS_DEFAULT,
  ttlMs = TTL_MS_DEFAULT,
}) {
  const [items, setItems] = useState([]);
  const timersRef = useRef(new Map());
  const startedRef = useRef(false);

  const styles = useMemo(
    () => ({
      root: {
        width: "100%",
        height: "100%",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        fontFamily: "system-ui, -apple-system, sans-serif",
      },
      list: {
        width: "100%",
        height: "100%",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        gap: 16,
        padding: "16px",
      },
      entry: {
        position: "relative",
        background: "linear-gradient(145deg, rgba(30, 30, 30, 0.95) 0%, rgba(15, 15, 15, 0.98) 100%)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderLeft: "4px solid #C8A24A",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.2)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        padding: "14px 16px",
        borderRadius: 12,
        flexShrink: 0,
        opacity: 0,
        transform: "translateY(20px) scale(0.95)",
        transition: "all 1000ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        willChange: "opacity, transform",
      },
      entryEntered: {
        opacity: 1,
        transform: "translateY(0) scale(1)",
      },
      entryExiting: {
        opacity: 0,
        transform: "translateY(-24px) scale(0.95)",
      },
      header: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 10,
      },
      username: {
        fontSize: 15,
        fontWeight: 700,
        color: "#E2C779", // Un or légèrement plus brillant pour le texte
        letterSpacing: "0.3px",
      },
      status: {
        fontSize: 11,
        padding: "4px 10px",
        borderRadius: 20,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.5px",
      },
      statusCorrect: {
        background: "rgba(34, 197, 94, 0.15)",
        color: "#4ade80",
        border: "1px solid rgba(74, 222, 128, 0.3)",
        boxShadow: "0 0 10px rgba(34, 197, 94, 0.1)",
      },
      statusIncorrect: {
        background: "rgba(239, 68, 68, 0.15)",
        color: "#f87171",
        border: "1px solid rgba(248, 113, 113, 0.3)",
        boxShadow: "0 0 10px rgba(239, 68, 68, 0.1)",
      },
      answer: {
        fontSize: 14,
        color: "rgba(255, 255, 255, 0.95)",
        marginBottom: 12,
        lineHeight: 1.4,
        fontWeight: 500,
      },
      meta: {
        fontSize: 11,
        color: "rgba(255, 255, 255, 0.4)",
        display: "flex",
        justifyContent: "space-between",
        borderTop: "1px solid rgba(255, 255, 255, 0.06)",
        paddingTop: 8,
        fontWeight: 600,
      },
    }),
    []
  );

  // Nettoyage timers
  useEffect(() => {
    return () => {
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    startListener({
      onMessage: (msg) => {
        try {
          if (msg?.action !== "quizz") return;
          window.addLiveQuiz?.(msg.data);
        } catch {}
      },
    }).catch((e) => {
      console.error("[livequizz] startListener failed", e);
    });
  }, []);

  // API simple: window.addLiveQuiz({username,isCorrect,timestamp?})
  useEffect(() => {
    window.addLiveQuiz = (data) => {
      const id =
        (globalThis.crypto?.randomUUID?.() ??
          `${Date.now()}-${Math.random().toString(16).slice(2)}`) + "";

      const tsDate = data?.timestamp ? new Date(data.timestamp) : new Date();
      const time = tsDate.toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      const item = {
        id,
        username: data?.username ?? "—",
        isCorrect: !!data?.isCorrect,
        time,
        state: "enter", // enter -> entered -> exit
      };

      setItems((prev) => {
        const next = [...prev, item];
        const overflow = next.length - maxItems;
        if (overflow > 0) return next.slice(overflow);
        return next;
      });

      // Enter on next frame
      requestAnimationFrame(() => {
        setItems((prev) =>
          prev.map((x) => (x.id === id ? { ...x, state: "entered" } : x))
        );
      });

      // Plan exit then remove
      const exitTimer = setTimeout(() => {
        setItems((prev) =>
          prev.map((x) => (x.id === id ? { ...x, state: "exit" } : x))
        );

        const removeTimer = setTimeout(() => {
          setItems((prev) => prev.filter((x) => x.id !== id));
          timersRef.current.delete(id);
        }, 400); // Ajusté pour correspondre à la nouvelle durée d'animation

        timersRef.current.set(`${id}:remove`, removeTimer);
      }, ttlMs);

      timersRef.current.set(id, exitTimer);
    };

    return () => {
      if (window.addLiveQuiz) delete window.addLiveQuiz;
    };
  }, [maxItems, ttlMs]);

  return (
    <div style={styles.root}>
      <div style={styles.list}>
        {items.map((it) => {
          const entryStyle = {
            ...styles.entry,
            ...(it.state === "entered" ? styles.entryEntered : null),
            ...(it.state === "exit" ? styles.entryExiting : null),
          };

          const statusStyle = {
            ...styles.status,
            ...(it.isCorrect ? styles.statusCorrect : styles.statusIncorrect),
          };

          return (
            <div key={it.id} style={entryStyle}>
              <div style={styles.header}>
                <span style={styles.username}>{it.username}</span>
                <span style={statusStyle}>
                  {it.isCorrect ? "✓ Correct" : "✗ Incorrect"}
                </span>
              </div>
              <div style={styles.answer}>
                {it.username} a répondu — {it.isCorrect ? "réponse correcte" : "réponse incorrecte"}
              </div>
              <div style={styles.meta}>
                <span>{it.time}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}