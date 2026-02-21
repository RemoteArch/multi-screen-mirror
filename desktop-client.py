import requests
import time
import mss
import socket
import json
import threading

def get_hostname():
    return socket.gethostname()

paused = False

hostname = get_hostname()

def stream_screen():
    global paused
    with mss.mss() as sct:
        while True:
            if paused:
                time.sleep(0.5)
                continue

            sct_img = sct.grab(sct.monitors[1])
            img_bytes = mss.tools.to_png(sct_img.rgb, sct_img.size)
            length = len(img_bytes)

            if length >= 16777216:  # 3 octets max
                print("[⚠️] Image trop grande pour 3 octets (max 16777215). Ignorée.")
                continue

            header = length.to_bytes(3, byteorder='big')
            yield header + img_bytes

            time.sleep(0.2)

def upload_loop(url):
    global paused
    while True:
        paused = True
        try:
            print(f"[📤] Démarrage de l'envoi des images à {url}/upload")
            requests.post(
                f"{url}/upload?id={hostname}",
                data=stream_screen(),
                headers={'Content-Type': 'application/octet-stream'}
            )
            print("[⚠️] Upload interrompu ou terminé.")
        except Exception as e:
            print(f"[ERREUR] Upload échoué : {e}")
            time.sleep(3)

def listen_signals(url):
    global paused
    while True:
        try:
            print("[📡] Connexion à /connect pour écouter les signaux...")
            response = requests.get(
                f"{url}/connect?id={hostname}",
                stream=True,
            )
            for data in response.iter_lines():
                if not data:
                    continue
                try:
                    signal = json.loads(data.decode())
                    print(f"[🔔] Signal reçu : {signal}")
                    if "pause" in signal:
                        print("[⏸️] Pause activée")
                        paused = True
                    if "resume" in signal:
                        print("[▶️] Reprise du stream")
                        paused = False
                except json.JSONDecodeError:
                    print("[⚠️] Réponse non JSON :", data)

        except Exception as e:
            print(f"[ERREUR] Connexion au signal échouée reprise dans 1 sec : {e}")
            time.sleep(1)

def main(url='http://localhost:4000'):
    threading.Thread(target=upload_loop , args=[url] , daemon=True).start()
    listen_signals(url)
    print("[✔] Agent arrêté proprement.")

if __name__ == '__main__':
    main()
