const authService = require('../services/authService');
const AppError = require('../utils/AppError');

async function registerDriver(req, res) {
  const result = await authService.register('driver', req.validatedBody);
  res.status(201).json(result);
}

async function registerPassenger(req, res) {
  const result = await authService.register('passenger', req.validatedBody);
  res.status(201).json(result);
}

async function login(req, res) {
  const result = await authService.login(req.validatedBody, 'mobile');
  res.json(result);
}

async function adminLogin(req, res) {
  const result = await authService.login(req.validatedBody, 'admin');
  res.json(result);
}

async function me(req, res, next) {
  const user = await authService.getSafeUser(req.auth.userId);
  if (!user) {
    return next(new AppError(401, 'Invalid or expired token.'));
  }

  res.json({ user });
}

async function changePassword(req, res) {
  await authService.changePassword(req.auth.userId, req.validatedBody);
  res.json({ message: 'Password updated.' });
}

async function deleteAccount(req, res) {
  await authService.deleteAccount(req.auth.userId, req.validatedBody);
  res.json({ message: 'Account deleted.' });
}

module.exports = {
  adminLogin,
  changePassword,
  deleteAccount,
  login,
  me,
  registerDriver,
  registerPassenger,
};
