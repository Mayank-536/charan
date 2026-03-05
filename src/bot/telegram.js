const TelegramBot = require("node-telegram-bot-api");
const { v4: uuidv4 } = require("uuid");
const { query, transaction } = require("../db");
const { calculatePrice } = require("../utils/pricing");
const { notifyJobReady } = require("../ws");

// In-memory session store: chatId -> session state
const sessions = new Map();

let bot = null;

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { step: null, data: {} });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.set(chatId, { step: null, data: {} });
}

function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
    return null;
  }

  bot = new TelegramBot(token, { polling: true });
  console.log("Telegram bot started (polling)");

  // ────── COMMANDS ──────

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    resetSession(chatId);
    bot.sendMessage(
      chatId,
      `🖨️ *Welcome to PrintPress Bot!*\n\nI can help you print documents at any nearby kiosk.\n\n` +
        `*Commands:*\n` +
        `/kiosks — Browse available kiosks\n` +
        `/print — Start a new print job\n` +
        `/status — Check your job status\n` +
        `/myjobs — View your recent jobs\n` +
        `/help — Show help\n` +
        `/cancel — Cancel current action`,
      { parse_mode: "Markdown" }
    );
  });

  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      `📋 *How to print:*\n\n` +
        `1️⃣ Use /kiosks to find a nearby kiosk\n` +
        `2️⃣ Use /print to start a print job\n` +
        `3️⃣ Select a kiosk\n` +
        `4️⃣ Send your document (PDF file)\n` +
        `5️⃣ Choose B&W or Color, number of copies\n` +
        `6️⃣ Confirm & pay\n` +
        `7️⃣ Collect your printout at the kiosk!\n\n` +
        `Use /status <job_id> to check job progress.\n` +
        `Use /myjobs to see your recent jobs.`,
      { parse_mode: "Markdown" }
    );
  });

  bot.onText(/\/cancel/, (msg) => {
    resetSession(msg.chat.id);
    bot.sendMessage(msg.chat.id, "✅ Action cancelled.");
  });

  // ────── /kiosks — List available kiosks ──────

  bot.onText(/\/kiosks/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const result = await query(
        "SELECT id, name, location, status, paper_count FROM kiosks ORDER BY status DESC, name"
      );

      if (result.rows.length === 0) {
        return bot.sendMessage(chatId, "No kiosks registered yet.");
      }

      let text = "🏪 *Available Kiosks:*\n\n";
      result.rows.forEach((k, i) => {
        const statusEmoji = k.status === "online" ? "🟢" : "🔴";
        text += `${i + 1}. ${statusEmoji} *${k.name}*\n`;
        text += `   📍 ${k.location || "N/A"}\n`;
        text += `   📄 Paper: ${k.paper_count} sheets\n`;
        text += `   🆔 \`${k.id}\`\n\n`;
      });

      text += "_Use /print to start printing at a kiosk._";
      bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Bot /kiosks error:", err);
      bot.sendMessage(chatId, "❌ Error fetching kiosks. Try again.");
    }
  });

  // ────── /print — Start print flow ──────

  bot.onText(/\/print/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const result = await query(
        "SELECT id, name, location, status FROM kiosks WHERE status = 'online' ORDER BY name"
      );

      if (result.rows.length === 0) {
        return bot.sendMessage(chatId, "😔 No online kiosks available right now. Try later.");
      }

      const keyboard = result.rows.map((k) => [
        { text: `🖨️ ${k.name} (${k.location || "N/A"})`, callback_data: `select_kiosk:${k.id}` },
      ]);

      const session = getSession(chatId);
      session.step = "awaiting_kiosk";
      session.data = {};

      bot.sendMessage(chatId, "📍 *Select a kiosk:*", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      console.error("Bot /print error:", err);
      bot.sendMessage(chatId, "❌ Error loading kiosks. Try again.");
    }
  });

  // ────── /status <jobId> — Check job status ──────

  bot.onText(/\/status\s*(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const jobId = (match[1] || "").trim();

    if (!jobId) {
      // Show jobs for this chat's phone
      const session = getSession(chatId);
      session.step = "awaiting_status_jobid";
      return bot.sendMessage(chatId, "🔍 Send me the *Job ID* to check status:", {
        parse_mode: "Markdown",
      });
    }

    await sendJobStatus(chatId, jobId);
  });

  // ────── /myjobs — Recent jobs by phone ──────

  bot.onText(/\/myjobs/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      // Find jobs linked to documents uploaded via this chat
      const result = await query(
        `SELECT j.id, j.status, j.color_mode, j.copies, j.total, j.created_at,
                d.file_name, k.name as kiosk_name
         FROM jobs j
         JOIN documents d ON j.document_id = d.id
         JOIN kiosks k ON j.kiosk_id = k.id
         WHERE d.user_phone = $1
         ORDER BY j.created_at DESC LIMIT 10`,
        [String(chatId)]
      );

      if (result.rows.length === 0) {
        return bot.sendMessage(
          chatId,
          "📭 No jobs found. Use /print to create your first print job!"
        );
      }

      let text = "📋 *Your Recent Jobs:*\n\n";
      result.rows.forEach((j, i) => {
        const statusEmoji = {
          pending_payment: "💳",
          ready_to_print: "🔔",
          printing: "🖨️",
          completed: "✅",
          failed: "❌",
        }[j.status] || "⏳";

        text += `${i + 1}. ${statusEmoji} *${j.status}*\n`;
        text += `   📄 ${j.file_name} | ${j.copies}× ${j.color_mode}\n`;
        text += `   🏪 ${j.kiosk_name} | ₹${parseFloat(j.total).toFixed(2)}\n`;
        text += `   🆔 \`${j.id}\`\n\n`;
      });

      bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Bot /myjobs error:", err);
      bot.sendMessage(chatId, "❌ Error fetching jobs. Try again.");
    }
  });

  // ────── CALLBACK QUERIES (inline keyboard) ──────

  bot.on("callback_query", async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const session = getSession(chatId);

    bot.answerCallbackQuery(callbackQuery.id);

    try {
      // ── Kiosk selected ──
      if (data.startsWith("select_kiosk:")) {
        const kioskId = data.split(":")[1];
        session.data.kioskId = kioskId;
        session.step = "awaiting_document";

        const kioskResult = await query("SELECT name FROM kiosks WHERE id = $1", [kioskId]);
        const kioskName = kioskResult.rows[0]?.name || kioskId;

        bot.sendMessage(
          chatId,
          `✅ Kiosk: *${kioskName}*\n\n📎 Now send me the *PDF document* you want to print.`,
          { parse_mode: "Markdown" }
        );
      }

      // ── Color mode selected ──
      else if (data.startsWith("color_mode:")) {
        const mode = data.split(":")[1];
        session.data.colorMode = mode;
        session.step = "awaiting_copies";

        bot.sendMessage(
          chatId,
          `${mode === "color" ? "🌈" : "⬛"} Mode: *${mode.toUpperCase()}*\n\n🔢 How many copies? (send a number)`,
          { parse_mode: "Markdown" }
        );
      }

      // ── Confirm job ──
      else if (data === "confirm_job") {
        await createJobAndPayment(chatId, session);
      }

      // ── Cancel job ──
      else if (data === "cancel_job") {
        resetSession(chatId);
        bot.sendMessage(chatId, "❌ Print job cancelled.");
      }

      // ── Simulate payment ──
      else if (data.startsWith("pay_job:")) {
        const paymentId = data.split(":")[1];
        await simulatePayment(chatId, paymentId);
      }
    } catch (err) {
      console.error("Bot callback error:", err);
      bot.sendMessage(chatId, "❌ Something went wrong. Use /cancel and try again.");
    }
  });

  // ────── DOCUMENT HANDLER ──────

  bot.on("document", async (msg) => {
    const chatId = msg.chat.id;
    const session = getSession(chatId);

    if (session.step !== "awaiting_document") {
      return; // Ignore if not in print flow
    }

    const doc = msg.document;
    if (!doc.file_name.toLowerCase().endsWith(".pdf")) {
      return bot.sendMessage(chatId, "⚠️ Please send a *PDF* file only.", {
        parse_mode: "Markdown",
      });
    }

    try {
      // Get file URL from Telegram
      const fileInfo = await bot.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

      // Estimate pages (1 page per 50KB as rough estimate, minimum 1)
      const estimatedPages = Math.max(1, Math.round((doc.file_size || 50000) / 50000));

      // Save document to DB
      const docId = `doc_${uuidv4()}`;
      await query(
        `INSERT INTO documents (id, kiosk_id, user_phone, file_url, file_name, page_count, checksum)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          docId,
          session.data.kioskId,
          String(chatId),
          fileUrl,
          doc.file_name,
          estimatedPages,
          doc.file_unique_id,
        ]
      );

      session.data.documentId = docId;
      session.data.fileName = doc.file_name;
      session.data.pageCount = estimatedPages;
      session.step = "awaiting_pages";

      bot.sendMessage(
        chatId,
        `📄 File: *${doc.file_name}*\n` +
          `📏 Estimated pages: *${estimatedPages}*\n\n` +
          `If the page count is wrong, send the correct number now.\n` +
          `Or send *ok* to continue.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error("Bot doc upload error:", err);
      bot.sendMessage(chatId, "❌ Error uploading file. Try again.");
    }
  });

  // ────── TEXT MESSAGE HANDLER (for multi-step flows) ──────

  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const session = getSession(chatId);
    const text = msg.text.trim();

    try {
      // ── Correcting page count ──
      if (session.step === "awaiting_pages") {
        if (text.toLowerCase() === "ok") {
          // Use estimated pages, move to color mode
        } else {
          const pages = parseInt(text);
          if (!pages || pages < 1 || pages > 10000) {
            return bot.sendMessage(chatId, "⚠️ Send a valid page count (1–10000) or *ok*.", {
              parse_mode: "Markdown",
            });
          }
          session.data.pageCount = pages;
          // Update in DB
          await query("UPDATE documents SET page_count = $1 WHERE id = $2", [
            pages,
            session.data.documentId,
          ]);
        }

        session.step = "awaiting_color";
        bot.sendMessage(chatId, "🎨 *Choose print mode:*", {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "⬛ Black & White (₹2/page)", callback_data: "color_mode:bw" },
                { text: "🌈 Color (₹8/page)", callback_data: "color_mode:color" },
              ],
            ],
          },
        });
      }

      // ── Number of copies ──
      else if (session.step === "awaiting_copies") {
        const copies = parseInt(text);
        if (!copies || copies < 1 || copies > 100) {
          return bot.sendMessage(chatId, "⚠️ Send a number between 1 and 100.");
        }

        session.data.copies = copies;

        // Calculate price
        const pricing = calculatePrice({
          pageCount: session.data.pageCount,
          copies,
          colorMode: session.data.colorMode,
        });

        session.data.pricing = pricing;
        session.step = "awaiting_confirm";

        bot.sendMessage(
          chatId,
          `📋 *Order Summary:*\n\n` +
            `📄 File: ${session.data.fileName}\n` +
            `📏 Pages: ${session.data.pageCount}\n` +
            `🔢 Copies: ${copies}\n` +
            `🎨 Mode: ${session.data.colorMode === "color" ? "Color" : "B&W"}\n\n` +
            `💰 *Price Breakdown:*\n` +
            `   Per page: ₹${pricing.unitPagePrice}\n` +
            `   Subtotal: ₹${pricing.subTotal.toFixed(2)}\n` +
            `   GST (${pricing.gstPercent}%): ₹${pricing.gstAmount.toFixed(2)}\n` +
            `   *Total: ₹${pricing.total.toFixed(2)}*`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Confirm & Pay", callback_data: "confirm_job" },
                  { text: "❌ Cancel", callback_data: "cancel_job" },
                ],
              ],
            },
          }
        );
      }

      // ── Status lookup by job ID ──
      else if (session.step === "awaiting_status_jobid") {
        resetSession(chatId);
        await sendJobStatus(chatId, text);
      }
    } catch (err) {
      console.error("Bot message error:", err);
      bot.sendMessage(chatId, "❌ Something went wrong. Use /cancel and try again.");
    }
  });

  return bot;
}

