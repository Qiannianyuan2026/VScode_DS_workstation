/**
 * Server-Sent Events 增量解析器。
 *
 * 只负责把网络分片切成 `data:` 载荷字符串，JSON 解析交给调用方，
 * 这样断线重连、`[DONE]` 哨兵和脏数据都能在一个地方处理。
 */
export class SseParser {
    private buffer = '';

    /** 喂入一段文本，返回其中完整事件的 data 载荷。 */
    feed(chunk: string): string[] {
        this.buffer += chunk;
        const events: string[] = [];

        for (;;) {
            const match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
            if (!match) {
                break;
            }
            const rawEvent = this.buffer.slice(0, match.index);
            this.buffer = this.buffer.slice(match.index + match[0].length);
            const payload = SseParser.parseEvent(rawEvent);
            if (payload !== undefined) {
                events.push(payload);
            }
        }

        return events;
    }

    /** 流结束时调用：把残留的、没有结尾空行的最后一个事件也解析出来。 */
    flush(): string[] {
        const rest = this.buffer.trim();
        this.buffer = '';
        if (!rest) {
            return [];
        }
        const payload = SseParser.parseEvent(rest);
        return payload === undefined ? [] : [payload];
    }

    private static parseEvent(rawEvent: string): string | undefined {
        const dataLines: string[] = [];
        for (const line of rawEvent.split(/\r\n|\n|\r/)) {
            if (!line.startsWith('data:')) {
                // event:/id:/retry: 和注释行（: keep-alive）都不需要
                continue;
            }
            let value = line.slice(5);
            if (value.startsWith(' ')) {
                value = value.slice(1);
            }
            dataLines.push(value);
        }
        if (dataLines.length === 0) {
            return undefined;
        }
        return dataLines.join('\n');
    }
}
