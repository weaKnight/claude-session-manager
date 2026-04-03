/**
 * SSE hook / SSE 实时更新 Hook
 * Subscribes to server-sent events for live file changes
 * 订阅服务器推送事件以获取文件变更通知
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { getToken } from '../utils/api';

interface SSEEvent {
  type: 'add' | 'change' | 'remove' | 'connected';
  projectId?: string;
  sessionId?: string;
  timestamp: string;
}

export function useSSE(onEvent?: (event: SSEEvent) => void) {
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const callbackRef = useRef(onEvent);
  callbackRef.current = onEvent;

  const connect = useCallback(() => {
    const token = getToken();
    if (!token) return;

    // Close existing connection / 关闭已有连接
    eventSourceRef.current?.close();

    const es = new EventSource(`/api/v1/events?token=${encodeURIComponent(token)}`);

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === 'connected') {
          setConnected(true);
        }
        callbackRef.current?.(data);
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      // Reconnect after 5 seconds / 5 秒后重连
      setTimeout(connect, 5000);
    };

    eventSourceRef.current = es;
  }, []);

  useEffect(() => {
    connect();
    return () => {
      eventSourceRef.current?.close();
    };
  }, [connect]);

  return { connected };
}
