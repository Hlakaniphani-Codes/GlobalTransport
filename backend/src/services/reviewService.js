const pool = require('../db');
const AppError = require('../utils/AppError');
const withTransaction = require('../utils/withTransaction');
const notificationService = require('./notifications');
const { normalizePagination, paginationMetadata } = require('../utils/pagination');

async function listPendingDrivers(input = {}) {
  const pagination = normalizePagination(input);
  const [count, result] = await Promise.all([
    pool.query("SELECT count(*)::int AS total FROM drivers WHERE status = 'pending'"),
    pool.query(
    `SELECT u.id, u.email, u.name, u.surname, u.contact_number, u.created_at,
            d.address, d.status
     FROM drivers d
     JOIN users u ON u.id = d.user_id
     WHERE d.status = 'pending'
     ORDER BY d.created_at ASC, d.user_id ASC
     LIMIT $1 OFFSET $2`,
      [pagination.page_size, (pagination.page - 1) * pagination.page_size]
    ),
  ]);
  return { drivers: result.rows, pagination: paginationMetadata(count.rows[0].total, pagination) };
}

async function listDriverDirectory({ page, page_size: pageSize, search }) {
  const pagination = normalizePagination({ page, page_size: pageSize });
  pageSize = pagination.page_size;
  const values = [];
  const searchCondition = search
    ? `AND (
         lower(u.name || ' ' || u.surname) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.email) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.contact_number) LIKE $1 ESCAPE E'\\\\'
       )`
    : '';
  if (search) values.push(getSearchPrefix(search));
  const count = await pool.query(
    `SELECT count(*)::int AS total
     FROM drivers d JOIN users u ON u.id = d.user_id
     WHERE u.is_active = TRUE ${searchCondition}`,
    values
  );
  const total = count.rows[0].total;
  const currentPage = paginationMetadata(total, pagination).page;
  const result = await pool.query(
    `SELECT d.user_id, u.name, u.surname, u.email, u.contact_number,
            d.status, d.is_available, d.licence_expiry, d.prdp_expiry,
            (SELECT round(avg(r.rating)::numeric, 2) FROM trip_ratings r
             WHERE r.driver_user_id = d.user_id) AS average_rating,
            (SELECT count(*)::int FROM trips t
             WHERE t.driver_user_id = d.user_id AND t.status = 'completed') AS trip_count,
            (SELECT count(*)::int FROM trips t
             WHERE t.driver_user_id = d.user_id AND t.status = 'completed') AS trips_completed,
            (SELECT count(*)::int FROM trip_withdrawals withdrawal
             WHERE withdrawal.driver_user_id = d.user_id) AS withdrawals,
            (SELECT count(*)::int FROM trip_withdrawals withdrawal
             WHERE withdrawal.driver_user_id = d.user_id AND withdrawal.late = TRUE) AS late_withdrawals,
            (SELECT count(*)::int FROM trips t
             WHERE t.driver_user_id = d.user_id AND t.status = 'missed') AS missed_trips
     FROM drivers d JOIN users u ON u.id = d.user_id
     WHERE u.is_active = TRUE ${searchCondition}
     ORDER BY lower(u.surname), lower(u.name), d.user_id
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, (currentPage - 1) * pageSize]
  );
  return {
    drivers: result.rows,
    pagination: paginationMetadata(total, { ...pagination, page: currentPage }),
  };
}

function getSearchPrefix(search) {
  return search.trim().toLowerCase().replace(/[\\%_]/g, '\\$&') + '%';
}

async function listPendingDriverApplications({ page, page_size: pageSize, search }) {
  const pagination = normalizePagination({ page, page_size: pageSize });
  pageSize = pagination.page_size;
  const parameters = [];
  const searchCondition = search
    ? `AND (
         lower(u.name) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.surname) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.email) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.contact_number) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.name || ' ' || u.surname) LIKE $1 ESCAPE E'\\\\'
       )`
    : '';
  if (search) parameters.push(getSearchPrefix(search));

  const countResult = await pool.query(
    `SELECT count(*)::int AS total
     FROM drivers d
     JOIN users u ON u.id = d.user_id
     WHERE d.status = 'pending' ${searchCondition}`,
    parameters
  );
  const total = countResult.rows[0].total;
  const currentPage = paginationMetadata(total, pagination).page;
  const offset = (currentPage - 1) * pageSize;
  const pageParameters = [...parameters, pageSize, offset];
  const limitIndex = parameters.length + 1;

  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.surname, u.contact_number, u.created_at,
            d.address, d.status
     FROM drivers d
     JOIN users u ON u.id = d.user_id
     WHERE d.status = 'pending' ${searchCondition}
     ORDER BY d.created_at ASC, d.user_id ASC
     LIMIT $${limitIndex} OFFSET $${limitIndex + 1}`,
    pageParameters
  );
  return {
    applications: result.rows,
    pagination: paginationMetadata(total, { ...pagination, page: currentPage }),
  };
}

