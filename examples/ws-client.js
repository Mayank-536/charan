/**
 * WebSocket Test Client for Kiosk
 * 
 * This script demonstrates how a kiosk device connects to the server
 * via WebSocket to receive real-time job notifications.
 * 
 * Usage:
 *   node examples/ws-client.js <accessToken> <kioskId>
 */

const WebSocket = require("ws");

const WS_URL = process.env.WS_URL || "ws://localhost:8080/ws";
const token = process.argv[2];
const kioskId = process.argv[3];

if (!token || !kioskId) {
  console.error("Usage: node ws-client.js <accessToken> <kioskId>");
  console.error("Example: node ws-client.js eyJhbG... kiosk_abc123");
  process.exit(1);
}

console.log(`Connecting to ${WS_URL}...`);

const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log("Connected to server");

  // Step 1: Authenticate
  console.log("Sending auth...");
  ws.send(JSON.stringify({ type: "auth", token }));
});

ws.on("message", (data) => {
  const message = JSON.parse(data.toString());
  console.log("Received:", JSON.stringify(message, null, 2));

  switch (message.type) {
    case "auth_success":
      // Step 2: Subscribe to kiosk notifications
      console.log("Auth successful, subscribing to kiosk:", kioskId);
      ws.send(JSON.stringify({ type: "subscribe", kioskId }));
      break;

    case "subscribed":
      console.log(`Subscribed to ${message.kioskId}. Waiting for jobs...`);
      // Start heartbeat
      setInterval(() => {
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }, 25000);
      break;

    case "job_ready":
      console.log("\n🖨️  NEW PRINT JOB RECEIVED!");
      console.log(`   Job ID: ${message.jobId}`);
      console.log(`   Document: ${message.documentId}`);
      console.log(`   Copies: ${message.copies}`);
      console.log(`   Color: ${message.colorMode}`);
      console.log(`   Total: ₹${message.total}`);
      console.log(`   Time: ${message.timestamp}`);
      console.log("   → Claim this job using POST /jobs/{jobId}/claim\n");
      break;

    case "status_request":
      console.log("📊 Server requested status update. Send heartbeat via REST API.");
      break;

    case "job_cancelled":
      console.log(`❌ Job ${message.jobId} cancelled: ${message.reason}`);
      break;

    case "auth_error":
      console.error("Auth failed:", message.message);
      ws.close();
      break;

    case "error":
      console.error("Error:", message.message);
      break;
  }
});

ws.on("close", () => {
  console.log("Disconnected from server");
});

ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
});

// Handle Ctrl+C
process.on("SIGINT", () => {
  console.log("\nClosing connection...");
  ws.close();
  process.exit(0);
});
