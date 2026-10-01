import { requestLockdownExtension } from "./lockdownBridge";

describe("lockdown extension bridge", () => {
  test("resolves only a matching extension response", async () => {
    const listener = (event) => {
      const message = event.data;
      if (message?.source !== "accessguard-web") return;
      window.dispatchEvent(new MessageEvent("message", {
        source: window,
        origin: window.location.origin,
        data: {
          source: "accessguard-extension",
          type: "AG_LOCKDOWN_RESPONSE",
          requestId: message.requestId,
          ok: true,
          data: { installed: true, version: "1.0.0" },
        },
      }));
    };
    window.addEventListener("message", listener);
    await expect(requestLockdownExtension("DISCOVER", {}, 1000)).resolves.toMatchObject({
      installed: true,
      version: "1.0.0",
    });
    window.removeEventListener("message", listener);
  });

  test("times out when no extension responds", async () => {
    await expect(requestLockdownExtension("DISCOVER", {}, 5)).rejects.toThrow(
      "AccessGuard extension was not detected"
    );
  });
});
