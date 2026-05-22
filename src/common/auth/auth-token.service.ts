import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { EstadoUsuario, Rol } from '../types/auth.types';
import type { AuthenticatedUser } from '../types/auth.types';
import { SupabaseService } from '../../modules/supabase/supabase.service';
import type { EnvVars } from '../../config/env.schema';

export interface SupabaseJwtPayload extends JWTPayload {
  sub: string;
  email?: string;
  role?: string;
}

/**
 * Verificación de tokens Supabase + resolución del usuario de la app.
 * Compartido por el AuthGuard (HTTP) y el gateway de Socket.IO (handshake), para
 * que ambos validen exactamente igual.
 */
@Injectable()
export class AuthTokenService {
  private readonly logger = new Logger(AuthTokenService.name);
  private readonly jwks: JWTVerifyGetKey;
  private readonly legacyHs256Secret?: Uint8Array;

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly supabase: SupabaseService,
  ) {
    const supabaseUrl = this.config.get('SUPABASE_URL', { infer: true });
    this.jwks = createRemoteJWKSet(
      new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
    );
    const legacySecret = this.config.get('SUPABASE_JWT_LEGACY_SECRET', { infer: true });
    if (legacySecret) {
      this.legacyHs256Secret = new TextEncoder().encode(legacySecret);
    }
  }

  async verify(token: string): Promise<SupabaseJwtPayload> {
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
      } catch (e) {
        this.logger.debug({ err: e }, 'HS256 verification failed');
        throw new UnauthorizedException('Invalid or expired token');
      }
    }

    try {
      const { payload } = await jwtVerify<SupabaseJwtPayload>(token, this.jwks);
      return payload;
    } catch (e) {
      this.logger.debug({ err: e }, 'JWKS verification failed');
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /** Verifica el token y resuelve el usuario ACTIVO de la app. */
  async resolveUser(token: string): Promise<AuthenticatedUser> {
    const payload = await this.verify(token);
    const { data, error } = await this.supabase.service
      .from('usuario')
      .select('id, supabase_auth_id, email, nombre, rol, estado')
      .eq('supabase_auth_id', payload.sub)
      .maybeSingle();

    if (error) throw new UnauthorizedException(`User lookup failed: ${error.message}`);
    if (!data) throw new UnauthorizedException('User not provisioned in application');
    if (data.estado !== EstadoUsuario.ACTIVO) {
      throw new UnauthorizedException(`User account is ${data.estado}`);
    }

    return {
      authId: data.supabase_auth_id,
      userId: data.id,
      email: data.email,
      nombre: data.nombre,
      rol: data.rol as Rol,
      estado: data.estado as EstadoUsuario,
      jwt: token,
    };
  }
}
