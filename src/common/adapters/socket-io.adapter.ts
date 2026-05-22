import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Adaptador Socket.IO con CORS desde configuración (SOCKET_CORS_ORIGINS, con
 * fallback a CORS_ORIGINS). Lista vacía = se permite cualquier origen (dev).
 */
export class ConfiguredIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly corsOrigins: string[],
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const cors = {
      origin: this.corsOrigins.length > 0 ? this.corsOrigins : true,
      credentials: true,
    };
    return super.createIOServer(port, { ...options, cors }) as Server;
  }
}
