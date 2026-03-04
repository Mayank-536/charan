const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { query } = require("../db");
const { apiError } = require("../utils/errors");

const router = express.Router();

// POST /documents - upload document metadata (from chatbot)
router.post("/", async (req, res, next) => {
  try {
    const { kioskId, userPhone, fileUrl, fileName, pageCount, checksum } = req.body;

    if (!kioskId || !fileUrl || !pageCount) {
      throw apiError(400, "VALIDATION_ERROR", "kioskId, fileUrl, pageCount required");
    }

    // Check kiosk exists
    const kioskCheck = await query("SELECT id FROM kiosks WHERE id = $1", [kioskId]);
    if (kioskCheck.rows.length === 0) {
      throw apiError(404, "NOT_FOUND", "Kiosk not found");
    }

    const docId = `doc_${uuidv4()}`;

    const result = await query(
      `INSERT INTO documents (id, kiosk_id, user_phone, file_url, file_name, page_count, checksum)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [docId, kioskId, userPhone || null, fileUrl, fileName || "document.pdf", pageCount, checksum || null]
    );

    const row = result.rows[0];

    res.status(201).json({
      id: row.id,
      kioskId: row.kiosk_id,
      userPhone: row.user_phone,
      fileUrl: row.file_url,
      fileName: row.file_name,
      pageCount: row.page_count,
      checksum: row.checksum,
      createdAt: row.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// GET /documents/:docId
router.get("/:docId", async (req, res, next) => {
  try {
    const result = await query("SELECT * FROM documents WHERE id = $1", [req.params.docId]);

    if (result.rows.length === 0) {
      throw apiError(404, "NOT_FOUND", "Document not found");
    }

    const row = result.rows[0];

    res.json({
      id: row.id,
      kioskId: row.kiosk_id,
      userPhone: row.user_phone,
      fileUrl: row.file_url,
      fileName: row.file_name,
      pageCount: row.page_count,
      checksum: row.checksum,
      createdAt: row.created_at,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
