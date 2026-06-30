"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface ChatMessage {
  id: string;
  content: string;
  messageType: 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'AUDIO' | 'VIDEO' | 'STICKER' | 'VOICE' | 'VIDEO_NOTE' | 'LOCATION' | 'CONTACT' | 'POLL' | 'DICE' | 'STORY';
  direction: 'sent' | 'received';
  timestamp: string;
  senderName?: string;
  mediaUrl?: string;
  mediaType?: string;
  mediaFileName?: string;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'error';
}

interface UseRealTimeChatOptions {
  workspaceId: string;
  groupId: string;
  accountId: string;
  enabled?: boolean;
}

interface UseRealTimeChatReturn {
  messages: ChatMessage[];
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
  sendMessage: (content: string, messageType?: string, mediaFile?: File) => Promise<void>;
  markAsRead: (messageId: string) => void;
  retryMessage: (messageId: string) => Promise<void>;
  clearMessages: () => void;
  onlineUsers: string[];
  typingUsers: string[];
  startTyping: () => void;
  stopTyping: () => void;
}

export function useRealTimeChat({
  workspaceId,
  groupId,
  accountId,
  enabled = true
}: UseRealTimeChatOptions): UseRealTimeChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('disconnected');
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Server message envelope. Each `type` carries different optional fields;
  // narrow inside the switch rather than over-specifying upfront.
  type WsServerMessage = {
    type: string;
    id?: string;
    content?: string;
    messageType?: ChatMessage['messageType'];
    timestamp?: string;
    senderName?: string;
    mediaUrl?: string;
    mediaType?: string;
    mediaFileName?: string;
    messageId?: string;
    status?: ChatMessage['status'];
    isTyping?: boolean;
    userName?: string;
    users?: string[];
    message?: string;
  };

  // Use ref for handleWebSocketMessage to avoid circular deps
  const handleMessageRef = useRef<(data: WsServerMessage) => void>(undefined);
  handleMessageRef.current = (data: WsServerMessage) => {
    switch (data.type) {
      case 'message':
        if (!data.id || data.content === undefined) break;
        setMessages(prev => [...prev, {
          id: data.id!,
          content: data.content!,
          messageType: data.messageType || 'TEXT',
          direction: 'received',
          timestamp: data.timestamp || new Date().toISOString(),
          senderName: data.senderName,
          mediaUrl: data.mediaUrl,
          mediaType: data.mediaType,
          mediaFileName: data.mediaFileName,
          status: 'read'
        }]);
        break;

      case 'messageStatus':
        if (!data.messageId || !data.status) break;
        setMessages(prev => prev.map(msg =>
          msg.id === data.messageId
            ? { ...msg, status: data.status! }
            : msg
        ));
        break;

      case 'typing':
        if (!data.userName) break;
        setTypingUsers(prev => {
          if (data.isTyping) {
            return prev.includes(data.userName!) ? prev : [...prev, data.userName!];
          } else {
            return prev.filter(user => user !== data.userName);
          }
        });
        break;

      case 'onlineUsers':
        setOnlineUsers(data.users || []);
        break;

      case 'pong':
        break;

      case 'error':
        console.error('[WS] Server error:', data.message);
        break;
    }
  };

  const connect = useCallback(() => {
    if (!enabled || !workspaceId || !groupId || !accountId) {
      return;
    }

    if (wsRef.current) {
      wsRef.current.close();
    }

    setConnectionStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/ws/chat?workspace=${workspaceId}&group=${groupId}&account=${accountId}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionStatus('connected');
      reconnectAttemptsRef.current = 0;

      ws.send(JSON.stringify({
        type: 'auth',
        workspaceId,
        groupId,
        accountId
      }));

      heartbeatIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
    };

    ws.onclose = () => {
      setConnectionStatus('disconnected');

      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }

      if (enabled && reconnectAttemptsRef.current < 5) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
        reconnectAttemptsRef.current += 1;

        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, delay);
      }
    };

    ws.onerror = () => {
      setConnectionStatus('error');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessageRef.current?.(data);
      } catch {
        // Ignore parse errors (heartbeats, etc.)
      }
    };
  }, [workspaceId, groupId, accountId, enabled]);

  const sendMessage = useCallback(async (content: string, messageType: string = 'TEXT', mediaFile?: File): Promise<void> => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();

    const newMessage: ChatMessage = {
      id: messageId,
      content,
      messageType: messageType as ChatMessage['messageType'],
      direction: 'sent',
      timestamp,
      status: 'sending'
    };

    setMessages(prev => [...prev, newMessage]);

    try {
      const messageData: {
        type: string;
        id: string;
        content: string;
        messageType: string;
        timestamp: string;
        workspaceId: string;
        groupId: string;
        accountId: string;
        mediaUrl?: string;
        mediaType?: string;
        mediaFileName?: string;
      } = {
        type: 'sendMessage',
        id: messageId,
        content,
        messageType,
        timestamp,
        workspaceId,
        groupId,
        accountId
      };

      if (mediaFile) {
        const formData = new FormData();
        formData.append('file', mediaFile);
        formData.append('messageId', messageId);

        const uploadResponse = await fetch(`/api/workspaces/${workspaceId}/upload`, {
          method: 'POST',
          body: formData
        });

        if (uploadResponse.ok) {
          const uploadResult = await uploadResponse.json();
          messageData.mediaUrl = uploadResult.url;
          messageData.mediaType = mediaFile.type;
          messageData.mediaFileName = mediaFile.name;
        } else {
          throw new Error('File upload failed');
        }
      }

      wsRef.current.send(JSON.stringify(messageData));
      // Status stays 'sending' until server confirms via 'messageStatus' event

    } catch (err) {
      console.error('[WS] Failed to send message:', err);

      setMessages(prev => prev.map(msg =>
        msg.id === messageId
          ? { ...msg, status: 'error' }
          : msg
      ));

      throw err;
    }
  }, [workspaceId, groupId, accountId]);

  const markAsRead = useCallback((messageId: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'markAsRead',
        messageId
      }));
    }
  }, []);

  const retryMessage = useCallback(async (messageId: string): Promise<void> => {
    const message = messagesRef.current.find(msg => msg.id === messageId);
    if (!message || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    setMessages(prev => prev.map(msg =>
      msg.id === messageId
        ? { ...msg, status: 'sending' }
        : msg
    ));

    try {
      // Resend the same message with its original ID (not creating a duplicate)
      wsRef.current.send(JSON.stringify({
        type: 'sendMessage',
        id: messageId,
        content: message.content,
        messageType: message.messageType,
        timestamp: message.timestamp,
        workspaceId,
        groupId,
        accountId
      }));
    } catch {
      setMessages(prev => prev.map(msg =>
        msg.id === messageId
          ? { ...msg, status: 'error' }
          : msg
      ));
    }
  }, [workspaceId, groupId, accountId]);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  const stopTyping = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'typing',
        isTyping: false
      }));
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  }, []);

  const startTyping = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'typing',
        isTyping: true
      }));

      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }

      typingTimeoutRef.current = setTimeout(stopTyping, 3000);
    }
  }, [stopTyping]);

  // Clear messages when group/account changes
  useEffect(() => {
    setMessages([]);
  }, [groupId, accountId]);

  // Connect and cleanup
  useEffect(() => {
    if (enabled) {
      connect();
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, [connect, enabled]);

  return {
    messages,
    connectionStatus,
    sendMessage,
    markAsRead,
    retryMessage,
    clearMessages,
    onlineUsers,
    typingUsers,
    startTyping,
    stopTyping
  };
}
