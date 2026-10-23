const bcrypt = require('bcryptjs');
const { randomBytes } = require('node:crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const AppError = require('../utils/AppError');
const withTransaction = require('../utils/withTransaction');
const { lockStopSet, lockTripSet } = require('../utils/tripLocking');

const INVALID_CREDENTIALS = "We couldn't sign you in. Check your email and password and try again.";

function createToken(user) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be configured before issuing tokens.');
  }

  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
}

function safeUser(row) {
  const user = {
    id: row.id,
    email: row.email,
    role: row.role,
    name: row.name,
    surname: row.surname,
    contact_number: row.contact_number,
  };

  if (row.role === 'driver') {
    user.status = row.status;
  }

  return user;
}

function duplicateError(error) {
  if (error.constraint === 'users_email_key') {
    return new AppError(409, 'Unable to create an account with these details.');
  }

  if (error.constraint === 'drivers_id_number_key') {
    return new AppError(409, 'An account with this South African ID number already exists.');
  }

  if (error.constraint === 'passengers_workplace_employee_uq') {
    return new AppError(
      409,
      'An employee account with this employee number already exists for this workplace.'
    );
  }
  if (error.constraint === 'passengers_workplace_id_employee_uq') {
    return new AppError(
      409,
      'An employee account with this employee number already exists for this workplace.'
    );
  }

  return new AppError(409, 'An account with these details already exists.');
}

async function resolveWorkplace(client, input) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended(lower(btrim($1)), 0))',
    [input.workplace]
  );

  const workplaceResult = await client.query(
    `SELECT w.id, w.name
     FROM workplaces w
     JOIN companies c ON c.id = w.company_id
     WHERE (
         lower(btrim(w.name)) = lower($1)
         OR lower(btrim(w.name || ' - ' || c.name)) = lower($1)
         OR lower(btrim(c.name || ' - ' || w.name)) = lower($1)
       )
       AND w.is_active = TRUE AND c.is_active = TRUE
     LIMIT 2
     FOR SHARE OF w, c`,
    [input.workplace]
  );

  if (workplaceResult.rows.length === 1) return workplaceResult.rows[0];
  if (workplaceResult.rows.length > 1) {
    throw new AppError(
      400,
      'Enter the workplace name together with the company name.'
    );
  }

  let companyResult = await client.query(
    `INSERT INTO companies (name)
     VALUES ($1)
     ON CONFLICT (lower(name)) DO NOTHING
     RETURNING id, name, is_active`,
    [input.workplace]
  );
  let company = companyResult.rows[0];

  if (!company) {
    companyResult = await client.query(
      `SELECT id, name, is_active
       FROM companies
       WHERE lower(name) = lower($1)
       LIMIT 1
       FOR SHARE`,
      [input.workplace]
    );
    company = companyResult.rows[0];
  }

  if (!company || !company.is_active) {
    throw new AppError(400, 'This workplace is unavailable. Please contact support.');
  }

  const createdWorkplace = await client.query(
    `INSERT INTO workplaces (company_id, name, suburb)
     VALUES ($1, $2, $3)
     RETURNING id, name`,
    [company.id, input.workplace, input.workplace_suburb]
  );
  return createdWorkplace.rows[0];
}

async function register(role, input) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be configured before registering users.');
  }

  const passwordHash = await bcrypt.hash(input.password, 12);
  try {
    return await withTransaction(async (client) => {
      let workplace = null;
      if (role === 'passenger') {
        workplace = await resolveWorkplace(client, input);
      }

      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, role, name, surname, contact_number, terms_accepted_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         RETURNING id, email, role, name, surname, contact_number`,
        [
          input.email,
          passwordHash,
          role,
          input.name,
          input.surname,
          input.contact_number,
        ]
      );
      const user = userResult.rows[0];

      if (role === 'driver') {
        await client.query(
          `INSERT INTO drivers (user_id, address, id_number)
           VALUES ($1, $2, $3)`,
          [user.id, input.address, input.id_number]
        );
        user.status = 'pending';
      } else {
        await client.query(
          `INSERT INTO passengers
           (user_id, address, employee_number, workplace, workplace_id,
            home_suburb, workplace_suburb, home_latitude, home_longitude)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            user.id,
            input.address,
            input.employee_number,
            workplace.name,
            workplace.id,
            input.home_suburb,
            input.workplace_suburb,
            null,
            null,
          ]
        );
      }

      return { token: createToken(user), user: safeUser(user) };
    });
  } catch (error) {
    if (error.code === '23505') {
      throw duplicateError(error);
    }

    throw error;
  }
}

