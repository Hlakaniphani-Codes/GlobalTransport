const AppError = require('../utils/AppError');
const notificationService = require('../services/notifications');

async function registerDevice(req, res) {
  const device = await notificationService.registerToken(
    req.auth.userId,
    req.validatedBody.token,
    req.validatedBody.platform,
    req.validatedBody.device_name
  );
  res.status(200).json({ device });
}

async function deleteDevice(req, res) {
  await notificationService.revokeToken(req.auth.userId, req.validatedParams.token);
  res.status(204).end();
}

async function sendTestNotification(req, res) {
  await notificationService.sendTestNotification(req.auth.userId);
  res.status(202).json({ message: 'Test notification queued.' });
}

async function listNotifications(req, res) {
  const result = await notificationService.listNotifications(
    req.auth.userId,
    req.validatedQuery.cursor
  );
  res.json(result);
}

async function markRead(req, res) {
  const notification = await notificationService.markRead(
    req.auth.userId,
    req.validatedParams.id
  );
  if (!notification) throw new AppError(404, 'Notification not found.');
  res.json({ notification });
}

async function markAllRead(req, res) {
  const updated = await notificationService.markAllRead(req.auth.userId);
  res.json({ updated });
}

async function getPreferences(req, res) {
  const preferences = await notificationService.getPreferences(req.auth.userId);
  if (!preferences) throw new AppError(404, 'Account not found.');
  res.json({ preferences });
}

async function updatePreferences(req, res) {
  const preferences = await notificationService.updatePreferences(
    req.auth.userId,
    req.validatedBody
  );
  if (!preferences) throw new AppError(404, 'Account not found.');
  res.json({ preferences });
}

async function adminList(req, res) {
  const result = await notificationService.listNotificationLog(req.validatedQuery);
  res.json(result);
}

module.exports = {
  adminList,
  deleteDevice,
  getPreferences,
  listNotifications,
  markAllRead,
  markRead,
  registerDevice,
  sendTestNotification,
  updatePreferences,
};
