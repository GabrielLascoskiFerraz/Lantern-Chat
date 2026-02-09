import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { WS_PORT_END, WS_PORT_START } from './config';
import { ProtocolFrame } from './types';

export interface InboundContext {
  socket: WebSocket;
  remoteAddress: string;
}

export class LanternWsServer {
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private onFrame: ((frame: ProtocolFrame, ctx: InboundContext) => void) | null = null;
  private readonly sockets = new Set<WebSocket>();

  async start(onFrame: (frame: ProtocolFrame, ctx: InboundContext) => void): Promise<number> {
    this.onFrame = onFrame;
    const portStart = Number(process.env.LANTERN_WS_PORT_START || WS_PORT_START);
    const portEnd = Number(process.env.LANTERN_WS_PORT_END || WS_PORT_END);

    for (let port = portStart; port <= portEnd; port += 1) {
      try {
        const selected = await this.bindPort(port);
        return selected;
      } catch {
        // tenta próxima porta
      }
    }

    // Último fallback: deixa o SO escolher uma porta livre.
    return this.bindPort(0);
  }

  private bindPort(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const httpServer = createServer();
      const wss = new WebSocketServer({ server: httpServer });

      const onError = (error: Error) => {
        wss.close();
        httpServer.close();
        reject(error);
      };

      httpServer.once('error', onError);

      wss.on('connection', (socket, request) => {
        this.sockets.add(socket);
        const remoteAddress = request.socket.remoteAddress || '';

        socket.on('message', (data) => {
          try {
            const text = typeof data === 'string' ? data : data.toString();
            const frame = JSON.parse(text) as ProtocolFrame;
            this.onFrame?.(frame, { socket, remoteAddress });
          } catch {
            // ignora frame inválido
          }
        });

        socket.on('close', () => {
          this.sockets.delete(socket);
        });
      });

      httpServer.listen(port, '0.0.0.0', () => {
        httpServer.removeListener('error', onError);
        this.httpServer = httpServer;
        this.wss = wss;
        const addressInfo = httpServer.address() as AddressInfo;
        resolve(addressInfo.port);
      });
    });
  }

  send(socket: WebSocket, frame: ProtocolFrame): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }

  stop(): void {
    for (const socket of this.sockets) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();
    this.wss?.close();
    this.httpServer?.close();
    this.wss = null;
    this.httpServer = null;
  }
}
