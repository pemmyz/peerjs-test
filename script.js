// ==========================================
// PeerJS P2P Chat
// Automatic reconnection + Heartbeat + Dynamic QR Connect
// ==========================================

// DOM elements
const status = document.getElementById("status");
const myId = document.getElementById("my-id");
const remoteId = document.getElementById("remote-id");
const messages = document.getElementById("messages");
const messageInput = document.getElementById("message");

// QR Modal DOM elements
const qrModal = document.getElementById("qr-modal");
const showQrBtn = document.getElementById("show-qr");
const closeQrBtn = document.getElementById("close-qr");
const qrcodeElement = document.getElementById("qrcode");
const qrUrlText = document.getElementById("qr-url-text");

// Configuration
const HEARTBEAT_INTERVAL = 5000;
const HEARTBEAT_TIMEOUT = 30000;
const RECONNECT_BASE_DELAY = 2000;
const RECONNECT_MAX_DELAY = 15000;

// ICE Servers (STUN + TURN)
// IMPORTANT: Passing `config.iceServers` to PeerJS replaces its defaults.
// Keep STUN servers here, and uncomment + fill in your TURN server(s)
// (e.g. from Metered.ca or Cloudflare Realtime TURN) for internet connections.
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }

    // Example TURN entries (uncomment and replace with your credentials):
    // ,{
    //     urls: "turn:your-turn-host.example.com:80",
    //     username: "YOUR_USERNAME",
    //     credential: "YOUR_CREDENTIAL"
    // },
    // {
    //     urls: "turns:your-turn-host.example.com:443?transport=tcp",
    //     username: "YOUR_USERNAME",
    //     credential: "YOUR_CREDENTIAL"
    // }
];

// QR Code instance
let qrCodeInstance = null;

// Read query params for auto-connect: ?join=<PEER_ID>
const urlParams = new URLSearchParams(window.location.search);
const autoJoinId = urlParams.get("join");

// PeerJS state
let peer;
let connection = null;
let remotePeerId = null;
let hasConnectedOnce = false;

// Reconnection state
let reconnectAttempts = 0;
let reconnectTimer = null;
let signalingRetryTimer = null;
let isReconnectLeader = false;
let destroyed = false;

// Heartbeat state
let heartbeatTimer = null;
let lastPong = Date.now();

// ==========================================
// UI & URL HELPERS
// ==========================================

function setStatus(text) {
    status.textContent = text;
}

function addMessage(sender, message) {
    const item = document.createElement("p");
    item.textContent = `${sender}: ${message}`;
    messages.appendChild(item);

    messages.scrollTop = messages.scrollHeight;
}

// Dynamically resolves to current origin + path (e.g., GitHub Pages subpath or local IP)
function getBaseUrl() {
    return `${window.location.origin}${window.location.pathname}`;
}

// ==========================================
// INITIALIZE PEERJS
// ==========================================

function initializePeer() {
    destroyed = false;

    const hasTurnServer = ICE_SERVERS.some(server => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some(u => typeof u === "string" && (u.startsWith("turn:") || u.startsWith("turns:")));
    });

    if (!hasTurnServer) {
        console.warn("No TURN server configured in ICE_SERVERS. Connections across different networks/mobile data may hang at ICE negotiation.");
    }

    setStatus("Connecting to PeerJS Cloud...");

    peer = new Peer({
        debug: 3, // Logs ICE candidates, SDP offers/answers, and PeerJS errors
        config: {
            iceServers: ICE_SERVERS
        }
    });

    peer.on("open", id => {
        console.log("PeerJS connected:", id);

        myId.textContent = id;
        setStatus("Connected to PeerJS Cloud");

        // Update reconnect leadership
        if (remotePeerId) {
            updateReconnectLeader();
        }

        // AUTO-CONNECT: If page was opened from QR scan or with ?join=...
        if (autoJoinId && autoJoinId !== id && !connection) {
            console.log("Auto-connecting to scanned peer:", autoJoinId);
            remoteId.value = autoJoinId;
            connectToPlayer(autoJoinId);
            return;
        }

        // If signaling recovered but P2P is down
        if (!connection && remotePeerId) {
            scheduleReconnect();
        }
    });

    // Incoming connection
    peer.on("connection", conn => {
        console.log("Incoming connection:", conn.peer);

        if (connection && connection.open) {
            if (connection.peer === conn.peer) {
                conn.close();
                return;
            }
            console.log("Already connected to another player");
            conn.close();
            return;
        }

        remotePeerId = conn.peer;
        setupConnection(conn);
    });

    peer.on("disconnected", () => {
        console.warn("PeerJS Cloud disconnected");
        setStatus("Lost PeerJS Cloud connection...");
        retrySignaling();
    });

    peer.on("error", error => {
        console.error("PeerJS error:", error);
        setStatus("PeerJS error: " + error.type);

        if (error.type === "peer-unavailable") {
            if (connection && !connection.open) {
                connection = null;
            }
            scheduleReconnect();
        }

        if (error.type === "network") {
            retrySignaling();
        }
    });

    peer.on("close", () => {
        console.log("PeerJS instance closed");
    });
}

