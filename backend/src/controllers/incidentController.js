const incidentService = require('../services/incidentService');

async function create(req, res) {
  const incident = await incidentService.create(
    req.auth.userId,
    req.auth.role,
    req.validatedBody
  );
  res.status(201).json({ incident });
}

async function list(req, res) {
  const result = await incidentService.list(req.validatedQuery);
  res.json(result);
}

async function acknowledge(req, res) {
  const incident = await incidentService.acknowledge(
    req.validatedParams.incidentId,
    req.auth.userId
  );
  res.json({ incident });
}

async function resolve(req, res) {
  const incident = await incidentService.resolve(
    req.validatedParams.incidentId,
    req.auth.userId,
    req.validatedBody.note
  );
  res.json({ incident });
}

async function adminList(req, res) {
  const result = await incidentService.list(req.validatedQuery);
  res.json(result);
}

async function adminAcknowledge(req, res) {
  const incident = await incidentService.acknowledge(
    req.validatedParams.incidentId,
    req.auth.userId
  );
  res.json({ incident });
}

async function adminResolve(req, res) {
  const incident = await incidentService.resolve(
    req.validatedParams.incidentId,
    req.auth.userId,
    req.validatedBody.note
  );
  res.json({ incident });
}

module.exports = {
  acknowledge,
  adminAcknowledge,
  adminList,
  adminResolve,
  create,
  list,
  resolve,
};
