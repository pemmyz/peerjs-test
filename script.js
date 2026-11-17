
const status = document.getElementById("status");
const myId = document.getElementById("my-id");
const remoteId = document.getElementById("remote-id");
const messages = document.getElementById("messages");
const messageInput = document.getElementById("message");

let peer;
let connection = null;

// Create PeerJS connection
peer = new Peer();

function setStatus(text) {
    status.textContent = text;
}

function addMessage(sender, message) {
    const item = document.createElement("p");
    item.textContent = `${sender}: ${message}`;
    messages.appendChild(item);
}

// PeerJS Cloud connection established
peer.on("open", id => {
    myId.textContent = id;
    setStatus("Connected to PeerJS Cloud");
});

// Receive incoming connection
peer.on("connection", conn => {
    setupConnection(conn);
});

// Connect to another player
document.getElementById("connect").onclick = () => {
    const id = remoteId.value.trim();

    if (!id) return;

    if (id === peer.id) {
        setStatus("You cannot connect to yourself!");
        return;
    }

    setStatus("Connecting to player...");

    const conn = peer.connect(id, {
        reliable: true
    });

    setupConnection(conn);
};

// Setup data connection
function setupConnection(conn) {
    if (connection && connection.open) {
        conn.close();
        return;
    }

    connection = conn;

    conn.on("open", () => {
        setStatus("P2P connection established!");
        addMessage("SYSTEM", "Player connected!");
    });

    conn.on("data", data => {
        if (data && data.type === "chat") {
            addMessage("PLAYER", data.message);
        }
    });

    conn.on("close", () => {
        setStatus("Connection closed");
        connection = null;
        addMessage("SYSTEM", "Player disconnected");
    });

    conn.on("error", error => {
        console.error(error);
        setStatus("Connection error");
    });
}

// Send message
function sendMessage() {
    const message = messageInput.value.trim();

    if (!message || !connection || !connection.open) {
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

// Copy own Peer ID
document.getElementById("copy-id").onclick = async () => {
    if (peer.id) {
        await navigator.clipboard.writeText(peer.id);
        setStatus("Peer ID copied!");
    }
};

// Error handling
peer.on("error", error => {
    console.error("PeerJS error:", error);
    setStatus("PeerJS error: " + error.type);
});

