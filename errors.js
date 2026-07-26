"use strict";

class AppError extends Error {
  constructor(status, message, code = "APP_ERROR", details = undefined) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function assert(condition, status, message, code) {
  if (!condition) throw new AppError(status, message, code);
}

module.exports = { AppError, assert };
