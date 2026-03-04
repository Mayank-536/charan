const http = require("http");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { v4: uuidv4 } = require("uuid");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");
const path = require("path");

const { config } = require("./config");
const { errorHandler } = require("./utils/errors");
const { initializeDb } = require("./db");
const { createWebSocketServer, getConnectedKiosks } = require("./ws");

const authRoutes = require("./routes/auth");
const kioskRoutes = require("./routes/kiosks");
const documentRoutes = require("./routes/documents");
const jobRoutes = require("./routes/jobs");
const paymentRoutes = require("./routes/payments");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan("combined"));

// Request ID
app.use((req, res, next) => {
  req.id = uuidv4();
  res.setHeader("X-Request-Id", req.id);
  next();
});

// Swagger docs
const swaggerDoc = YAML.load(path.join(__dirname, "../openapi.yaml"));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDoc));

// Routes
app.use("/auth", authRoutes);
app.use("/kiosks", kioskRoutes);
app.use("/documents", documentRoutes);
app.use("/jobs", jobRoutes);
app.use("/payments", paymentRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    connectedKiosks: getConnectedKiosks(),
  });
});

// Error handler
app.use(errorHandler);

// Create HTTP server
const server = http.createServer(app);

// Initialize WebSocket server
createWebSocketServer(server);

// Start server
async function start() {
  try {
    // Initialize database
    await initializeDb();
    console.log("Database connected and initialized");

    // Start listening
    server.listen(config.port, () => {
      console.log(`Printing Press Server listening on http://localhost:${config.port}`);
      console.log(`OpenAPI docs at http://localhost:${config.port}/docs`);
      console.log(`WebSocket endpoint at ws://localhost:${config.port}/ws`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();

module.exports = { app, server };