// ────── HELPERS ──────

async function sendJobStatus(chatId, jobId) {
  try {
    const result = await query(
      `SELECT j.*, d.file_name, k.name as kiosk_name
       FROM jobs j
       JOIN documents d ON j.document_id = d.id
       JOIN kiosks k ON j.kiosk_id = k.id
       WHERE j.id = $1`,
      [jobId]
    );

    if (result.rows.length === 0) {
      return bot.sendMessage(chatId, `❌ Job \`${jobId}\` not found.`, {
        parse_mode: "Markdown",
      });
    }

    const j = result.rows[0];
    const statusEmoji = {
      pending_payment: "💳 Awaiting Payment",
      ready_to_print: "🔔 Ready to Print",
      printing: "🖨️ Printing...",
      completed: "✅ Completed",
      failed: "❌ Failed",
    }[j.status] || j.status;

    let text =
      `📋 *Job Status:*\n\n` +
      `🆔 \`${j.id}\`\n` +
      `📄 ${j.file_name}\n` +
      `🏪 ${j.kiosk_name}\n` +
      `🎨 ${j.color_mode === "color" ? "Color" : "B&W"} × ${j.copies}\n` +
      `💰 ₹${parseFloat(j.total).toFixed(2)}\n` +
      `📊 ${statusEmoji}\n`;

    if (j.failure_reason) {
      text += `\n⚠️ Reason: ${j.failure_reason}`;
    }
    if (j.completed_at) {
      text += `\n🕐 Completed: ${new Date(j.completed_at).toLocaleString()}`;
    }

    bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Bot status error:", err);
    bot.sendMessage(chatId, "❌ Error fetching job status.");
  }
}