async function reviewDriver(userId, adminId, decision) {
  return withTransaction(async (client) => {
    if (decision.status === 'approved') {
      const eligibility = await client.query(
        `SELECT NULLIF(btrim(d.licence_number), '') IS NOT NULL
                  AND d.licence_expiry >= CURRENT_DATE
                  AND EXISTS (
                    SELECT 1 FROM vehicles vehicle
                    WHERE vehicle.driver_user_id = d.user_id
                      AND vehicle.status = 'approved'
                      AND vehicle.make IS NOT NULL AND vehicle.model IS NOT NULL
                      AND vehicle.year IS NOT NULL AND vehicle.colour IS NOT NULL
                      AND vehicle.registration_number IS NOT NULL
                      AND vehicle.seat_count >= 1
                  ) AS ready
         FROM drivers d WHERE d.user_id = $1 FOR UPDATE`,
        [userId]
      );
      if (eligibility.rowCount !== 1) {
        throw new AppError(404, 'Pending driver application not found.');
      }
      if (!eligibility.rows[0].ready) {
        throw new AppError(
          409,
          'Record a current driver licence and approve a complete vehicle before approving this driver.'
        );
      }
    }
    const result = await client.query(
      `UPDATE drivers
       SET status = $1,
           approved_by = CASE WHEN $1 = 'approved' THEN $2::uuid ELSE NULL END,
           approved_at = CASE WHEN $1 = 'approved' THEN now() ELSE NULL END,
           rejection_reason = CASE WHEN $1 = 'rejected' THEN $3 ELSE NULL END
       WHERE user_id = $4 AND status = 'pending'
       RETURNING user_id, status, approved_at, rejection_reason`,
      [decision.status, adminId, decision.rejection_reason || null, userId]
    );

    if (result.rowCount !== 1) {
      throw new AppError(404, 'Pending driver application not found.');
    }

    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'driver', $3, $4)`,
      [adminId, `driver.${decision.status}`, userId, { status: decision.status }]
    );
    await notificationService.notifyDriverAccount(
      userId,
      `driver_application_${decision.status}`,
      decision.status === 'approved' ? 'Application approved' : 'Application update',
      decision.status === 'approved'
        ? 'Your driver application has been approved.'
        : 'Your driver application was not approved. Review your account for details.',
      userId,
      client
    );
    return result.rows[0];
  });
}

async function updateDriverDocuments(userId, adminId, input) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE drivers
       SET licence_number = $2,
           licence_expiry = $3,
           prdp_expiry = COALESCE($4, prdp_expiry),
           is_available = CASE WHEN $3::date < CURRENT_DATE THEN FALSE ELSE is_available END,
           updated_at = now()
       WHERE user_id = $1
       RETURNING user_id, licence_expiry, prdp_expiry, is_available`,
      [userId, input.licence_number, input.licence_expiry, input.prdp_expiry ?? null]
    );
    if (result.rowCount !== 1) {
      throw new AppError(404, 'Driver not found.');
    }
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'driver.documents_updated', 'driver', $2, $3)`,
      [adminId, userId, {
        licence_expiry: result.rows[0].licence_expiry,
        prdp_expiry: result.rows[0].prdp_expiry,
      }]
    );
    return result.rows[0];
  });
}

async function updatePassenger(passengerId, adminId, input) {
  const userFields = ['name', 'surname', 'email', 'contact_number'];
  const passengerFields = [
    'address',
    'home_suburb',
    'workplace',
    'workplace_address',
    'workplace_suburb',
  ];

  try {
    return await withTransaction(async (client) => {
    const passenger = await client.query(
      `SELECT p.user_id
       FROM passengers p
       JOIN users u ON u.id = p.user_id
       WHERE p.user_id = $1
       FOR UPDATE OF p, u`,
      [passengerId]
    );
    if (passenger.rowCount !== 1) {
      throw new AppError(404, 'Passenger not found.');
    }

    const changedFields = Object.keys(input);
    const updateFields = async (table, key, fields) => {
      const assignments = [];
      const values = [passengerId];
      for (const field of fields) {
        if (input[field] === undefined) continue;
        values.push(input[field]);
        assignments.push(`${field} = $${values.length}`);
      }
      if (assignments.length > 0) {
        await client.query(
          `UPDATE ${table} SET ${assignments.join(', ')}, updated_at = now()
           WHERE ${key} = $1`,
          values
        );
      }
    };

    await updateFields('users', 'id', userFields);
    await updateFields('passengers', 'user_id', passengerFields);
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'passenger.updated', 'passenger', $2, $3)`,
      [adminId, passengerId, { updated_fields: changedFields }]
    );
    return { user_id: passengerId, updated_fields: changedFields };
    });
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'users_email_key') {
      throw new AppError(409, 'Unable to update the passenger with these details.');
    }
    throw error;
  }
}

