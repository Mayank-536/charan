const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { query } = require("../db");
const { apiError } = require("../utils/errors");
const { requireAuth } = require("../middleware/auth");
const { isKioskConnected, notifyStatusRequest } = require("../ws");

const router = express.Router();

// Helper to format kiosk row
function formatKiosk(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    location: row.location,
    printerModel: row.printer_model,
    status: row.status,
    ink: {
      cyan: row.ink_cyan,
      magenta: row.ink_magenta,
      yellow: row.ink_yellow,
      black: row.ink_black,
    },
    paperCount: row.paper_count,
    lastHeartbeat: row.last_heartbeat,
    createdAt: row.created_at,
  };
}

// POST /kiosks - register a new kiosk/printer
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { name, location, printerModel } = req.body;
    if (!name) {
      throw apiError(400, "VALIDATION_ERROR", "name is required");
    }

    const kioskId = `kiosk_${uuidv4()}`;

    const result = await query(
      `INSERT INTO kiosks (id, owner_id, name, location, printer_model)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [kioskId, req.user.sub, name, location || null, printerModel || null]
    );

    res.status(201).json(formatKiosk(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// GET /kiosks - list kiosks for authenticated user
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const result = await query(
      "SELECT * FROM kiosks WHERE owner_id = $1 ORDER BY created_at DESC",
      [req.user.sub]
    );

    const kiosks = result.rows.map((row) => {
      const kiosk = formatKiosk(row);
      kiosk.wsConnected = isKioskConnected(kiosk.id);
      return kiosk;
    });

    res.json({ kiosks });
  } catch (err) {
    next(err);
  }
});

// GET /kiosks/:kioskId - single kiosk details
router.get("/:kioskId", requireAuth, async (req, res, next) => {
  try {
    const result = await query("SELECT * FROM kiosks WHERE id = $1", [req.params.kioskId]);

    if (result.rows.length === 0) {
      throw apiError(404, "NOT_FOUND", "Kiosk not found");
    }

    const kiosk = formatKiosk(result.rows[0]);
    kiosk.wsConnected = isKioskConnected(kiosk.id);

    res.json(kiosk);
  } catch (err) {
    next(err);
  }
});

// POST /kiosks/:kioskId/heartbeat - kiosk sends its status
router.post("/:kioskId/heartbeat", requireAuth, async (req, res, next) => {
  try {
    const { kioskId } = req.params;
    const { ink, paperCount, status } = req.body;

    const existing = await query("SELECT id FROM kiosks WHERE id = $1", [kioskId]);
    if (existing.rows.length === 0) {
      throw apiError(404, "NOT_FOUND", "Kiosk not found");
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (ink) {
      if (ink.cyan !== undefined) {
        updates.push(`ink_cyan = $${paramIndex++}`);
        values.push(ink.cyan);
      }
      if (ink.magenta !== undefined) {
        updates.push(`ink_magenta = $${paramIndex++}`);
        values.push(ink.magenta);
      }
      if (ink.yellow !== undefined) {
        updates.push(`ink_yellow = $${paramIndex++}`);
        values.push(ink.yellow);
      }
      if (ink.black !== undefined) {
        updates.push(`ink_black = $${paramIndex++}`);
        values.push(ink.black);
      }
    }

    if (typeof paperCount === "number") {
      updates.push(`paper_count = $${paramIndex++}`);
      values.push(paperCount);
    }

    if (status) {
      updates.push(`status = $${paramIndex++}`);
      values.push(status);
    }

    updates.push(`last_heartbeat = $${paramIndex++}`);
    values.push(new Date());

    values.push(kioskId);

    await query(
      `UPDATE kiosks SET ${updates.join(", ")} WHERE id = $${paramIndex}`,
      values
    );

    res.json({ ack: true, serverTime: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// GET /kiosks/:kioskId/status - lightweight public status check
router.get("/:kioskId/status", async (req, res, next) => {
  try {
    const result = await query("SELECT * FROM kiosks WHERE id = $1", [req.params.kioskId]);

    if (result.rows.length === 0) {
      throw apiError(404, "NOT_FOUND", "Kiosk not found");
    }

    const row = result.rows[0];
    const now = Date.now();
    const heartbeatAge = row.last_heartbeat
      ? now - new Date(row.last_heartbeat).getTime()
      : Infinity;

    // Consider offline if no heartbeat in 60 seconds
    const effectiveStatus = heartbeatAge < 60000 ? row.status : "offline";
    const wsConnected = isKioskConnected(row.id);

    res.json({
      kioskId: row.id,
      status: effectiveStatus,
      wsConnected,
      ink: {
        cyan: row.ink_cyan,
        magenta: row.ink_magenta,
        yellow: row.ink_yellow,
        black: row.ink_black,
      },
      paperCount: row.paper_count,
      lastHeartbeat: row.last_heartbeat,
    });
  } catch (err) {
    next(err);
  }
});

// POST /kiosks/:kioskId/ping - request status update from kiosk via WebSocket
router.post("/:kioskId/ping", requireAuth, async (req, res, next) => {
  try {
    const { kioskId } = req.params;

    const existing = await query("SELECT id FROM kiosks WHERE id = $1", [kioskId]);
    if (existing.rows.length === 0) {
      throw apiError(404, "NOT_FOUND", "Kiosk not found");
    }

    const sent = notifyStatusRequest(kioskId);

    res.json({
      sent,
      message: sent ? "Status request sent to kiosk" : "Kiosk not connected via WebSocket",
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
