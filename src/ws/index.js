const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const { config } = require("../config");

// Map of kioskId -> Set of WebSocket connections
const kioskConnections = new Map();

// Map of WebSocket -> kioskId (for cleanup)
const wsToKiosk = new Map();

let wss = null;

function createWebSocketServer(server) {
  wss = new WebSocket.Server({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    console.log("New WebSocket connection");

    ws.isAlive = true;
    ws.kioskId = null;

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());
        handleMessage(ws, data);
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      }
    });

    ws.on("close", () => {
      cleanupConnection(ws);
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
      cleanupConnection(ws);
    });
  });

  // Heartbeat interval to detect dead connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        cleanupConnection(ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  console.log("WebSocket server started on /ws");
  return wss;
}

function handleMessage(ws, data) {
  switch (data.type) {
    case "auth":
      handleAuth(ws, data);
      break;

    case "subscribe":
      handleSubscribe(ws, data);
      break;

    case "heartbeat":
      handleHeartbeat(ws, data);
      break;

    default:
      ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${data.type}` }));
  }
}

function handleAuth(ws, data) {
  const { token } = data;

  if (!token) {
    ws.send(JSON.stringify({ type: "auth_error", message: "Token required" }));
    return;
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    ws.userId = payload.sub;
    ws.authenticated = true;
    ws.send(JSON.stringify({ type: "auth_success", userId: payload.sub }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "auth_error", message: "Invalid token" }));
  }
}

function handleSubscribe(ws, data) {
  if (!ws.authenticated) {
    ws.send(JSON.stringify({ type: "error", message: "Authenticate first" }));
    return;
  }

  const { kioskId } = data;
  if (!kioskId) {
    ws.send(JSON.stringify({ type: "error", message: "kioskId required" }));
    return;
  }

  // Remove from previous kiosk if any
  cleanupConnection(ws);

  // Add to new kiosk
  ws.kioskId = kioskId;
  wsToKiosk.set(ws, kioskId);

  if (!kioskConnections.has(kioskId)) {
    kioskConnections.set(kioskId, new Set());
  }
  kioskConnections.get(kioskId).add(ws);

  console.log(`Kiosk ${kioskId} subscribed`);
  ws.send(JSON.stringify({ type: "subscribed", kioskId }));
}

function handleHeartbeat(ws, data) {
  ws.send(JSON.stringify({ type: "heartbeat_ack", serverTime: new Date().toISOString() }));
}

function cleanupConnection(ws) {
  const kioskId = wsToKiosk.get(ws);
  if (kioskId) {
    const connections = kioskConnections.get(kioskId);
    if (connections) {
      connections.delete(ws);
      if (connections.size === 0) {
        kioskConnections.delete(kioskId);
      }
    }
    wsToKiosk.delete(ws);
  }
}

// Notify a specific kiosk about an event
function notifyKiosk(kioskId, event) {
  const connections = kioskConnections.get(kioskId);
  if (!connections || connections.size === 0) {
    console.log(`Kiosk ${kioskId} not connected, cannot notify`);
    return false;
  }

  const message = JSON.stringify(event);
  let sent = 0;

  connections.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      sent++;
    }
  });

  console.log(`Notified ${sent} connection(s) for kiosk ${kioskId}: ${event.type}`);
  return sent > 0;
}

// Helper functions for specific notifications
function notifyJobReady(kioskId, job) {
  return notifyKiosk(kioskId, {
    type: "job_ready",
    jobId: job.id,
    documentId: job.document_id,
    copies: job.copies,
    colorMode: job.color_mode,
    total: job.total,
    timestamp: new Date().toISOString(),
  });
}

function notifyJobCancelled(kioskId, jobId, reason) {
  return notifyKiosk(kioskId, {
    type: "job_cancelled",
    jobId,
    reason,
    timestamp: new Date().toISOString(),
  });
}

function notifyStatusRequest(kioskId) {
  return notifyKiosk(kioskId, {
    type: "status_request",
    timestamp: new Date().toISOString(),
  });
}

function isKioskConnected(kioskId) {
  const connections = kioskConnections.get(kioskId);
  if (!connections || connections.size === 0) return false;

  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

function getConnectedKiosks() {
  const connected = [];
  for (const [kioskId, connections] of kioskConnections) {
    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN) {
        connected.push(kioskId);
        break;
      }
    }
  }
  return connected;
}

module.exports = {
  createWebSocketServer,
  notifyKiosk,
  notifyJobReady,
  notifyJobCancelled,
  notifyStatusRequest,
  isKioskConnected,
  getConnectedKiosks,
};