async function createJobAndPayment(chatId, session) {
  try {
    const { documentId, kioskId, copies, colorMode, pricing } = session.data;

    const jobId = `job_${uuidv4()}`;

    // Create the job
    await query(
      `INSERT INTO jobs (id, document_id, kiosk_id, copies, color_mode, currency, unit_page_price, sub_total, gst_percent, gst_amount, total, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        jobId,
        documentId,
        kioskId,
        copies,
        colorMode,
        pricing.currency,
        pricing.unitPagePrice,
        pricing.subTotal,
        pricing.gstPercent,
        pricing.gstAmount,
        pricing.total,
        "pending_payment",
      ]
    );

    // Create payment
    const paymentId = `pay_${uuidv4()}`;
    const paymentLink = `https://pay.example.com/${paymentId}`;

    await query(
      `INSERT INTO payments (id, job_id, amount, currency, provider, payment_link)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [paymentId, jobId, pricing.total, "INR", "mock", paymentLink]
    );

    await query("UPDATE jobs SET payment_id = $1 WHERE id = $2", [paymentId, jobId]);

    session.data.jobId = jobId;
    session.data.paymentId = paymentId;
    session.step = "awaiting_payment";

    bot.sendMessage(
      chatId,
      `🎉 *Job Created!*\n\n` +
        `🆔 Job: \`${jobId}\`\n` +
        `💰 Amount: *₹${pricing.total.toFixed(2)}*\n\n` +
        `💳 In a real app, you'd pay via the link below.\n` +
        `For this demo, tap *Simulate Payment* to proceed.\n\n` +
        `🔗 [Payment Link](${paymentLink})`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "💳 Simulate Payment ✅", callback_data: `pay_job:${paymentId}` }],
            [{ text: "📋 Check Status", callback_data: `check_status:${jobId}` }],
          ],
        },
      }
    );
  } catch (err) {
    console.error("Bot createJob error:", err);
    bot.sendMessage(chatId, "❌ Error creating job. Use /cancel and try again.");
  }
}