// ==========================================
// PEERJS CLOUD RECONNECTION
// ==========================================

function retrySignaling() {
    if (signalingRetryTimer || destroyed) return;

    signalingRetryTimer = setTimeout(() => {
        signalingRetryTimer = null;

        if (destroyed || !peer || peer.destroyed) return;

        if (peer.disconnected) {
            console.log("Reconnecting to PeerJS Cloud...");
            try {
                peer.reconnect();
            } catch (error) {
                console.error("Signaling reconnect failed:", error);
            }
        }
    }, 3000);
}

window.addEventListener("online", () => {
    console.log("Internet connection restored");

    if (peer && peer.disconnected) {
        retrySignaling();
    }

    if (!connection && remotePeerId) {
        scheduleReconnect();
    }
});

window.addEventListener("offline", () => {
    console.warn("Internet connection lost");
    setStatus("Internet disconnected...");
});

// ==========================================
// RECONNECT LEADER
// ==========================================

function updateReconnectLeader() {
    if (!peer || !peer.id || !remotePeerId) return;

    // The peer with the lexicographically smaller ID leads the reconnect
    isReconnectLeader = peer.id < remotePeerId;

    console.log(
        "Reconnect leader:",
        isReconnectLeader ? "YES" : "NO"
    );
}

// ==========================================
// CONNECT TO PLAYER
// ==========================================

function connectToPlayer(id) {
    id = id.trim();

    if (!id) return;

    if (!peer || !peer.id) {
        setStatus("PeerJS is not ready yet");
        return;
    }

    if (id === peer.id) {
        setStatus("You cannot connect to yourself!");
        return;
    }

    if (connection && connection.open) {
        setStatus("Already connected!");
        return;
    }

    remotePeerId = id;
    reconnectAttempts = 0;

    setStatus("Connecting to player...");

    const conn = peer.connect(id, {
        reliable: true
    });

    setupConnection(conn);
}

// ==========================================
// CONNECTION MANAGEMENT
// ==========================================

function setupConnection(conn) {
    if (connection && connection.open) {
        conn.close();
        return;
    }

    // Close any stale half-open previous connection before replacing it
    if (connection && connection !== conn && !connection.open) {
        try {
            connection.close();
        } catch (e) {
            console.warn("Failed closing stale connection:", e);
        }
    }

    connection = conn;
    remotePeerId = conn.peer;

    updateReconnectLeader();

    console.log("Setting up connection:", conn.peer);

    conn.on("iceStateChanged", state => {
        console.log("ICE state:", state);

        if (!conn.open) {
            setStatus(`Connecting (ICE: ${state})...`);
        }

        if (state === "failed" && !conn.open) {
            console.warn("ICE negotiation failed before DataConnection opened");
            if (connection === conn) {
                connection = null;
            }
            try {
                conn.close();
            } catch (e) {
                // ignore
            }
            setStatus("P2P connection failed (NAT/firewall). Retrying...");
            scheduleReconnect();
        }
    });

    conn.on("open", () => {
        console.log("P2P connection established");

        hasConnectedOnce = true;
        reconnectAttempts = 0;
        lastPong = Date.now();

        setStatus("P2P connection established!");
        addMessage("SYSTEM", "Player connected!");

        // Close the QR modal automatically once connected
        closeQrModal();

        startHeartbeat();

        conn.send({
            type: "resume",
            peerId: peer.id,
            timestamp: Date.now()
        });
    });

    conn.on("data", data => {
        if (!data || typeof data !== "object") return;

        // Heartbeat
        if (data.type === "ping") {
            conn.send({ type: "pong" });
            return;
        }

        if (data.type === "pong") {
            lastPong = Date.now();
            return;
        }

        // Session resume
        if (data.type === "resume") {
            console.log("Remote player resumed session");
            addMessage("SYSTEM", "Session synchronized");
            return;
        }

        // Chat message
        if (data.type === "chat") {
            addMessage("PLAYER", data.message);
            return;
        }
    });

    conn.on("close", () => {
        console.warn("P2P connection closed");

        stopHeartbeat();

        if (connection === conn) {
            connection = null;
        }

        setStatus("Connection lost. Reconnecting...");
        addMessage("SYSTEM", "Player disconnected");

        scheduleReconnect();
    });

    conn.on("error", error => {
        console.error("DataConnection error:", error);

        if (connection === conn && !conn.open) {
            connection = null;
        }

        setStatus("Connection error");
        scheduleReconnect();
    });
}

