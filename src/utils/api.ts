/**
 * API client / API 客户端
 * Handles all HTTP requests to the backend with JWT auth
 * 处理所有与后端的 HTTP 请求（带 JWT 认证）
 */

const API_BASE = '/api/v1';

/**
 * Get stored JWT token / 获取存储的 JWT token
 */
export function getToken(): string | null {
  return localStorage.getItem('csm_token');
}

/**
 * Store JWT token / 存储 JWT token
 */
export function setToken(token: string): void {
  localStorage.setItem('csm_token', token);
}

/**
 * Clear JWT token / 清除 JWT token
 */
export function clearToken(): void {
  localStorage.removeItem('csm_token');
}

// In-memory ETag cache for idempotent GETs. Each entry holds the last
// response body alongside its server-issued ETag, letting us send
// If-None-Match and serve a 304 from cache without a roundtrip cost.
// 仅对幂等 GET 生效的 ETag 缓存；用 If-None-Match 命中后直接复用本地副本
const etagCache = new Map<string, { etag: string; body: unknown }>();

/**
 * Drop a cached ETag entry (called when SSE signals the resource changed).
 * SSE 接到资源变更时调用，丢弃陈旧缓存
 */
export function invalidateEtagCache(prefix?: string): void {
  if (!prefix) {
    etagCache.clear();
    return;
  }
  for (const key of etagCache.keys()) {
    if (key.startsWith(prefix)) etagCache.delete(key);
  }
}

/**
 * Generic fetch wrapper with auth / 通用 fetch 封装（带认证）
 */
async function request<T>(
  path: string,
  options: RequestInit & { signal?: AbortSignal } = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const method = (options.method || 'GET').toUpperCase();
  const isCacheable = method === 'GET';
  const cached = isCacheable ? etagCache.get(path) : undefined;
  if (cached) {
    headers['If-None-Match'] = cached.etag;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  // Handle auth errors on protected endpoints only.
  // For /auth/login and /auth/setup, a 401 is a legitimate "wrong password"
  // response that the caller must surface to the user — don't reload the page.
  // 仅对受保护端点的 401 做跳转；登录/设置接口的 401 表示密码错误，交给调用方处理。
  const isAuthEndpoint = path.startsWith('/auth/');
  if (res.status === 401 && !isAuthEndpoint) {
    clearToken();
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  if (res.status === 304 && cached) {
    return cached.body as T;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  const body = (await res.json()) as T;
  if (isCacheable) {
    const etag = res.headers.get('ETag');
    if (etag) etagCache.set(path, { etag, body });
  }
  return body;
}

// --- Auth API / 认证接口 ---

export const auth = {
  status: () => request<{ setupRequired: boolean }>('/auth/status'),

  setup: (password: string) =>
    request<{ success: boolean; token?: string }>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  login: (password: string) =>
    request<{ success: boolean; token?: string; error?: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
};

// --- Projects API / 项目接口 ---

export interface ProjectInfo {
  encodedPath: string;
  decodedPath: string;
  displayName: string;
  sessionCount: number;
  lastActivity: string;
}

export interface SessionMeta {
  id: string;
  projectPath: string;
  projectName: string;
  filePath: string;
  firstTimestamp: string;
  lastTimestamp: string;
  messageCount: number;
  summary?: string;
  cwd?: string;
  gitBranch?: string;
  isAgent: boolean;
  totalTokens: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  fileSize: number;
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export interface ParsedMessage {
  uuid: string;
  parentUuid?: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: string;
  content: ContentBlock[];
  model?: string;
  usage?: Record<string, number>;
  costUSD?: number;
  durationMs?: number;
}

export interface AuditCommand {
  sessionId: string;
  timestamp: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: string;
  isError: boolean;
  messageUuid: string;
}

export interface SearchResult {
  projectId: string;
  projectName: string;
  sessionId: string;
  summary: string;
  timestamp: string;
  score: number;
  matchSnippet: string;
}

export const projects = {
  list: (signal?: AbortSignal) =>
    request<{ projects: ProjectInfo[] }>('/projects', { signal }),

  sessions: (projectId: string, signal?: AbortSignal) =>
    request<{ sessions: SessionMeta[] }>(`/projects/${projectId}/sessions`, { signal }),
};

export interface SessionPage {
  meta: SessionMeta;
  messages: ParsedMessage[];
  nextCursor: string | null;
}

export interface MessageSlice {
  messages: ParsedMessage[];
  nextCursor: string | null;
}

export const sessions = {
  get: (projectId: string, sessionId: string, signal?: AbortSignal) =>
    request<SessionPage>(`/sessions/${projectId}/${sessionId}`, { signal }),

  messages: (
    projectId: string,
    sessionId: string,
    opts: { after?: string; limit?: number; signal?: AbortSignal } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.after) params.set('after', opts.after);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return request<MessageSlice>(
      `/sessions/${projectId}/${sessionId}/messages${qs ? `?${qs}` : ''}`,
      { signal: opts.signal },
    );
  },

  commands: (projectId: string, sessionId: string, signal?: AbortSignal) =>
    request<{ commands: AuditCommand[] }>(
      `/sessions/${projectId}/${sessionId}/commands`,
      { signal },
    ),

  delete: (projectId: string, sessionId: string, force = false) =>
    request<{ success: boolean }>(
      `/sessions/${projectId}/${sessionId}${force ? '?force=true' : ''}`,
      { method: 'DELETE' }
    ),
};

export const search = {
  query: (q: string, opts?: { project?: string; from?: string; to?: string }) => {
    const params = new URLSearchParams({ q });
    if (opts?.project) params.set('project', opts.project);
    if (opts?.from) params.set('from', opts.from);
    if (opts?.to) params.set('to', opts.to);
    return request<{ query: string; count: number; results: SearchResult[] }>(
      `/search?${params}`
    );
  },
};

export interface TrashItem {
  fileName: string;
  projectId: string;
  sessionId: string;
  deletedAt: number;
  fileSize: number;
}

export const trash = {
  list: () => request<{ items: TrashItem[] }>('/trash'),

  restore: (fileName: string) =>
    request<{ success: boolean }>('/trash/restore', {
      method: 'POST',
      body: JSON.stringify({ fileName }),
    }),

  empty: () =>
    request<{ success: boolean; deleted: number }>('/trash', {
      method: 'DELETE',
    }),
};

export const stats = {
  get: () => request<Record<string, unknown>>('/stats'),
};