async function listVehicles(input = {}) {
  const pagination = normalizePagination(input);
  const [count, result] = await Promise.all([
    pool.query('SELECT count(*)::int AS total FROM vehicles'),
    pool.query(
    `SELECT v.id, v.driver_user_id, v.make, v.model, v.year, v.colour,
            v.registration_number, v.seat_count, v.status, v.created_at,
            v.licence_disc_expiry,
            u.name AS driver_name, u.surname AS driver_surname,
            (SELECT round(avg(r.rating)::numeric, 2) FROM trip_ratings r
             WHERE r.driver_user_id = v.driver_user_id) AS average_rating,
            (SELECT count(*)::int FROM trips t
             WHERE t.driver_user_id = v.driver_user_id AND t.status = 'completed') AS trip_count,
            (SELECT count(*)::int FROM trips t
             WHERE t.driver_user_id = v.driver_user_id AND t.status = 'completed') AS trips_completed,
            (SELECT count(*)::int FROM trip_withdrawals withdrawal
             WHERE withdrawal.driver_user_id = v.driver_user_id) AS withdrawals,
            (SELECT count(*)::int FROM trip_withdrawals withdrawal
             WHERE withdrawal.driver_user_id = v.driver_user_id AND withdrawal.late = TRUE) AS late_withdrawals,
            (SELECT count(*)::int FROM trips t
             WHERE t.driver_user_id = v.driver_user_id AND t.status = 'missed') AS missed_trips
     FROM vehicles v
     JOIN users u ON u.id = v.driver_user_id
     ORDER BY v.created_at DESC, v.id DESC
     LIMIT $1 OFFSET $2`,
      [pagination.page_size, (pagination.page - 1) * pagination.page_size]
    ),
  ]);
  return { vehicles: result.rows, pagination: paginationMetadata(count.rows[0].total, pagination) };
}

async function listPendingVehicles(input = {}) {
  const pagination = normalizePagination(input);
  const [count, result] = await Promise.all([
    pool.query("SELECT count(*)::int AS total FROM vehicles WHERE status = 'pending'"),
    pool.query(
    `SELECT v.id, v.driver_user_id, v.make, v.model, v.year, v.colour,
            v.registration_number, v.seat_count, v.status, v.created_at,
            u.name AS driver_name, u.surname AS driver_surname, u.email AS driver_email
     FROM vehicles v
     JOIN users u ON u.id = v.driver_user_id
     WHERE v.status = 'pending'
     ORDER BY v.created_at ASC, v.id ASC
     LIMIT $1 OFFSET $2`,
      [pagination.page_size, (pagination.page - 1) * pagination.page_size]
    ),
  ]);
  return { vehicles: result.rows, pagination: paginationMetadata(count.rows[0].total, pagination) };
}

