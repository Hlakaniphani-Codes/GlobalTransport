const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const { Buffer } = require('node:buffer');
const AppError = require('./AppError');

function normalizePagination(input = {}) {
  const page = Number(input.page);
  const requestedPageSize = Number(input.page_size);
  return {
    page: Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE,
    page_size: Number.isInteger(requestedPageSize) && requestedPageSize > 0
      ? Math.min(requestedPageSize, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE,
  };
}

function paginationMetadata(total, input = {}) {
  const normalized = normalizePagination(input);
  const totalPages = Math.max(1, Math.ceil(total / normalized.page_size));
  const page = Math.min(normalized.page, totalPages);
  return {
    page,
    page_size: normalized.page_size,
    total,
    total_pages: totalPages,
  };
}

function encodeCursor(sortAt, id) {
  return Buffer.from(JSON.stringify({ sort_at: sortAt, id })).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed.sort_at !== 'string' || Number.isNaN(Date.parse(parsed.sort_at))
      || typeof parsed.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.id)) {
      throw new Error('Invalid cursor');
    }
    return parsed;
  } catch {
    throw new AppError(400, 'The list cursor is invalid.');
  }
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  normalizePagination,
  paginationMetadata,
};