// ==========================================
// HEARTBEAT
// ==========================================

function startHeartbeat() {
    stopHeartbeat();

    lastPong = Date.now();

    heartbeatTimer = setInterval(() => {
        if (!connection || !connection.open) return;

        const elapsed = Date.now() - lastPong;

        if (elapsed > HEARTBEAT_TIMEOUT) {
            console.warn("Heartbeat timeout");
            setStatus("Player not responding...");
            connection.close();
            return;
        }

        connection.send({
            type: "ping",
            timestamp: Date.now()
        });

    }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

// ==========================================
// AUTOMATIC P2P RECONNECTION
// ==========================================

function scheduleReconnect() {
    if (destroyed) return;
    if (!remotePeerId) return;

    // Only enforce reconnect leadership after both peers have connected once
    // and know each other's Peer ID.
    if (hasConnectedOnce && !isReconnectLeader) return;
    if (reconnectTimer) return;

    if (connection && connection.open) return;

    const delay = Math.min(
        RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts),
        RECONNECT_MAX_DELAY
    );

    reconnectAttempts++;

    console.log(`Reconnect attempt in ${delay}ms`);

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;

        if (destroyed) return;
        if (connection && connection.open) return;

        if (!peer || peer.destroyed || peer.disconnected || !peer.id) {
            retrySignaling();
            scheduleReconnect();
            return;
        }

        console.log("Attempting P2P reconnection...");
        setStatus("Reconnecting to player...");

        const conn = peer.connect(remotePeerId, {
            reliable: true
        });

        setupConnection(conn);

    }, delay);
}

// ==========================================
// QR CODE MANAGEMENT
// ==========================================

function openQrModal() {
    if (!peer || !peer.id) {
        setStatus("Peer ID not ready yet. Please wait...");
        return;
    }

    const baseUrl = getBaseUrl();
    const joinUrl = `${baseUrl}?join=${encodeURIComponent(peer.id)}`;

    qrUrlText.textContent = joinUrl;

    // Warn if opened on localhost (external devices can't reach 'localhost')
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
        qrUrlText.innerHTML = `${joinUrl}<br><br><span style="color: #ff9800; font-weight: bold;">⚠️ Warning: You are visiting via 'localhost'. Other devices cannot resolve this address. Use your local Wi-Fi IP (e.g., http://192.168.1.81:8001/) or your GitHub Pages URL instead.</span>`;
    }

    // Reset previous QR code
    qrcodeElement.innerHTML = "";

    qrCodeInstance = new QRCode(qrcodeElement, {
        text: joinUrl,
        width: 220,
        height: 220,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
    });

    qrModal.classList.remove("hidden");
}

function closeQrModal() {
    qrModal.classList.add("hidden");
}

showQrBtn.onclick = openQrModal;
closeQrBtn.onclick = closeQrModal;

// Close modal if background overlay is clicked
qrModal.addEventListener("click", event => {
    if (event.target === qrModal) {
        closeQrModal();
    }
});

// ==========================================
// CHAT
// ==========================================

function sendMessage() {
    const message = messageInput.value.trim();

    if (!message) return;

    if (!connection || !connection.open) {
        setStatus("No active player connection");
        return;
    }

    connection.send({
        type: "chat",
        message: message
    });

    addMessage("YOU", message);
    messageInput.value = "";
}

document.getElementById("send").onclick = sendMessage;

messageInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        sendMessage();
    }
});

// ==========================================
// CONNECT BUTTON
// ==========================================

document.getElementById("connect").onclick = () => {
    connectToPlayer(remoteId.value);
};

// ==========================================
// COPY PEER ID
// ==========================================

document.getElementById("copy-id").onclick = async () => {
    if (!peer || !peer.id) return;

    try {
        await navigator.clipboard.writeText(peer.id);
        setStatus("Peer ID copied!");
    } catch (error) {
        console.error("Clipboard error:", error);
        setStatus("Could not copy Peer ID");
    }
};

// ==========================================
// PAGE CLEANUP
// ==========================================

window.addEventListener("beforeunload", () => {
    destroyed = true;

    stopHeartbeat();

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }

    if (signalingRetryTimer) {
        clearTimeout(signalingRetryTimer);
    }

    if (peer && !peer.destroyed) {
        peer.destroy();
    }
});

// ==========================================
// START
// ==========================================

initializePeer();
