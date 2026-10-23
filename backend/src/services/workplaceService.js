const pool = require('../db');
const AppError = require('../utils/AppError');
const { normalizePagination, paginationMetadata } = require('../utils/pagination');

function duplicateError(error) {
  if (error.code !== '23505') return null;
  if (error.constraint === 'companies_name_key') {
    return new AppError(409, 'A company with this name already exists.');
  }
  if (error.constraint === 'workplaces_company_id_name_key') {
    return new AppError(409, 'This workplace already exists for the selected company.');
  }
  return new AppError(409, 'A record with these details already exists.');
}

async function listPublicWorkplaces(input = {}) {
  const pagination = normalizePagination(input);
  const [count, result] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS total
       FROM workplaces w JOIN companies c ON c.id = w.company_id
       WHERE w.is_active = TRUE AND c.is_active = TRUE`
    ),
    pool.query(
    `SELECT w.id, w.company_id, c.name AS company_name, w.name, w.address,
            w.suburb, w.latitude, w.longitude
     FROM workplaces w
     JOIN companies c ON c.id = w.company_id
     WHERE w.is_active = TRUE AND c.is_active = TRUE
     ORDER BY c.name, w.name, w.id
     LIMIT $1 OFFSET $2`,
      [pagination.page_size, (pagination.page - 1) * pagination.page_size]
    ),
  ]);
  return {
    workplaces: result.rows,
    pagination: paginationMetadata(count.rows[0].total, pagination),
  };
}

async function listCompanies(input = {}) {
  const pagination = normalizePagination(input);
  const [count, result] = await Promise.all([
    pool.query('SELECT count(*)::int AS total FROM companies'),
    pool.query(
    `SELECT id, name, is_active, created_at
     FROM companies
     ORDER BY name, id
     LIMIT $1 OFFSET $2`,
      [pagination.page_size, (pagination.page - 1) * pagination.page_size]
    ),
  ]);
  return { companies: result.rows, pagination: paginationMetadata(count.rows[0].total, pagination) };
}

async function listWorkplaces(input = {}) {
  const pagination = normalizePagination(input);
  const search = input.search?.trim();
  const searchPattern = search ? `%${search}%` : null;
  const where = search
    ? `WHERE c.name ILIKE $1 OR w.name ILIKE $1 OR w.address ILIKE $1 OR w.suburb ILIKE $1`
    : '';
  const paginationOffset = search ? 2 : 1;
  const [count, result] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS total
       FROM workplaces w JOIN companies c ON c.id = w.company_id
       ${where}`,
      search ? [searchPattern] : []
    ),
    pool.query(
    `SELECT w.id, w.company_id, c.name AS company_name, w.name, w.address,
            w.suburb, w.latitude, w.longitude, w.is_active, w.created_at
     FROM workplaces w
     JOIN companies c ON c.id = w.company_id
     ${where}
     ORDER BY c.name, w.name, w.id
     LIMIT $${paginationOffset} OFFSET $${paginationOffset + 1}`,
      search
        ? [searchPattern, pagination.page_size, (pagination.page - 1) * pagination.page_size]
        : [pagination.page_size, (pagination.page - 1) * pagination.page_size]
    ),
  ]);
  return { workplaces: result.rows, pagination: paginationMetadata(count.rows[0].total, pagination) };
}

async function createCompany(input) {
  try {
    const result = await pool.query(
      `INSERT INTO companies (name)
       VALUES ($1)
       RETURNING id, name, is_active, created_at`,
      [input.name]
    );
    return result.rows[0];
  } catch (error) {
    const mapped = duplicateError(error);
    if (mapped) throw mapped;
    throw error;
  }
}

async function createWorkplace(input) {
  const company = await pool.query(
    'SELECT id FROM companies WHERE id = $1 AND is_active = TRUE',
    [input.company_id]
  );
  if (company.rowCount !== 1) {
    throw new AppError(404, 'The selected active company was not found.');
  }

  try {
    const result = await pool.query(
      `INSERT INTO workplaces
         (company_id, name, address, suburb, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, company_id, name, address, suburb, latitude,
                 longitude, is_active, created_at`,
      [
        input.company_id,
        input.name,
        input.address,
        input.suburb,
        input.latitude ?? null,
        input.longitude ?? null,
      ]
    );
    return result.rows[0];
  } catch (error) {
    const mapped = duplicateError(error);
    if (mapped) throw mapped;
    throw error;
  }
}

async function setActive(kind, id, isActive) {
  const table = kind === 'company' ? 'companies' : 'workplaces';
  const result = await pool.query(
    `UPDATE ${table}
     SET is_active = $1
     WHERE id = $2
     RETURNING id, is_active`,
    [isActive, id]
  );
  if (result.rowCount !== 1) {
    throw new AppError(404, `${kind === 'company' ? 'Company' : 'Workplace'} not found.`);
  }
  return result.rows[0];
}

module.exports = {
  createCompany,
  createWorkplace,
  listCompanies,
  listPublicWorkplaces,
  listWorkplaces,
  setActive,
};
