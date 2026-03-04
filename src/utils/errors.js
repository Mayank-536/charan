function apiError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.details = details;
  return err;
}

function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const code = err.code || "INTERNAL_ERROR";

  res.status(status).json({
    error: {
      code,
      message: err.message || "Unexpected error",
      details: err.details || null,
      requestId: req.id || null,
    },
  });
}

module.exports = { apiError, errorHandler };
