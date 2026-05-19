import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { EstadoUsuario, Rol } from '../types/auth.types';
import type { AuthenticatedUser } from '../types/auth.types';
import { SupabaseService } from '../../modules/supabase/supabase.service';
import type { EnvVars } from '../../config/env.schema';

interface SupabaseJwtPayload extends JWTPayload {
  sub: string;
  email?: string;
  role?: string;
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private readonly jwks: JWTVerifyGetKey;
  private readonly legacyHs256Secret?: Uint8Array;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService<EnvVars, true>,
    private readonly supabase: SupabaseService,
  ) {
    const supabaseUrl = this.config.get('SUPABASE_URL', { infer: true });
    this.jwks = createRemoteJWKSet(
      new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
    );

    const legacySecret = this.config.get('SUPABASE_JWT_LEGACY_SECRET', {
      infer: true,
    });
    if (legacySecret) {
      this.legacyHs256Secret = new TextEncoder().encode(legacySecret);
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(req);
    if (!token) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    const payload = await this.verify(token);

    const { data, error } = await this.supabase.service
      .from('usuario')
      .select('id, supabase_auth_id, email, nombre, rol, estado')
      .eq('supabase_auth_id', payload.sub)
      .maybeSingle();

    if (error) {
      throw new UnauthorizedException(`User lookup failed: ${error.message}`);
    }
    if (!data) {
      throw new UnauthorizedException('User not provisioned in application');
    }
    const u: {
      id: string;
      supabase_auth_id: string | null;
      email: string;
      nombre: string;
      rol: Rol;
      estado: EstadoUsuario;
    } = data;
    if (u.estado !== EstadoUsuario.ACTIVO) {
      throw new UnauthorizedException(`User account is ${u.estado}`);
    }

    req.user = {
      authId: payload.sub,
      userId: u.id,
      email: u.email,
      nombre: u.nombre,
      rol: u.rol,
      estado: u.estado,
      jwt: token,
    } satisfies AuthenticatedUser;
    return true;
  }

  private async verify(token: string): Promise<SupabaseJwtPayload> {
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw new UnauthorizedException('Malformed token');
    }

    if (alg === 'HS256') {
      if (!this.legacyHs256Secret) {
        throw new UnauthorizedException(
          'Token signed with legacy HS256 but SUPABASE_JWT_LEGACY_SECRET is not configured',
        );
      }
      try {
        const { payload } = await jwtVerify<SupabaseJwtPayload>(
          token,
          this.legacyHs256Secret,
          { algorithms: ['HS256'] },
        );
        return payload;
      } catch (e: unknown) {
        this.logger.debug({ err: e }, 'HS256 verification failed');
        throw new UnauthorizedException('Invalid or expired token');
      }
    }

    try {
      const { payload } = await jwtVerify<SupabaseJwtPayload>(token, this.jwks);
      return payload;
    } catch (e: unknown) {
      this.logger.debug({ err: e }, 'JWKS verification failed');
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
    return value;
  }
}