async function listPendingVehicleApplications({ page, page_size: pageSize, search }) {
  const pagination = normalizePagination({ page, page_size: pageSize });
  pageSize = pagination.page_size;
  const parameters = [];
  const searchCondition = search
    ? `AND (
         lower(v.registration_number) LIKE $1 ESCAPE E'\\\\'
         OR lower(v.make) LIKE $1 ESCAPE E'\\\\'
         OR lower(v.model) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.name) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.surname) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.email) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.name || ' ' || u.surname) LIKE $1 ESCAPE E'\\\\'
       )`
    : '';
  if (search) parameters.push(getSearchPrefix(search));

  const countResult = await pool.query(
    `SELECT count(*)::int AS total
     FROM vehicles v
     JOIN users u ON u.id = v.driver_user_id
     WHERE v.status = 'pending' ${searchCondition}`,
    parameters
  );
  const total = countResult.rows[0].total;
  const currentPage = paginationMetadata(total, pagination).page;
  const offset = (currentPage - 1) * pageSize;
  const pageParameters = [...parameters, pageSize, offset];
  const limitIndex = parameters.length + 1;

  const result = await pool.query(
    `SELECT v.id, v.driver_user_id, v.make, v.model, v.year, v.colour,
            v.registration_number, v.seat_count, v.status, v.created_at,
            u.name AS driver_name, u.surname AS driver_surname, u.email AS driver_email
     FROM vehicles v
     JOIN users u ON u.id = v.driver_user_id
     WHERE v.status = 'pending' ${searchCondition}
     ORDER BY v.created_at ASC, v.id ASC
     LIMIT $${limitIndex} OFFSET $${limitIndex + 1}`,
    pageParameters
  );
  return {
    applications: result.rows,
    pagination: paginationMetadata(total, { ...pagination, page: currentPage }),
  };
}

async function reviewVehicle(vehicleId, adminId, decision) {
  try {
    return await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE vehicles
       SET status = $1,
           approved_by = CASE WHEN $1 = 'approved' THEN $2::uuid ELSE NULL END,
           approved_at = CASE WHEN $1 = 'approved' THEN now() ELSE NULL END,
           rejection_reason = CASE WHEN $1 = 'rejected' THEN $3 ELSE NULL END
       WHERE id = $4 AND status = 'pending'
       RETURNING id, driver_user_id, status, approved_at, rejection_reason`,
      [decision.status, adminId, decision.rejection_reason || null, vehicleId]
    );

    if (result.rowCount !== 1) {
      throw new AppError(404, 'Pending vehicle application not found.');
    }

    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'vehicle', $3, $4)`,
      [adminId, `vehicle.${decision.status}`, vehicleId, { status: decision.status }]
    );
    await notificationService.notifyDriverAccount(
      result.rows[0].driver_user_id,
      `vehicle_${decision.status}`,
      decision.status === 'approved' ? 'Vehicle approved' : 'Vehicle application update',
      decision.status === 'approved'
        ? 'Your vehicle has been approved.'
        : 'Your vehicle was not approved. Review your account for details.',
      vehicleId,
      client
    );
    return result.rows[0];
    });
  } catch (error) {
    if (
      error.code === '23505' &&
      ['vehicles_registration_number_uq', 'vehicles_live_registration_uq'].includes(error.constraint)
    ) {
      throw new AppError(409, 'This registration number is already assigned to another vehicle.');
    }
    throw error;
  }
}

