import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AuthTokenService } from '../../common/auth/auth-token.service';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { Rol } from '../../common/types/auth.types';

export const userRoom = (userId: string) => `user:${userId}`;
export const roleRoom = (rol: Rol | string) => `role:${rol}`;
export const quoteRoom = (quoteId: string) => `quote:${quoteId}`;

@WebSocketGateway()
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(private readonly auth: AuthTokenService) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      client.emit('unauthorized', { message: 'Falta token de acceso' });
      client.disconnect(true);
      return;
    }
    try {
      const user = await this.auth.resolveUser(token);
      client.data.user = user;
      client.join(userRoom(user.userId));
      client.join(roleRoom(user.rol));
      client.emit('connected', { userId: user.userId, rol: user.rol });
      this.logger.log(`Socket ${client.id} conectado · ${user.email} (${user.rol})`);
    } catch {
      client.emit('unauthorized', { message: 'Token inválido o expirado' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const user = client.data.user as AuthenticatedUser | undefined;
    if (user) this.logger.debug(`Socket ${client.id} desconectado · ${user.email}`);
  }

  emitToUser(userId: string, event: string, payload: unknown): void {
    this.server.to(userRoom(userId)).emit(event, payload);
  }

  emitToRole(rol: Rol | string, event: string, payload: unknown): void {
    this.server.to(roleRoom(rol)).emit(event, payload);
  }

  /** Token desde handshake.auth.token, header Authorization o query ?token=. */
  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as { token?: string } | undefined;
    if (auth?.token) return auth.token.replace(/^Bearer\s+/i, '');

    const header = client.handshake.headers.authorization;
    if (header) {
      const [scheme, value] = header.split(' ');
      if (scheme?.toLowerCase() === 'bearer' && value) return value;
    }

    const q = client.handshake.query?.token;
    if (typeof q === 'string' && q) return q;
    return null;
  }
}