async function simulatePayment(chatId, paymentId) {
  try {
    const payResult = await transaction(async (client) => {
      const pay = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [
        paymentId,
      ]);

      if (pay.rows.length === 0) {
        throw new Error("Payment not found");
      }

      const payment = pay.rows[0];

      // Mark payment as success
      await client.query("UPDATE payments SET status = $1, paid_at = NOW() WHERE id = $2", [
        "success",
        paymentId,
      ]);

      // Update job to ready_to_print
      const jobResult = await client.query(
        `UPDATE jobs SET status = 'ready_to_print'
         WHERE id = $1 AND status = 'pending_payment'
         RETURNING *`,
        [payment.job_id]
      );

      return jobResult.rows[0];
    });

    if (payResult) {
      // Notify kiosk via WebSocket
      setImmediate(() => {
        notifyJobReady(payResult.kiosk_id, payResult);
      });

      bot.sendMessage(
        chatId,
        `✅ *Payment Successful!*\n\n` +
          `🖨️ Your job is now *ready to print*.\n` +
          `The kiosk has been notified!\n\n` +
          `🆔 Job: \`${payResult.id}\`\n` +
          `📊 Status: 🔔 Ready to Print\n\n` +
          `🏃 Head to the kiosk to collect your printout.\n` +
          `Use /status ${payResult.id} to track progress.`,
        { parse_mode: "Markdown" }
      );
    }

    const session = getSession(chatId);
    resetSession(chatId);
  } catch (err) {
    console.error("Bot payment error:", err);
    bot.sendMessage(chatId, "❌ Payment failed. Try again or use /cancel.");
  }
}

function stopBot() {
  if (bot) {
    bot.stopPolling();
    console.log("Telegram bot stopped");
  }
}

module.exports = { startBot, stopBot };