async function login(input, audience = 'mobile') {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be configured before signing in.');
  }

  const result = await pool.query(
    `SELECT u.id, u.email, u.password_hash, u.role, u.name, u.surname,
            u.contact_number, u.is_active, d.status
     FROM users u
     LEFT JOIN drivers d ON d.user_id = u.id
     WHERE u.email = $1`,
    [input.email]
  );
  const user = result.rows[0];

  if (!user || !user.is_active) {
    throw new AppError(401, INVALID_CREDENTIALS);
  }

  const passwordMatches = await bcrypt.compare(input.password, user.password_hash);
  const roleMatches = audience === 'admin' ? user.role === 'admin' : user.role !== 'admin';
  if (!passwordMatches || !roleMatches) {
    throw new AppError(401, INVALID_CREDENTIALS);
  }

  const updated = await pool.query(
    `UPDATE users
     SET last_login_at = now()
     WHERE id = $1 AND is_active = TRUE
     RETURNING id`,
    [user.id]
  );
  if (updated.rowCount !== 1) {
    throw new AppError(401, INVALID_CREDENTIALS);
  }

  return { token: createToken(user), user: safeUser(user) };
}

async function getSafeUser(userId) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.role, u.name, u.surname, u.contact_number,
            d.status
     FROM users u
     LEFT JOIN drivers d ON d.user_id = u.id
     WHERE u.id = $1 AND u.is_active = TRUE`,
    [userId]
  );

  return result.rows[0] ? safeUser(result.rows[0]) : null;
}

async function changePassword(userId, input) {
  const current = await pool.query(
    `SELECT password_hash FROM users
     WHERE id = $1 AND is_active = TRUE`,
    [userId]
  );
  if (current.rowCount !== 1) throw new AppError(401, 'Invalid or expired session.');
  if (!(await bcrypt.compare(input.current_password, current.rows[0].password_hash))) {
    throw new AppError(400, 'Current password is incorrect.');
  }
  if (await bcrypt.compare(input.new_password, current.rows[0].password_hash)) {
    throw new AppError(400, 'Choose a password you have not used before.');
  }
  const passwordHash = await bcrypt.hash(input.new_password, 12);
  await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE users SET password_hash = $1
       WHERE id = $2 AND is_active = TRUE AND password_hash = $3`,
      [passwordHash, userId, current.rows[0].password_hash]
    );
    if (result.rowCount !== 1) {
      throw new AppError(409, 'Your password changed in another session. Please try again.');
    }
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'account.password_changed', 'user', $1, '{}'::jsonb)`,
      [userId]
    );
  });
}

async function deleteAccount(userId, input) {
  const unusablePasswordHash = await bcrypt.hash(randomBytes(48).toString('hex'), 12);
  const accountSnapshot = await pool.query(
    `SELECT role, password_hash
     FROM users
     WHERE id = $1 AND is_active = TRUE`,
    [userId]
  );
  const snapshot = accountSnapshot.rows[0];
  if (!snapshot || !['driver', 'passenger'].includes(snapshot.role)) {
    throw new AppError(404, 'Account not found.');
  }
  if (!(await bcrypt.compare(input.current_password, snapshot.password_hash))) {
    throw new AppError(400, 'Current password is incorrect.');
  }

  return withTransaction(async (client) => {
    const candidateTrips = accountSnapshot.rows[0].role === 'driver'
      ? await client.query(
        `SELECT id, series_id FROM trips
         WHERE driver_user_id = $1
           AND status IN ('in_progress','accepted','offered','unassigned','draft')`,
        [userId]
      )
      : await client.query(
        `SELECT trip_id AS id FROM ride_requests
         WHERE passenger_user_id = $1 AND trip_id IS NOT NULL
         UNION
         SELECT trip_id AS id FROM trip_stops
         WHERE passenger_user_id = $1`,
        [userId]
      );
    const tripIds = candidateTrips.rows.map(({ id }) => id).filter(Boolean);
    let affectedSeriesIds = [];
    if (accountSnapshot.rows[0].role === 'driver') {
      const offerSeries = await client.query(
        `SELECT series_id FROM trip_offers
         WHERE driver_user_id = $1 AND status IN ('pending','queued')
           AND series_id IS NOT NULL`,
        [userId]
      );
      affectedSeriesIds = [...new Set([
        ...candidateTrips.rows.map(({ series_id: seriesId }) => seriesId).filter(Boolean),
        ...offerSeries.rows.map(({ series_id: seriesId }) => seriesId).filter(Boolean),
      ])];
      if (affectedSeriesIds.length > 0) {
        const seriesTrips = await client.query(
          `SELECT id FROM trips WHERE series_id = ANY($1::uuid[])`,
          [affectedSeriesIds]
        );
        tripIds.push(...seriesTrips.rows.map(({ id }) => id));
      }
    }
    const lockedTripIds = await lockTripSet(client, tripIds);
    if (lockedTripIds.length > 0) {
      await lockStopSet(client, lockedTripIds, 'id');
      await client.query(
        `SELECT id FROM trip_offers
         WHERE trip_id = ANY($1::uuid[])
            OR ($2::uuid[] IS NOT NULL AND series_id = ANY($2::uuid[]))
         ORDER BY id
         FOR UPDATE`,
        [lockedTripIds, affectedSeriesIds.length > 0 ? affectedSeriesIds : null]
      );
    }

    const accountResult = await client.query(
      `SELECT id, role, password_hash
       FROM users
       WHERE id = $1 AND is_active = TRUE
       FOR UPDATE`,
      [userId]
    );
    const account = accountResult.rows[0];
    if (!account || !['driver', 'passenger'].includes(account.role)) {
      throw new AppError(404, 'Account not found.');
    }
    if (account.password_hash !== snapshot.password_hash || account.role !== snapshot.role) {
      throw new AppError(409, 'Your account changed in another session. Please try again.');
    }

    if (account.role === 'driver') {
      const activeTrip = await client.query(
        `SELECT id FROM trips
         WHERE driver_user_id = $1 AND status = 'in_progress'
         ORDER BY id`,
        [userId]
      );
      if (activeTrip.rowCount > 0) {
        throw new AppError(409, 'Your account cannot be deleted while a Trip is in progress.');
      }

      const futureTrips = await client.query(
        `SELECT id, series_id
         FROM trips
         WHERE driver_user_id = $1
           AND status IN ('accepted','offered','unassigned','draft')
           AND COALESCE(starts_at, scheduled_at) > now()
         ORDER BY id`,
        [userId]
      );
      const futureTripIds = futureTrips.rows.map(({ id }) => id);
      const seriesIds = [...new Set(futureTrips.rows.map(({ series_id }) => series_id))];
      const pendingOffers = await client.query(
        `SELECT series_id
         FROM trip_offers
         WHERE driver_user_id = $1 AND status IN ('pending','queued')
         ORDER BY id`,
        [userId]
      );
      seriesIds.push(...pendingOffers.rows.map(({ series_id }) => series_id));
      const affectedSeriesIds = [...new Set(seriesIds)];
      if (affectedSeriesIds.length > 0) {
        await client.query(
          `UPDATE trip_offers
           SET status = 'cancelled', responded_at = now()
           WHERE series_id = ANY($1::uuid[]) AND status IN ('pending','queued')`,
          [affectedSeriesIds]
        );
        await client.query(
          `UPDATE trips SET status = 'unassigned', driver_user_id = NULL, vehicle_id = NULL
           WHERE series_id = ANY($1::uuid[]) AND status = 'offered'
             AND id <> ALL($2::uuid[])`,
          [affectedSeriesIds, futureTripIds]
        );
      }
      if (futureTripIds.length > 0) {
        await client.query(
          `UPDATE trip_stops
           SET status = 'skipped', skip_kind = 'cancelled',
               skip_reason = 'Driver account deleted.', completed_at = COALESCE(completed_at, now())
           WHERE trip_id = ANY($1::uuid[]) AND status IN ('pending','arrived')`,
          [futureTripIds]
        );
        await client.query(
          `UPDATE ride_requests
           SET status = 'pending', trip_id = NULL
           WHERE trip_id = ANY($1::uuid[]) AND status = 'assigned'`,
          [futureTripIds]
        );
        await client.query(
          `UPDATE trips
           SET status = 'cancelled', driver_user_id = NULL, vehicle_id = NULL,
               cancelled_at = now(), cancelled_by = $2,
               cancel_reason = 'Driver account deleted.'
           WHERE id = ANY($1::uuid[])`,
          [futureTripIds, userId]
        );
      }
    } else {
      const requests = await client.query(
        `UPDATE ride_requests
         SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()), cancelled_by = $1,
             cancel_reason = 'Passenger account deleted.',
             cancelled_late = CASE
               WHEN status IN ('pending','assigned') THEN scheduled_at < now()
                 + (COALESCE(NULLIF($2, '')::numeric, 2) * interval '1 hour')
               ELSE cancelled_late
             END
         WHERE passenger_user_id = $1 AND status <> 'cancelled'
         RETURNING id, trip_id`,
        [userId, process.env.LATE_CANCELLATION_HOURS || '2']
      );
      const existingStops = await client.query(
        'SELECT trip_id FROM trip_stops WHERE passenger_user_id = $1 ORDER BY id',
        [userId]
      );
      const affectedTripIds = [...new Set([
        ...requests.rows.map(({ trip_id }) => trip_id).filter(Boolean),
        ...existingStops.rows.map(({ trip_id }) => trip_id),
      ])];
      await client.query(
        `UPDATE trip_stops
         SET status = CASE WHEN status IN ('pending','arrived') THEN 'skipped' ELSE status END,
             skip_reason = CASE WHEN status IN ('pending','arrived')
               THEN 'Passenger account deleted.' ELSE skip_reason END,
             address = 'Removed', suburb = NULL, latitude = NULL, longitude = NULL
         WHERE passenger_user_id = $1`,
        [userId]
      );
      for (const tripId of affectedTripIds) {
        const remaining = await client.query(
          `SELECT count(DISTINCT ride_request_id)::int AS count
           FROM trip_stops
           WHERE trip_id = $1 AND status <> 'skipped'`,
          [tripId]
        );
        if (remaining.rows[0].count === 0) {
          await client.query(
            `UPDATE trips
             SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
                 cancel_reason = 'All passengers deleted their accounts.'
             WHERE id = $1 AND status IN ('draft','offered','accepted','unassigned')`,
            [tripId, userId]
          );
          await client.query(
            `UPDATE trip_offers
             SET status = 'cancelled', responded_at = now()
             WHERE trip_id = $1 AND status IN ('pending','queued')`,
            [tripId]
          );
        }
      }
    }

    if (account.role === 'driver') {
      await client.query(
        `UPDATE drivers
         SET address = 'Removed', id_number = 'DELETED-' || user_id::text,
             licence_number = NULL, licence_expiry = NULL, photo_url = NULL,
             prdp_number = NULL, prdp_expiry = NULL, is_available = FALSE
         WHERE user_id = $1`,
        [userId]
      );
    } else {
      await client.query(
        `UPDATE passengers
         SET address = 'Removed', employee_number = 'deleted-' || user_id::text,
             workplace = NULL, emergency_contact_name = NULL,
             emergency_contact_number = NULL, home_suburb = NULL,
             workplace_suburb = NULL, home_latitude = NULL, home_longitude = NULL
         WHERE user_id = $1`,
        [userId]
      );
    }

    await client.query(
      `UPDATE users
       SET email = 'deleted-' || id::text || '@invalid.example',
           password_hash = $1, name = 'Deleted', surname = 'User',
           contact_number = 'Removed', is_active = FALSE, deleted_at = now()
       WHERE id = $2`,
      [unusablePasswordHash, userId]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'account.deleted', 'user', $1, jsonb_build_object('role', $2))`,
      [userId, account.role]
    );
  });
}

module.exports = { changePassword, deleteAccount, getSafeUser, login, register };
