# 修改密码 UI — 设计文档

- **日期**: 2026-05-23
- **分支**: `feat/change-password-ui`
- **状态**: 已获批,待实现

## 背景与问题

后端早已实现 `POST /api/v1/auth/change-password` 端点(`server/routes/auth.ts`),
靠请求体里的 `oldPassword` 自校验、由 `authLimiter` 限流,且**不**挂 `requireAuth`。
但前端从未接线:全前端只有 `Login.tsx` 引用过 password,主界面(`Layout.tsx`)底栏
只有「暗色模式 / 语言 / 退出登录」三个按钮,**没有任何修改密码入口**。

经浏览器实地验证(隔离临时实例走完 setup→登录→主界面)确认:能力在后端是完整的,
纯粹缺一个调用它的 UI。本设计补上该 UI,并顺手修复一个安全 gap。

## 安全 gap 与决策

现状 `changePassword()` 只更新 `passwordHash`、**不轮换 `jwtSecret`**,因此改密后
已签发的旧 JWT 在过期前(默认 `jwtExpiry = 24h`)仍然有效 —— 无法踢掉其它设备的登录态。

**决策(已与用户确认)**:改密成功时**轮换 `jwtSecret`**,使所有旧 token 立即失效;
同时为当前操作者**重新签发一个新 token 并回发**,前端静默替换,当前窗口不掉线。
兼顾安全(其它会话失效)与体验(当前不掉线),是业界主流做法。

### CSM_SECRET 边界(已知约束)

`getJwtSecret()` 优先使用环境变量 `CSM_SECRET`(见 `server/utils/config.ts` /
`server/auth/service.ts`)。若部署设置了 `CSM_SECRET`,签名密钥恒为 env 值,
轮换 `auth.json` 里的 `jwtSecret` **无法**使旧 token 失效。

处理方式:照常改密并回发新 token(基于 env secret 签发,新旧 token 都有效),
后端 `logger.warn` 记录「CSM_SECRET 已设置,旧 token 将保留到自然过期」。
运行时无法绕过此约束 —— 要使旧会话失效需运维更换 `CSM_SECRET` 并重启。本文档据此记录。

## 用户流程

1. 主界面侧边栏底栏「控制栏」(暗色 / 语言 / 退出 那一排)新增 **钥匙图标按钮**
   (`KeyRound`,lucide),`title` = 「修改密码」。
2. 点击 → 弹出**模态框**(遮罩 + 居中卡片),三个字段:`当前密码` / `新密码` /
   `确认新密码`,每个带显示/隐藏切换(复用 Login 的 `Eye`/`EyeOff` 模式)。
3. 前端校验:新密码 ≥ 8 位、两次输入一致;不满足时「确认」按钮禁用。
4. 提交 → `POST /api/v1/auth/change-password { oldPassword, newPassword }`。
5. **成功**:后端轮换 `jwtSecret` 并回发新 token → 前端 `setToken(newToken)` 静默替换
   → 模态框显示成功态后自动关闭。当前窗口不掉线,其它设备的旧 token 立即失效。
6. **失败**:模态框内显示后端返回的错误(当前密码错误 / 新密码太短 / 限流 429)。

## 组件与改动

### 后端

**`server/auth/service.ts` — `changePassword(oldPassword, newPassword)`**
- 校验旧密码(`bcrypt.compare`);失败返回 `{ success: false, error }`(沿用现有文案)。
- 新密码 < 8 位返回错误(已有逻辑)。
- 更新 `passwordHash`(`bcrypt.hash(newPassword, 12)`)。
- **轮换** `authData.jwtSecret = randomBytes(32).toString('hex')`,写回 `auth.json`(保持 `0o600`)。
- 用新 secret 重新签发 token(与 `login()` 相同的 claims/选项),返回 `{ success: true, token }`。
- 若 `config.jwtSecret`(CSM_SECRET)非空:仍更新 `auth.json` 字段(无害),用 env secret
  签发 token,`logger.warn` 记录约束。返回的 token 与现有 token 都有效。
- 返回类型扩展为 `{ success: boolean; token?: string; error?: string }`。

**`server/routes/auth.ts` — `/change-password`**
- 成功响应体加上 `token`:`res.json({ success: true, token: result.token })`。
- 保持公开(靠 `oldPassword` 自证)+ `authLimiter` 限流(防爆破)。

### 前端

**`src/utils/api.ts`** — `auth` 对象新增:
```ts
changePassword: (oldPassword: string, newPassword: string) =>
  request<{ success: boolean; token?: string; error?: string }>(
    '/auth/change-password',
    { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) },
  )
```
注:`/auth/` 前缀的 401 不会触发跳转(已有逻辑),错误交调用方展示。

**`src/components/ChangePasswordModal.tsx`(新建)**
- props: `{ onClose: () => void }`。
- 自带遮罩层 + 居中卡片;三字段(各含 `Eye`/`EyeOff` 切换)+ 错误/成功提示区。
- 本地校验:新密码 ≥ 8 且两次一致,否则禁用提交;两次不一致显示 `auth.password_mismatch`。
- 提交成功:`setToken(res.token)`(从 `utils/api` 导入)→ 显示成功态 → 短暂延时后 `onClose()`。
- 复用现有 `.card` / `.input` / `.btn` / 设计 token,视觉与 Login 一致。
- 加 `data-testid`(如 `change-pw-current` / `change-pw-new` / `change-pw-confirm` /
  `change-pw-submit` / `change-pw-error`)便于 e2e 选择。

**`src/components/Layout.tsx`**
- 底栏控制栏加 `KeyRound` 图标按钮(`btn btn-ghost`,`data-testid="open-change-pw"`)。
- `useState` 控制模态框开合,条件渲染 `<ChangePasswordModal onClose={...} />`。

**不抽通用 `Modal`** — 目前仅一处用,YAGNI。

### i18n(`src/i18n/en.json` + `src/i18n/zh.json` 同步新增)

`auth` 段新增 key:`change_password`(标题/按钮 title)、`current_password`、
`new_password`、`confirm_password`、`password_mismatch`、`change_btn`、`change_success`。

## 测试

**e2e(Playwright,`tests/e2e/`)** — 新增 `tests/e2e/auth/change-password.spec.ts`:
- setup 初始密码 → 打开模态框。
- 旧密码错误 → 显示错误,不关闭。
- 两次新密码不一致 → 本地校验阻止提交。
- 正确改密 → 成功关闭;随后用**新密码**登录成功、用**旧密码**登录失败。

(项目无单测框架,仅 `@playwright/test`;后端 secret 轮换的行为由上面"旧密码登录失败"
这一 e2e 断言间接覆盖。)

## 范围之外(YAGNI)

不做:邮箱/找回流程、密码强度计、二次确认弹窗、通用 Modal 抽象、独立设置页框架。

## 验证清单

- `npm run typecheck` 通过。
- `npm run build` 通过。
- `npm run test:e2e` 全绿(含新增用例)。
- 浏览器实跑:钥匙按钮 → 模态框 → 改密成功 → 新密码可登录、旧密码被拒。
