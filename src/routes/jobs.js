const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { query, transaction } = require("../db");
const { apiError } = require("../utils/errors");
const { calculatePrice } = require("../utils/pricing");
const { requireAuth } = require("../middleware/auth");
const { notifyJobReady } = require("../ws");

const router = express.Router();

// Helper to format job row
function formatJob(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    kioskId: row.kiosk_id,
    copies: row.copies,
    colorMode: row.color_mode,
    pricing: {
      currency: row.currency,
      unitPagePrice: parseFloat(row.unit_page_price),
      subTotal: parseFloat(row.sub_total),
      gstPercent: parseFloat(row.gst_percent),
      gstAmount: parseFloat(row.gst_amount),
      total: parseFloat(row.total),
    },
    status: row.status,
    paymentId: row.payment_id,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    failureReason: row.failure_reason,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

// POST /jobs - create a print job and return pricing options
router.post("/", async (req, res, next) => {
  try {
    const { documentId, copies, colorMode } = req.body;

    if (!documentId) {
      throw apiError(400, "VALIDATION_ERROR", "documentId required");
    }

    const docResult = await query("SELECT * FROM documents WHERE id = $1", [documentId]);
    if (docResult.rows.length === 0) {
      throw apiError(404, "NOT_FOUND", "Document not found");
    }

    const doc = docResult.rows[0];
    const copiesToUse = copies && copies > 0 ? copies : 1;
    const color = colorMode === "color" ? "color" : "bw";

    const pricing = calculatePrice({
      pageCount: doc.page_count,
      copies: copiesToUse,
      colorMode: color,
    });

    const jobId = `job_${uuidv4()}`;

    const result = await query(
      `INSERT INTO jobs (id, document_id, kiosk_id, copies, color_mode, currency, unit_page_price, sub_total, gst_percent, gst_amount, total, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        jobId,
        documentId,
        doc.kiosk_id,
        copiesToUse,
        color,
        pricing.currency,
        pricing.unitPagePrice,
        pricing.subTotal,
        pricing.gstPercent,
        pricing.gstAmount,
        pricing.total,
        "pending_payment",
      ]
    );

    const job = formatJob(result.rows[0]);

    res.status(201).json({
      job,
      printOptions: {
        copies: copiesToUse,
        colorMode: color,
        bwPriceOption: calculatePrice({
          pageCount: doc.page_count,
          copies: copiesToUse,
          colorMode: "bw",
        }),
        colorPriceOption: calculatePrice({
          pageCount: doc.page_count,
          copies: copiesToUse,
          colorMode: "color",
        }),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /jobs/:jobId
router.get("/:jobId", async (req, res, next) => {
  try {
    const result = await query("SELECT * FROM jobs WHERE id = $1", [req.params.jobId]);

    if (result.rows.length === 0) {
      throw apiError(404, "NOT_FOUND", "Job not found");
    }

    res.json(formatJob(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// POST /jobs/:jobId/claim - kiosk claims a job (with idempotency)
router.post("/:jobId/claim", requireAuth, async (req, res, next) => {
  try {
    const { idempotencyKey } = req.body;
    const { jobId } = req.params;

    // Check idempotency key
    if (idempotencyKey) {
      const idempResult = await query(
        "SELECT response FROM idempotency_keys WHERE key = $1",
        [idempotencyKey]
      );
      if (idempResult.rows.length > 0) {
        return res.json(idempResult.rows[0].response);
      }
    }

    const result = await transaction(async (client) => {
      // Lock the job row for update
      const jobResult = await client.query(
        "SELECT * FROM jobs WHERE id = $1 FOR UPDATE",
        [jobId]
      );

      if (jobResult.rows.length === 0) {
        throw apiError(404, "NOT_FOUND", "Job not found");
      }

      const jobRow = jobResult.rows[0];

      if (jobRow.status !== "ready_to_print") {
        throw apiError(409, "JOB_NOT_READY", `Job status is ${jobRow.status}`);
      }

      if (jobRow.claimed_by && jobRow.claimed_by !== req.user.sub) {
        throw apiError(409, "JOB_CLAIMED", "Job already claimed by another kiosk");
      }

      // Claim the job
      const updatedJob = await client.query(
        `UPDATE jobs 
         SET claimed_by = $1, claimed_at = NOW(), status = 'printing', idempotency_key = $2
         WHERE id = $3
         RETURNING *`,
        [req.user.sub, idempotencyKey, jobId]
      );

      // Get document info
      const docResult = await client.query(
        "SELECT * FROM documents WHERE id = $1",
        [jobRow.document_id]
      );

      const doc = docResult.rows[0];
      const job = formatJob(updatedJob.rows[0]);

      const response = {
        job,
        document: {
          fileUrl: doc.file_url,
          fileName: doc.file_name,
          checksum: doc.checksum,
          pageCount: doc.page_count,
        },
      };

      // Store idempotency key
      if (idempotencyKey) {
        await client.query(
          "INSERT INTO idempotency_keys (key, response) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
          [idempotencyKey, JSON.stringify(response)]
        );
      }

      return response;
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /jobs/:jobId/complete - kiosk reports success or failure
router.post("/:jobId/complete", requireAuth, async (req, res, next) => {
  try {
    const { success, failureReason, consumables } = req.body;
    const { jobId } = req.params;

    const result = await transaction(async (client) => {
      const jobResult = await client.query(
        "SELECT * FROM jobs WHERE id = $1 FOR UPDATE",
        [jobId]
      );

      if (jobResult.rows.length === 0) {
        throw apiError(404, "NOT_FOUND", "Job not found");
      }

      const jobRow = jobResult.rows[0];

      if (jobRow.status !== "printing") {
        throw apiError(409, "INVALID_STATE", `Cannot complete job in ${jobRow.status}`);
      }

      const newStatus = success ? "completed" : "failed";

      const updatedJob = await client.query(
        `UPDATE jobs 
         SET status = $1, completed_at = NOW(), failure_reason = $2
         WHERE id = $3
         RETURNING *`,
        [newStatus, success ? null : failureReason, jobId]
      );

      // Update kiosk consumables if provided
      if (consumables && consumables.ink) {
        const updates = [];
        const values = [];
        let idx = 1;

        if (consumables.ink.cyan !== undefined) {
          updates.push(`ink_cyan = $${idx++}`);
          values.push(consumables.ink.cyan);
        }
        if (consumables.ink.magenta !== undefined) {
          updates.push(`ink_magenta = $${idx++}`);
          values.push(consumables.ink.magenta);
        }
        if (consumables.ink.yellow !== undefined) {
          updates.push(`ink_yellow = $${idx++}`);
          values.push(consumables.ink.yellow);
        }
        if (consumables.ink.black !== undefined) {
          updates.push(`ink_black = $${idx++}`);
          values.push(consumables.ink.black);
        }
        if (consumables.paperCount !== undefined) {
          updates.push(`paper_count = $${idx++}`);
          values.push(consumables.paperCount);
        }

        if (updates.length > 0) {
          values.push(jobRow.kiosk_id);
          await client.query(
            `UPDATE kiosks SET ${updates.join(", ")} WHERE id = $${idx}`,
            values
          );
        }
      }

      return formatJob(updatedJob.rows[0]);
    });

    res.json({ job: result });
  } catch (err) {
    next(err);
  }
});

// GET /jobs - list jobs for a kiosk
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const { kioskId, status } = req.query;

    let sql = "SELECT * FROM jobs WHERE 1=1";
    const params = [];
    let idx = 1;

    if (kioskId) {
      sql += ` AND kiosk_id = $${idx++}`;
      params.push(kioskId);
    }

    if (status) {
      sql += ` AND status = $${idx++}`;
      params.push(status);
    }

    sql += " ORDER BY created_at DESC";

    const result = await query(sql, params);

    res.json({ jobs: result.rows.map(formatJob) });
  } catch (err) {
    next(err);
  }
});

// Export notifyJobReady for use in payments route
router.notifyJobReady = notifyJobReady;

module.exports = router;
