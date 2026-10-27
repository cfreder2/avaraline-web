/*
    AvaraTCP_web.cpp — Emscripten/browser transport for Avara.

    Drop-in replacement for AvaraTCP.cpp (compiled instead of it when building for the
    web). It implements the same API, declared in AvaraTCP.h, over the page's WebRTC mesh
    (web/js/mesh.js) instead of a UDP socket: every datagram travels on an unreliable,
    unordered DataChannel straight to the other browser.

    Why WebRTC DataChannels and not a WebSocket?
      Avara already implements its own reliable+ordered protocol on top of UDP
      (CUDPComm / CUDPConnection / CProtoControl). What carries it must therefore be an
      unreliable datagram pipe, or we get reliability stacked on reliability plus TCP
      head-of-line blocking: fatal latency for a twitch game. A DataChannel opened with
      {ordered:false, maxRetransmits:0} behaves like UDP.

    Addressing: peer ids, not IP addresses.
      Each browser in a game has a random 32-bit peer id (mesh.js makes it up). That id
      IS its IP address as far as the engine knows, and every peer has the same port. So
      when the host sends its connection table, the addresses in it mean the same thing
      in every tab, and Avara's own full mesh (every client sends its frames straight to
      every other) works without change: a client that has never heard of peer X just
      sends to X, and the mesh opens a channel to X on the way. The ids are chosen so
      that they never look like a LAN address to CUDPComm::IsLAN.

    A host's address is written "peer:<hex id>" (what the lobby passes to join).

    The JS side of this bridge lives in web/library_avara_net.js.
*/

#ifdef __EMSCRIPTEN__   // the browser build's transport (Makefile.emscripten builds it instead of AvaraTCP.cpp)


#define MAIN_AVARA_TCP

#include "AvaraTCP.h"
#include "Memory.h"
#include "System.h"
#include "Debug.h"

#include <SDL2/SDL.h>   // SDL_SwapBE16/32, byte order helpers
#include <emscripten.h>
#include <cstdlib>
#include <cstring>
#include <sstream>

// Every peer's port. Addresses differ by peer id alone, and incoming datagrams carry
// this port too, so they match the connection they belong to.
static const uint16_t kWebPort = 19567;

// ---------------------------------------------------------------------------
// JS bridge, in web/library_avara_net.js. Nothing blocks: send is fire-and-forget and
// recv drains a queue that the DataChannels' onmessage handlers fill.
// ---------------------------------------------------------------------------
extern "C" {
    void avara_net_init(void);
    // Queue a datagram for the peer with this id.
    void avara_net_send(uint32_t peer, const uint8_t *data, int len);
    // Pop one received datagram into buf (<= maxlen). Returns its length, or -1 when the
    // queue is empty. *outPeer receives the sender's peer id.
    int  avara_net_recv(uint8_t *buf, int maxlen, uint32_t *outPeer);
}

typedef struct {
    ReadCompleteProc *callback;
    void *userData;
} UDPReadData;

static Boolean gAvaraTCPOpen = false;
static int gAvaraSocket = -1;
static UDPReadData gReadCallback = {nullptr, nullptr};
static PunchHandler gPunchHandler;

OSErr OpenAvaraTCP() {
    if (gAvaraTCPOpen) {
        return noErr;
    }
    SDL_Log("OpenAvaraTCP (web/WebRTC mesh transport)\n");
    avara_net_init();
    gAvaraTCPOpen = true;
    return noErr;
}

int CreateSocket(uint16_t &port) {
    // There is only ever one logical socket in Avara: the mesh. The port is the same for
    // every peer.
    port = kWebPort;
    gAvaraSocket = 1;
    return gAvaraSocket;
}

void DestroySocket(int sock) {
    if (sock == gAvaraSocket) {
        gAvaraSocket = -1;
    }
}

UDPpacket *CreatePacket(int bufferSize) {
    UDPpacket *packet = (UDPpacket *)malloc(sizeof(UDPpacket));
    packet->data = (uint8_t *)malloc(bufferSize);
    packet->len = 0;
    packet->data[0] = 0;
    return packet;
}

void FreePacket(UDPpacket *packet) {
    if (packet) {
        free(packet->data);
        free(packet);
    }
}

int ResolveHost(IPaddress *address, const char *host, uint16_t port) {
    address->port = SDL_SwapBE16(kWebPort);
    if (host == NULL) {
        address->host = 0;            // "any": used for hosting
        return noErr;
    }
    // "peer:<hex>" is the only kind of address a browser can reach: there is no DNS and
    // no UDP here.
    uint32_t id = 0;
    if (strncmp(host, "peer:", 5) == 0) {
        id = (uint32_t)strtoul(host + 5, NULL, 16);
    }
    if (id == 0) {
        SDL_Log("ResolveHost: '%s' is not a peer address\n", host);
        return -1;
    }
    address->host = id;
    return noErr;
}

// NAT hole punching is the browser's job (ICE, inside each RTCPeerConnection). No-ops.
void PunchSetup(const char *host, uint16_t port) {}
void RegisterPunchServer(IPaddress &localAddr) {}
void RequestPunch(IPaddress &addr) {}
void PunchHole(const IPaddress &addr, const int8_t connId) {}
void SetPunchMessageHandler(PunchHandler handler) { gPunchHandler = handler; }

void CheckSockets() {
    if (!gAvaraTCPOpen || gAvaraSocket == -1) {
        return;
    }
    // Drain everything the DataChannels delivered since the last call.
    static uint8_t buf[UDPSTREAMBUFFERSIZE];
    uint32_t peer = 0;
    int n;
    while ((n = avara_net_recv(buf, UDPSTREAMBUFFERSIZE, &peer)) >= 0) {
        if (n == 0 || !gReadCallback.callback) {
            continue;
        }
        UDPpacket *packet = CreatePacket(n);
        memcpy(packet->data, buf, n);
        packet->len = n;
        packet->address.host = peer;
        packet->address.port = SDL_SwapBE16(kWebPort);
        gReadCallback.callback(packet, gReadCallback.userData);
        FreePacket(packet);
        if (gAvaraSocket == -1) {
            break;   // the callback closed the connection
        }
    }
}

void UDPRead(int sock, ReadCompleteProc callback, void *userData) {
    if (sock != -1) {
        gReadCallback.callback = callback;
        gReadCallback.userData = userData;
    }
}

void UDPWrite(int sock, UDPpacket *packet, WriteCompleteProc callback, void *userData) {
    if (sock != -1) {
        if (packet->address.host != 0) {
            avara_net_send(packet->address.host, packet->data, packet->len);
        }
        if (callback) {
            callback(noErr, userData);
        }
    }
}

std::string FormatHostPort(uint32_t host, uint16_t port) {
    std::ostringstream os;
    os << "peer:" << std::hex << host;
    return os.str();
}

std::string FormatAddress(const IPaddress &addr) {
    return FormatHostPort(addr.host, addr.port);
}

#endif // __EMSCRIPTEN__