async function listApprovedDrivers(search, input = {}) {
  const pagination = normalizePagination(input);
  const searchPrefix = `${search.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
  const count = await pool.query(
    `SELECT count(*)::int AS total
     FROM drivers d
     JOIN users u ON u.id = d.user_id
     WHERE d.status = 'approved' AND u.is_active = TRUE
       AND d.licence_expiry >= CURRENT_DATE
       AND (d.prdp_expiry IS NULL OR d.prdp_expiry >= CURRENT_DATE)
       AND (
         lower(u.name) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.surname) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.name || ' ' || u.surname) LIKE $1 ESCAPE E'\\\\'
       )`,
    [searchPrefix]
  );
  const page = paginationMetadata(count.rows[0].total, pagination).page;
  const result = await pool.query(
    `SELECT d.user_id, u.name, u.surname
            , d.licence_expiry, d.prdp_expiry
            , (SELECT round(avg(r.rating)::numeric, 2) FROM trip_ratings r
               WHERE r.driver_user_id = d.user_id) AS average_rating
            , (SELECT count(*)::int FROM trips t
               WHERE t.driver_user_id = d.user_id AND t.status = 'completed') AS trip_count
            , (SELECT count(*)::int FROM trips t
               WHERE t.driver_user_id = d.user_id AND t.status = 'completed') AS trips_completed
            , (SELECT count(*)::int FROM trip_withdrawals withdrawal
               WHERE withdrawal.driver_user_id = d.user_id) AS withdrawals
            , (SELECT count(*)::int FROM trip_withdrawals withdrawal
               WHERE withdrawal.driver_user_id = d.user_id AND withdrawal.late = TRUE) AS late_withdrawals
            , (SELECT count(*)::int FROM trips t
               WHERE t.driver_user_id = d.user_id AND t.status = 'missed') AS missed_trips
     FROM drivers d
     JOIN users u ON u.id = d.user_id
     WHERE d.status = 'approved' AND u.is_active = TRUE
       AND d.licence_expiry >= CURRENT_DATE
       AND (d.prdp_expiry IS NULL OR d.prdp_expiry >= CURRENT_DATE)
       AND (
         lower(u.name) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.surname) LIKE $1 ESCAPE E'\\\\'
         OR lower(u.name || ' ' || u.surname) LIKE $1 ESCAPE E'\\\\'
       )
     ORDER BY lower(u.surname), lower(u.name), d.user_id
     LIMIT $2 OFFSET $3`,
    [searchPrefix, pagination.page_size, (page - 1) * pagination.page_size]
  );
  return {
    drivers: result.rows,
    pagination: paginationMetadata(count.rows[0].total, { ...pagination, page }),
  };
}

async function listDriverVehicles(driverUserId) {
  const result = await pool.query(
    `SELECT id, make, model, year, colour, registration_number,
            seat_count, status, rejection_reason, created_at, licence_disc_expiry,
            (SELECT ARRAY_REMOVE(ARRAY[
               CASE WHEN drivers.licence_expiry < CURRENT_DATE THEN 'Driver licence' END,
               CASE WHEN drivers.prdp_expiry < CURRENT_DATE THEN 'Professional driving permit' END,
               CASE WHEN vehicles.licence_disc_expiry < CURRENT_DATE THEN 'Vehicle licence disc' END
             ], NULL)
             FROM drivers WHERE drivers.user_id = vehicles.driver_user_id) AS expired_documents
     FROM vehicles
     WHERE driver_user_id = $1
     ORDER BY created_at DESC`,
    [driverUserId]
  );
  return result.rows;
}

async function listPassengers({ page, page_size: pageSize, search }) {
  const pagination = normalizePagination({ page, page_size: pageSize });
  pageSize = pagination.page_size;
  const conditions = ['u.role = \'passenger\'', 'u.is_active = TRUE'];
  const values = [];
  if (search) {
    values.push(`${search.trim().replace(/[\\%_]/g, '\\$&').toLowerCase()}%`);
    const parameter = `$${values.length}`;
    conditions.push(`(
      lower(u.name || ' ' || u.surname) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(u.email) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(u.contact_number) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(p.employee_number) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(COALESCE(p.workplace, w.name)) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(COALESCE(p.home_suburb, '')) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(COALESCE(p.workplace_suburb, '')) LIKE ${parameter} ESCAPE E'\\\\'
    )`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const joins = `FROM users u
    JOIN passengers p ON p.user_id = u.id
    LEFT JOIN workplaces w ON w.id = p.workplace_id
    LEFT JOIN companies c ON c.id = w.company_id`;
  const count = await pool.query(
    `SELECT count(*)::int AS total ${joins} ${where}`,
    values
  );
  const total = count.rows[0].total;
  const currentPage = paginationMetadata(total, pagination).page;
  const result = await pool.query(
    `SELECT u.id, u.name, u.surname, u.email, u.contact_number,
            p.employee_number, p.address, p.home_suburb,
            p.workplace, p.workplace_address, p.workplace_suburb,
            COALESCE(p.workplace, w.name) AS workplace_name,
            c.name AS company_name
     ${joins} ${where}
     ORDER BY lower(u.surname), lower(u.name), u.id
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, (currentPage - 1) * pageSize]
  );
  return {
    passengers: result.rows,
    pagination: paginationMetadata(total, { ...pagination, page: currentPage }),
  };
}

