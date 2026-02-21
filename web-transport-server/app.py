import asyncio
import itertools
import struct
from dataclasses import dataclass
from typing import Dict, Optional

from aioquic.asyncio import serve
from aioquic.quic.configuration import QuicConfiguration
from aioquic.asyncio.protocol import QuicConnectionProtocol

from aioquic.h3.connection import H3_ALPN
from aioquic.h3.events import HeadersReceived, DatagramReceived
from aioquic.h3.connection import H3Connection
from aioquic.quic.events import ProtocolNegotiated, QuicEvent

# Hub WebTransport (HTTP/3) compatible Chrome.
#
# - Pas de room
# - Pas de broadcast
# - ID unique par session WebTransport (CONNECT)
# - DATAGRAM framing binaire :
#   Client -> hub :   to_id:uint32be + len:uint32be + payload
#   Hub -> client :   from_id:uint32be + len:uint32be + payload

@dataclass
class ClientHandle:
    client_id: int
    protocol: "WebTransportHubProtocol"
    session_id: int

class HubState:

    def __init__(self) -> None:
        self._ids = itertools.count(1)
        self._clients: Dict[int, ClientHandle] = {}

    def allocate_id(self) -> int:
        return next(self._ids)

    def register(self, client_id: int, protocol: "WebTransportHubProtocol", session_id: int) -> None:
        self._clients[client_id] = ClientHandle(
            client_id=client_id,
            protocol=protocol,
            session_id=session_id,
        )

    def unregister(self, client_id: Optional[int]) -> None:
        if client_id is None:
            return
        self._clients.pop(client_id, None)

    def get(self, client_id: int) -> Optional[ClientHandle]:
        return self._clients.get(client_id)

HUB = HubState()

class WebTransportHubProtocol(QuicConnectionProtocol):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._http: Optional[H3Connection] = None
        self.client_id: Optional[int] = None
        self._session_id: Optional[int] = None

    def connection_lost(self, exc):
        HUB.unregister(self.client_id)
        return super().connection_lost(exc)

    def _ensure_client_id(self) -> int:
        if self.client_id is None:
            self.client_id = HUB.allocate_id()
        return self.client_id

    def _send_response(self, stream_id: int, status_code: int, end_stream: bool = False) -> None:
        assert self._http is not None
        headers = [(b":status", str(status_code).encode("ascii"))]
        if status_code == 200:
            headers.append((b"sec-webtransport-http3-draft", b"draft02"))
        self._http.send_headers(stream_id=stream_id, headers=headers, end_stream=end_stream)
        self.transmit()

    def _handshake_webtransport(self, stream_id: int, request_headers: Dict[bytes, bytes]) -> None:
        # stream_id of CONNECT is used as WebTransport session id in aioquic.
        path = request_headers.get(b":path")
        authority = request_headers.get(b":authority")
        if path is None or authority is None:
            self._send_response(stream_id, 400, end_stream=True)
            return

        if path != b"/hub":
            self._send_response(stream_id, 404, end_stream=True)
            return

        # Assign ID and register mapping to this session
        self._session_id = stream_id
        cid = self._ensure_client_id()
        HUB.register(cid, self, stream_id)
        self._send_response(stream_id, 200, end_stream=False)

        # Send assigned id as a datagram to the newly created session:
        # from_id=0 + len=4 + payload=cid(uint32be)
        try:
            payload = struct.pack("!II", 0, 4) + struct.pack("!I", cid)
            self._http.send_datagram(stream_id, payload)
            self.transmit()
        except Exception:
            pass

    def _forward_datagram(self, raw: bytes) -> None:
        # raw = to_id:uint32be + len:uint32be + payload
        if self.client_id is None:
            return
        if len(raw) < 8:
            return

        to_id, ln = struct.unpack("!II", raw[:8])
        payload = raw[8:]
        if ln != len(payload):
            return

        handle = HUB.get(to_id)
        if handle is None:
            return

        # forward = from_id:uint32be + len:uint32be + payload
        fwd = struct.pack("!II", self.client_id, ln) + payload
        try:
            assert handle.protocol._http is not None
            handle.protocol._http.send_datagram(handle.session_id, fwd)
            handle.protocol.transmit()
        except Exception:
            return

    def quic_event_received(self, event: QuicEvent) -> None:
        if isinstance(event, ProtocolNegotiated):
            # enable_webtransport is required for browser WebTransport.
            self._http = H3Connection(self._quic, enable_webtransport=True)

        if self._http is None:
            return

        for http_event in self._http.handle_event(event):
            if isinstance(http_event, HeadersReceived):
                headers = {k: v for (k, v) in http_event.headers}
                if (
                    headers.get(b":method") == b"CONNECT"
                    and headers.get(b":protocol") == b"webtransport"
                ):
                    self._handshake_webtransport(http_event.stream_id, headers)
                else:
                    self._send_response(http_event.stream_id, 400, end_stream=True)

            elif isinstance(http_event, DatagramReceived):
                # WebTransport datagrams are delivered to this protocol and belong
                # to the CONNECT stream id (session). aioquic provides the session
                # id to send_datagram(), but DatagramReceived only contains data.
                # We forward only if we have a session.
                if self._session_id is None:
                    continue
                self._forward_datagram(http_event.data)

async def main():
    configuration = QuicConfiguration(
        alpn_protocols=H3_ALPN,
        is_client=False,
        max_datagram_frame_size=65536,
    )

    configuration.load_cert_chain("cert.pem", "key.pem")

    server = await serve(
        host="0.0.0.0",
        port=4433,
        configuration=configuration,
        create_protocol=WebTransportHubProtocol,
    )

    print("WebTransport hub listening on https://0.0.0.0:4433/hub (UDP 4433)")
    try:
        await asyncio.Future()
    except Exception as e:
        print(f"Error: {e}")
    finally:
        server.close()
        await server.wait_closed()

if __name__ == "__main__":
    asyncio.run(main())