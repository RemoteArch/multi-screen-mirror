import time
from flask import Flask, request, Response, stream_with_context
import queue
import json
from werkzeug.wsgi import LimitedStream
import os
app = Flask(__name__)

sessions = {}  # client_id => {"signal": queue.Queue()}
datas = {}     # client_id => queue.Queue() pour les images

rootpath = os.path.dirname(__file__)

@app.route('/upload', methods=['POST'])
def upload():
    client_id = request.args.get('id')
    if not client_id:
        return "Missing 'id' parameter", 400

    if client_id not in datas:
        datas[client_id] = queue.Queue()

    stream: LimitedStream = request.environ['wsgi.input']
    while True:
        len_bytes = stream.read(3)
        if not len_bytes or len(len_bytes) < 3:
            break

        length = int.from_bytes(len_bytes, byteorder='big')
        chunk = stream.read(length)
        if not chunk or len(chunk) < length:
            break

        datas[client_id].put(chunk)
        print(f"[✓] Image reçue de {client_id} : {length} octets")

    return "Upload terminé", 200

@app.route('/connect')
def connect():
    client_id = request.args.get('id')
    if not client_id:
        return "Missing 'id' parameter", 400

    if client_id not in sessions:
        sessions[client_id] = {"signal": queue.Queue()}

    def handle_stream():
        try:
            while True:
                signal = sessions[client_id]["signal"].get()
                yield (json.dumps([signal]) + "\n").encode()
        except Exception as e:
            print(f"[ERREUR] /connect stream échoué pour {client_id} : {str(e)}")

    return Response(stream_with_context(handle_stream()), mimetype='text/plain')

@app.route("/settings")
def settings():
    action = request.args.get("action")
    match action:
        case "devices-list":
            def send_devices():
                while True:
                    data = json.dumps(list(sessions.keys()))
                    yield f"data: {data}\n\n"
                    time.sleep(5)

            return Response(stream_with_context(send_devices()), mimetype='text/event-stream')
            # return json.dumps(list(sessions.keys()))
        case "send-signal":
            client_id = request.args.get("id")
            signal = request.args.get("data")
            if client_id in sessions:
                sessions[client_id]["signal"].put(signal)
                return f"Signal '{signal}' envoyé à {client_id}"
            else:
                return "Client non trouvé", 404
        case _:
            return "No valid action defined", 400

@app.route('/stream')
def stream():
    client_id = request.args.get("id")
    if client_id not in datas:
        return "No stream for this ID", 404

    def generate():
        while True:
            try:
                data = datas[client_id].get(timeout=5)
                yield (b'--frame\r\n'
                       b'Content-Type: image/png\r\n\r\n' + data + b'\r\n')
            except queue.Empty:
                continue

    return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/')
def index():
    return open(os.path.join(rootpath , 'index.html') , 'rb').read()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=4000)
