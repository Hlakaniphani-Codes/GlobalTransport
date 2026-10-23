const rideRequestService = require('../services/rideRequestService');
const adminRideRequestService = require('../services/adminRideRequestService');
const workplaceService = require('../services/workplaceService');
const incidentService = require('../services/incidentService');

async function listPublicWorkplaces(req, res) {
  const result = await workplaceService.listPublicWorkplaces(req.validatedQuery);
  res.json(result);
}

async function listCompanies(req, res) {
  const result = await workplaceService.listCompanies(req.validatedQuery);
  res.json(result);
}

async function createCompany(req, res) {
  const company = await workplaceService.createCompany(req.validatedBody);
  res.status(201).json({ company });
}

async function listWorkplaces(req, res) {
  const result = await workplaceService.listWorkplaces(req.validatedQuery);
  res.json(result);
}

async function createWorkplace(req, res) {
  const workplace = await workplaceService.createWorkplace(req.validatedBody);
  res.status(201).json({ workplace });
}

async function setCompanyActive(req, res) {
  const company = await workplaceService.setActive(
    'company',
    req.validatedParams.companyId,
    req.validatedBody.is_active
  );
  res.json({ company });
}

async function setWorkplaceActive(req, res) {
  const workplace = await workplaceService.setActive(
    'workplace',
    req.validatedParams.workplaceId,
    req.validatedBody.is_active
  );
  res.json({ workplace });
}

async function createRideRequest(req, res) {
  const rideRequests = await rideRequestService.create(req.auth.userId, req.validatedBody);
  res.status(201).json({
    ride_requests: rideRequests,
    ride_request: rideRequests[0],
  });
}

async function listMyRideRequests(req, res) {
  const result = await rideRequestService.listMine(
    req.auth.userId,
    req.validatedQuery.cursor,
    req.validatedQuery.page_size
  );
  res.json(result);
}

async function cancelRideRequest(req, res) {
  const rideRequests = await rideRequestService.cancel(
    req.auth.userId,
    req.validatedParams.requestId,
    req.validatedBody?.scope ?? 'this'
  );
  res.json({ ride_requests: rideRequests, ride_request: rideRequests[0] });
}

async function listPendingRideRequests(req, res) {
  const rideRequests = await rideRequestService.listPending();
  res.json({ ride_requests: rideRequests });
}

async function listAdminRideRequests(req, res) {
  const result = await adminRideRequestService.list(req.validatedQuery);
  res.json(result);
}

async function cancelAdminRideRequest(req, res) {
  const rideRequest = await adminRideRequestService.cancel(
    req.auth.userId,
    req.validatedParams.requestId,
    req.validatedBody.reason
  );
  res.json({ ride_request: rideRequest });
}

async function dashboardSummary(req, res) {
  const pool = require('../db');
  const [
    pendingRequests,
    unassignedTrips,
    expiringOffers,
    todayTrips,
    onlineDrivers,
    workplaceCounts,
  ] = await Promise.all([
    pool.query(`SELECT count(*)::int AS count FROM ride_requests WHERE status = 'pending'`),
    pool.query(`SELECT count(*)::int AS count FROM trips WHERE status = 'unassigned'`),
    pool.query(`SELECT count(*)::int AS count FROM trip_offers
                WHERE status = 'pending' AND expires_at <= now() + interval '10 minutes'`),
    pool.query(
      `SELECT status, count(*)::int AS count FROM trips
       WHERE scheduled_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Johannesburg')
                             AT TIME ZONE 'Africa/Johannesburg'
         AND scheduled_at < (date_trunc('day', now() AT TIME ZONE 'Africa/Johannesburg') + interval '1 day')
                             AT TIME ZONE 'Africa/Johannesburg'
       GROUP BY status`
    ),
    pool.query(
      `SELECT count(*)::int AS count
       FROM drivers d
       WHERE d.is_available = TRUE
         AND d.licence_expiry >= CURRENT_DATE
         AND (d.prdp_expiry IS NULL OR d.prdp_expiry >= CURRENT_DATE)
         AND EXISTS (
           SELECT 1 FROM vehicles v
           WHERE v.driver_user_id = d.user_id AND v.status = 'approved'
             AND (v.licence_disc_expiry IS NULL OR v.licence_disc_expiry >= CURRENT_DATE)
         )`
    ),
    pool.query(
      `SELECT
         (SELECT count(*)::int FROM workplaces WHERE is_active = TRUE) AS active_workplaces,
         (SELECT count(*)::int FROM companies WHERE is_active = TRUE) AS active_companies`
    ),
  ]);
  res.json({
    pending_ride_requests: pendingRequests.rows[0].count,
    unassigned_trips: unassignedTrips.rows[0].count,
    offers_expiring_soon: expiringOffers.rows[0].count,
    today_trips_by_status: Object.fromEntries(todayTrips.rows.map(({ status, count }) => [status, count])),
    drivers_online: onlineDrivers.rows[0].count,
    active_workplaces: workplaceCounts.rows[0].active_workplaces,
    active_companies: workplaceCounts.rows[0].active_companies,
  });
}

async function needsAttention(req, res) {
  const attention = await incidentService.getNeedsAttention();
  res.json(attention);
}

module.exports = {
  cancelAdminRideRequest,
  cancelRideRequest,
  createCompany,
  createRideRequest,
  createWorkplace,
  dashboardSummary,
  listCompanies,
  listAdminRideRequests,
  listMyRideRequests,
  listPendingRideRequests,
  listPublicWorkplaces,
  listWorkplaces,
  needsAttention,
  setCompanyActive,
  setWorkplaceActive,
};