async function resubmitVehicle(driverUserId, vehicleId, input) {
  try {
    return await withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT id, status FROM vehicles
       WHERE id = $1 AND driver_user_id = $2 FOR UPDATE`,
      [vehicleId, driverUserId]
    );
    if (existing.rowCount !== 1) throw new AppError(404, 'Vehicle not found.');
    if (existing.rows[0].status !== 'rejected') {
      throw new AppError(409, 'Only a rejected vehicle can be resubmitted.');
    }
    const result = await client.query(
      `UPDATE vehicles
       SET make = $1, model = $2, year = $3, colour = $4,
           registration_number = $5, seat_count = $6, status = 'pending',
           rejection_reason = NULL, approved_by = NULL, approved_at = NULL,
           rejected_by = NULL, rejected_at = NULL
       WHERE id = $7 AND driver_user_id = $8
       RETURNING id, make, model, year, colour, registration_number,
                 seat_count, status, rejection_reason, created_at`,
      [
        input.make,
        input.model,
        input.year,
        input.colour,
        input.registration_number,
        input.seat_count,
        vehicleId,
        driverUserId,
      ]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'vehicle.resubmitted', 'vehicle', $2, '{}'::jsonb)`,
      [driverUserId, vehicleId]
    );
    return result.rows[0];
    });
  } catch (error) {
    if (
      error.code === '23505' &&
      ['vehicles_registration_number_uq', 'vehicles_live_registration_uq'].includes(error.constraint)
    ) {
      throw new AppError(409, 'A vehicle with this registration number is already in the system.');
    }
    if (error.code === '23505' && error.constraint === 'vehicles_one_live_per_driver_uq') {
      throw new AppError(409, 'This driver already has a pending or approved vehicle.');
    }
    throw error;
  }
}

async function submitVehicle(driverUserId, input) {
  try {
    const result = await pool.query(
      `INSERT INTO vehicles
         (driver_user_id, make, model, year, colour, registration_number,
          seat_count, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $1)
       RETURNING id, make, model, year, colour, registration_number,
                 seat_count, status, rejection_reason, created_at`,
      [
        driverUserId,
        input.make,
        input.model,
        input.year,
        input.colour,
        input.registration_number,
        input.seat_count,
      ]
    );
    return result.rows[0];
  } catch (error) {
    if (
      error.code === '23505' &&
      ['vehicles_registration_number_uq', 'vehicles_live_registration_uq'].includes(error.constraint)
    ) {
      throw new AppError(
        409,
        'A vehicle with this registration number is already in the system. Do not add it again; check whether it already exists or correct the number if there is a typo.'
      );
    }
    if (error.code === '23505' && error.constraint === 'vehicles_one_live_per_driver_uq') {
      throw new AppError(409, 'This driver already has a pending or approved vehicle.');
    }
    throw error;
  }
}

async function onboardVehicle(adminId, input) {
  try {
    return await withTransaction(async (client) => {
    const driver = await client.query(
      `SELECT d.user_id
       FROM drivers d
       JOIN users u ON u.id = d.user_id AND u.is_active = TRUE
       WHERE d.user_id = $1 AND d.status = 'approved'
       FOR SHARE OF d, u`,
      [input.driver_user_id]
    );
    if (driver.rowCount !== 1) {
      throw new AppError(409, 'Select an active, approved driver.');
    }

    const result = await client.query(
      `INSERT INTO vehicles
         (driver_user_id, make, model, year, colour, registration_number,
          seat_count, status, created_by, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8, $8, now())
       RETURNING id, driver_user_id, make, model, year, colour,
                 registration_number, seat_count, status, created_at`,
      [
        input.driver_user_id,
        input.make,
        input.model,
        input.year,
        input.colour,
        input.registration_number,
        input.seat_count,
        adminId,
      ]
    );
    const vehicle = result.rows[0];
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'vehicle.onboarded', 'vehicle', $2, $3)`,
      [adminId, vehicle.id, { driver_user_id: input.driver_user_id }]
    );
    return vehicle;
    });
  } catch (error) {
    if (
      error.code === '23505' &&
      ['vehicles_registration_number_uq', 'vehicles_live_registration_uq'].includes(error.constraint)
    ) {
      throw new AppError(
        409,
        'A vehicle with this registration number is already in the system. Do not add it again; check whether it already exists or correct the number if there is a typo.'
      );
    }
    if (error.code === '23505' && error.constraint === 'vehicles_one_live_per_driver_uq') {
      throw new AppError(409, 'This driver already has a pending or approved vehicle.');
    }
    throw error;
  }
}

module.exports = {
  listApprovedDrivers,
  listDriverDirectory,
  updateDriverDocuments,
  listDriverVehicles,
  listPassengers,
  listVehicles,
  listPendingDriverApplications,
  listPendingVehicles,
  listPendingVehicleApplications,
  listPendingDrivers,
  updatePassenger,
  onboardVehicle,
  resubmitVehicle,
  reviewVehicle,
  reviewDriver,
  submitVehicle,
};
