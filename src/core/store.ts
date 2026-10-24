import { randomUUID } from 'node:crypto';
import { plainText } from './markdown';
import { DEFAULT_MODEL } from './models';
import type { Chat, ChatMessage, ChatSummary } from './types';

export const STORE_VERSION = 1;
export const MAX_CHATS = 40;
export const MAX_MESSAGES_PER_CHAT = 200;

export interface PersistedState {
    version: number;
    chats: Chat[];
    activeChatId: string | null;
    model: string;
}

export function newId(): string {
    try {
        return randomUUID();
    } catch {
        return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
}

export function createChat(title = '新对话'): Chat {
    const now = Date.now();
    return { id: newId(), title, createdAt: now, updatedAt: now, messages: [] };
}

export function createMessage(
    role: ChatMessage['role'],
    content: string,
    extra: Partial<ChatMessage> = {}
): ChatMessage {
    return { id: newId(), role, content, createdAt: Date.now(), ...extra };
}

export function titleFromText(text: string, maxLength = 24): string {
    const flat = plainText(text);
    if (!flat) {
        return '新对话';
    }
    return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}

export function addMessage(chat: Chat, message: ChatMessage): Chat {
    const messages = [...chat.messages, message].slice(-MAX_MESSAGES_PER_CHAT);
    return {
        ...chat,
        messages,
        title: chat.messages.length === 0 && message.role === 'user' ? titleFromText(message.content) : chat.title,
        updatedAt: Date.now(),
    };
}

export function updateMessage(chat: Chat, messageId: string, patch: Partial<ChatMessage>): Chat {
    return {
        ...chat,
        messages: chat.messages.map((message) => (message.id === messageId ? { ...message, ...patch } : message)),
        updatedAt: Date.now(),
    };
}

export function pruneChats(chats: Chat[], maxChats = MAX_CHATS): Chat[] {
    return [...chats].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxChats);
}

export function summarize(chats: Chat[]): ChatSummary[] {
    return [...chats]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((chat) => ({
            id: chat.id,
            title: chat.title,
            updatedAt: chat.updatedAt,
            messageCount: chat.messages.length,
        }));
}

/** 历史对话转成 API 消息，取最后若干轮，且丢弃出错/空的助手消息。 */
export function historyToApiMessages(
    chat: Chat,
    options: { maxTurns: number; maxChars: number; excludeIds?: Set<string> }
): Array<{ role: 'user' | 'assistant'; content: string }> {
    const usable = chat.messages.filter((message) => {
        if (message.role === 'system' || message.error) {
            return false;
        }
        if (!message.content.trim()) {
            return false;
        }
        return !options.excludeIds?.has(message.id);
    });
    const limited = usable.slice(-Math.max(0, options.maxTurns * 2));
    const picked: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let budget = options.maxChars;
    for (let i = limited.length - 1; i >= 0; i--) {
        const message = limited[i];
        const cost = message.content.length;
        if (cost > budget) {
            break;
        }
        budget -= cost;
        picked.unshift({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content });
    }
    return picked;
}

export function createInitialState(model = DEFAULT_MODEL): PersistedState {
    const chat = createChat();
    return { version: STORE_VERSION, chats: [chat], activeChatId: chat.id, model };
}

/** 容忍旧版本/损坏数据的反序列化。 */
export function parseState(raw: unknown, fallbackModel = DEFAULT_MODEL): PersistedState {
    if (!raw || typeof raw !== 'object') {
        return createInitialState(fallbackModel);
    }
    const candidate = raw as Partial<PersistedState>;
    const chats = Array.isArray(candidate.chats)
        ? candidate.chats
              .filter((chat): chat is Chat => Boolean(chat) && typeof chat.id === 'string' && Array.isArray(chat.messages))
              .map((chat) => ({
                  ...chat,
                  title: typeof chat.title === 'string' && chat.title ? chat.title : '新对话',
                  messages: chat.messages.filter((message): message is ChatMessage => Boolean(message) && typeof message.content === 'string'),
              }))
        : [];

    if (chats.length === 0) {
        return createInitialState(candidate.model || fallbackModel);
    }

    const model = typeof candidate.model === 'string' && candidate.model ? candidate.model : fallbackModel;
    const activeChatId = chats.some((chat) => chat.id === candidate.activeChatId)
        ? (candidate.activeChatId as string)
        : chats[0].id;

    return { version: STORE_VERSION, chats: pruneChats(chats), activeChatId, model };
}
