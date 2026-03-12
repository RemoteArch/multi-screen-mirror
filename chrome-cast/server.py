#!/usr/bin/env python3
import http.server
import ssl
import os

# Configuration
HOST = '0.0.0.0'
PORT = 8443

# Change to script directory
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Create HTTPS server
httpd = http.server.HTTPServer((HOST, PORT), http.server.SimpleHTTPRequestHandler)

# Setup SSL context
ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ssl_context.load_cert_chain(certfile='cert.pem', keyfile='key.pem')

# Wrap socket with SSL
httpd.socket = ssl_context.wrap_socket(httpd.socket, server_side=True)

print(f"🔒 HTTPS Server running at https://localhost:{PORT}/")
print(f"📁 Serving files from: {os.getcwd()}")
print(f"🌐 Access from network: https://<your-ip>:{PORT}/")
print("\nPress Ctrl+C to stop the server")

try:
    httpd.serve_forever()
except KeyboardInterrupt:
    print("\n\n✓ Server stopped")
    httpd.shutdown()
