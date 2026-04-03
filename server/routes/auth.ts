/**
 * Auth API routes / 认证 API 路由
 */

import { Router } from 'express';
import { isSetupRequired, setupPassword, login, changePassword } from '../auth/service.js';
import { getClientIp } from '../auth/middleware.js';

const router = Router();

// GET /api/v1/auth/status - Check auth status / 检查认证状态
router.get('/status', (_req, res) => {
  res.json({
    setupRequired: isSetupRequired(),
    message: isSetupRequired()
      ? 'Password setup required / 需要设置密码'
      : 'Ready / 就绪',
  });
});

// POST /api/v1/auth/setup - Initial password setup / 初始密码设置
router.post('/setup', async (req, res) => {
  const { password } = req.body as { password?: string };

  if (!password) {
    res.status(400).json({ error: 'Password required / 密码必填' });
    return;
  }

  const result = await setupPassword(password);
  if (result.success) {
    // Auto-login after setup / 设置后自动登录
    const loginResult = await login(password, getClientIp(req));
    res.json({ success: true, token: loginResult.token });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// POST /api/v1/auth/login - Login / 登录
router.post('/login', async (req, res) => {
  const { password } = req.body as { password?: string };
  const clientIp = getClientIp(req);

  if (!password) {
    res.status(400).json({ error: 'Password required / 密码必填' });
    return;
  }

  const result = await login(password, clientIp);
  if (result.success) {
    res.json({ success: true, token: result.token });
  } else {
    const status = result.lockedUntil ? 429 : 401;
    res.status(status).json({ error: result.error, lockedUntil: result.lockedUntil });
  }
});

// POST /api/v1/auth/change-password - Change password / 修改密码
router.post('/change-password', async (req, res) => {
  const { oldPassword, newPassword } = req.body as {
    oldPassword?: string;
    newPassword?: string;
  };

  if (!oldPassword || !newPassword) {
    res.status(400).json({ error: 'Both old and new passwords required / 需要新旧密码' });
    return;
  }

  const result = await changePassword(oldPassword, newPassword);
  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(400).json({ error: result.error });
  }
});

export default router;
