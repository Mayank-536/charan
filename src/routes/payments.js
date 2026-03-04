const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { query, transaction } = require("../db");
const { apiError } = require("../utils/errors");
const { notifyJobReady } = require("../ws");

const router = express.Router();

// POST /payments - generate a payment link for a job
router.post("/", async (req, res, next) => {
  try {
    const { jobId, provider } = req.body;

    if (!jobId) {
      throw apiError(400, "VALIDATION_ERROR", "jobId required");
    }

    const jobResult = await query("SELECT * FROM jobs WHERE id = $1", [jobId]);
    if (jobResult.rows.length === 0) {
      throw apiError(404, "NOT_FOUND", "Job not found");
    }

    const job = jobResult.rows[0];

    if (job.status !== "pending_payment") {
      throw apiError(409, "INVALID_STATE", "Job not awaiting payment");
    }

    const paymentId = `pay_${uuidv4()}`;
    const paymentLink = `https://pay.example.com/${paymentId}`;

    const result = await query(
      `INSERT INTO payments (id, job_id, amount, currency, provider, payment_link)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [paymentId, jobId, job.total, job.currency, provider || "razorpay_mock", paymentLink]
    );

    // Update job with payment ID
    await query("UPDATE jobs SET payment_id = $1 WHERE id = $2", [paymentId, jobId]);

    const payment = result.rows[0];

    res.status(201).json({
      paymentId: payment.id,
      paymentLink: payment.payment_link,
      amount: parseFloat(payment.amount),
      currency: payment.currency,
    });
  } catch (err) {
    next(err);
  }
});

// POST /payments/:paymentId/webhook - mock webhook from payment gateway
router.post("/:paymentId/webhook", async (req, res, next) => {
  try {
    const { paymentId } = req.params;
    const { status } = req.body;

    const result = await transaction(async (client) => {
      const payResult = await client.query(
        "SELECT * FROM payments WHERE id = $1 FOR UPDATE",
        [paymentId]
      );

      if (payResult.rows.length === 0) {
        throw apiError(404, "NOT_FOUND", "Payment not found");
      }

      const payment = payResult.rows[0];
      let paymentStatus;

      if (status === "success") {
        paymentStatus = "paid";

        await client.query(
          "UPDATE payments SET status = $1, paid_at = NOW() WHERE id = $2",
          [paymentStatus, paymentId]
        );

        // Update job status to ready_to_print
        const jobResult = await client.query(
          `UPDATE jobs SET status = 'ready_to_print' 
           WHERE id = $1 AND status = 'pending_payment'
           RETURNING *`,
          [payment.job_id]
        );

        // Notify kiosk via WebSocket if job was updated
        if (jobResult.rows.length > 0) {
          const job = jobResult.rows[0];
          // Schedule notification outside transaction
          setImmediate(() => {
            notifyJobReady(job.kiosk_id, job);
          });
        }
      } else {
        paymentStatus = "failed";
        await client.query(
          "UPDATE payments SET status = $1 WHERE id = $2",
          [paymentStatus, paymentId]
        );
      }

      return paymentStatus;
    });

    res.json({ received: true, paymentStatus: result });
  } catch (err) {
    next(err);
  }
});

// GET /payments/:paymentId
router.get("/:paymentId", async (req, res, next) => {
  try {
    const result = await query("SELECT * FROM payments WHERE id = $1", [req.params.paymentId]);

    if (result.rows.length === 0) {
      throw apiError(404, "NOT_FOUND", "Payment not found");
    }

    const row = result.rows[0];

    res.json({
      id: row.id,
      jobId: row.job_id,
      amount: parseFloat(row.amount),
      currency: row.currency,
      provider: row.provider,
      status: row.status,
      paymentLink: row.payment_link,
      paidAt: row.paid_at,
      createdAt: row.created_at,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
