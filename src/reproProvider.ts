import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { type AddressInfo, type Socket } from "node:net";

import httpProxy from "http-proxy";
import { playwright } from "@vitest/browser-playwright";
import type { PlaywrightBrowserProvider, PlaywrightProviderOptions } from "@vitest/browser-playwright";

import type { BrowserProviderOption, TestProject } from "vitest/node";

type PlaywrightBrowserProviderWithOpenPage = PlaywrightBrowserProvider & {
  openPage: (sessionId: string, url: string, options: { parallel: boolean }) => Promise<void>;
  close: () => Promise<void>;
};

type ReproProxyHandle = {
  close: () => Promise<void>;
  rewriteUrl: (url: string) => string;
};

export function createPatchedPlaywrightProvider(): BrowserProviderOption<PlaywrightProviderOptions> {
  const providerOption = playwright();
  const providerFactory = providerOption.providerFactory;

  providerOption.providerFactory = (project: TestProject) => {
    const provider = providerFactory(project);
    const browserProvider = provider as PlaywrightBrowserProviderWithOpenPage;
    const originalOpenPage = browserProvider.openPage.bind(browserProvider);
    const originalClose = browserProvider.close.bind(browserProvider);

    const failFirstTesterSocket = process.env.VITE_REPRO_FAIL_FIRST_TESTER_SOCKET === "1";
    const closeDelayMs = Number(process.env.VITE_REPRO_FIRST_TESTER_SOCKET_CLOSE_DELAY_MS ?? 1_500);
    let proxyHandlePromise: Promise<ReproProxyHandle> | undefined;

    browserProvider.openPage = async (sessionId, url, options) => {
      proxyHandlePromise ??= createReproProxy(url, { closeDelayMs, failFirstTesterSocket });

      const proxyHandle = await proxyHandlePromise;
      return originalOpenPage(sessionId, proxyHandle.rewriteUrl(url), options);
    };

    browserProvider.close = async () => {
      try {
        await originalClose();
      } finally {
        const proxyHandle = proxyHandlePromise ? await proxyHandlePromise.catch(() => undefined) : undefined;
        await proxyHandle?.close();
      }
    };

    return provider;
  };

  return providerOption;
}

async function createReproProxy(
  targetPageUrl: string,
  options: { closeDelayMs: number; failFirstTesterSocket: boolean },
): Promise<ReproProxyHandle> {
  const targetUrl = new URL(targetPageUrl);
  const targetOrigin = targetUrl.origin;
  let firstTesterSocketDropped = false;

  const proxy = httpProxy.createProxyServer({
    changeOrigin: false,
    target: targetOrigin,
    ws: true,
  });

  proxy.on("error", (error, request, responseOrSocket) => {
    if (isBenignProxySocketError(error)) {
      return;
    }

    console.error(`[repro-proxy] proxy error for ${request.url ?? "<unknown>"}: ${error.message}`);

    if (isServerResponse(responseOrSocket)) {
      if (!responseOrSocket.headersSent) {
        responseOrSocket.writeHead(502, { "content-type": "text/plain" });
      }

      responseOrSocket.end("proxy error");
      return;
    }

    responseOrSocket.destroy(error);
  });

  const server = createServer((request, response) => {
    proxy.web(request, response);
  });

  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  server.on("upgrade", (request, socket, head) => {
    if (
      options.failFirstTesterSocket
      && !firstTesterSocketDropped
      && isTesterBrowserApiRequest(request.url, targetOrigin)
    ) {
      firstTesterSocketDropped = true;
      dropSocketBeforeHandshake(socket, request.url ?? "<unknown>", options.closeDelayMs);
      return;
    }

    proxy.ws(request, socket, head);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("repro proxy did not return an address");
  }

  const proxyOrigin = createProxyOrigin(targetUrl, address);
  console.error(`[repro-proxy] forwarding ${targetOrigin} through ${proxyOrigin}`);

  return {
    close: async () => {
      proxy.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
    rewriteUrl: (url) => {
      const currentUrl = new URL(url);

      if (currentUrl.origin !== targetOrigin) {
        throw new Error(`unexpected browser target origin: ${currentUrl.origin}`);
      }

      currentUrl.hostname = address.address;
      currentUrl.port = String(address.port);
      return currentUrl.toString();
    },
  };
}

function createProxyOrigin(targetUrl: URL, address: AddressInfo): string {
  return `${targetUrl.protocol}//${address.address}:${address.port}`;
}

function dropSocketBeforeHandshake(socket: Socket, requestUrl: string, closeDelayMs: number): void {
  console.error(`[repro-proxy] holding first tester websocket before handshake for ${closeDelayMs}ms: ${requestUrl}`);
  socket.on("error", () => {
  });

  const timer = setTimeout(() => {
    console.error(`[repro-proxy] dropped first tester websocket before handshake: ${requestUrl}`);
    socket.destroy();
  }, closeDelayMs);

  timer.unref?.();
}

function isServerResponse(value: ServerResponse | Socket): value is ServerResponse {
  return "writeHead" in value;
}

function isTesterBrowserApiRequest(requestUrl: string | undefined, targetOrigin: string): boolean {
  if (!requestUrl) {
    return false;
  }

  const url = new URL(requestUrl, targetOrigin);
  return url.pathname === "/__vitest_browser_api__" && url.searchParams.get("type") === "tester";
}

function isBenignProxySocketError(error: Error & { code?: string }): boolean {
  return error.code === "ECONNRESET"
    || error.code === "EPIPE"
    || error.message.includes("socket has been ended by the other party");
}
