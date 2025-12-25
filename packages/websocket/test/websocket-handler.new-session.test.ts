import { describe, expect, it, vi } from "vitest";

import { WebSocketHandler } from "../src/websocket-handler";

describe("WebSocketHandler 新会话行为", () => {
  it("当 chat 未携带 sessionId 时，会先 unsubscribe 以清除旧会话绑定", async () => {
    const sdkClient = {} as any;
    const options = {} as any;
    const handler = new WebSocketHandler(sdkClient, options);

    const ws = { send: vi.fn() } as any;
    const client = { sessionId: "old-session-id" } as any;

    (handler as any).clients.set(ws, client);

    const unsubscribe = vi.fn();
    const setSDKOptions = vi.fn();
    const sendMessage = vi.fn();
    (handler as any).sessionManager = { unsubscribe, setSDKOptions, sendMessage };

    await handler.onMessage(
      ws,
      JSON.stringify({
        type: "chat",
        content: "hello",
        sessionId: null,
      }),
    );

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledWith(client);
    expect(client.sessionId).toBeUndefined();
    expect(setSDKOptions).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("当 chat 携带 sessionId 时，不会主动 unsubscribe", async () => {
    const sdkClient = {} as any;
    const options = {} as any;
    const handler = new WebSocketHandler(sdkClient, options);

    const ws = { send: vi.fn() } as any;
    const client = { sessionId: "old-session-id" } as any;

    (handler as any).clients.set(ws, client);

    const unsubscribe = vi.fn();
    const setSDKOptions = vi.fn();
    const sendMessage = vi.fn();
    (handler as any).sessionManager = { unsubscribe, setSDKOptions, sendMessage };

    await handler.onMessage(
      ws,
      JSON.stringify({
        type: "chat",
        content: "hello",
        sessionId: "new-session-id",
      }),
    );

    expect(unsubscribe).not.toHaveBeenCalled();
    expect(client.sessionId).toBe("new-session-id");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

