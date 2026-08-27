import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { Rol } from '../types/auth.types';

/**
 * Superficie mínima del VISITANTE (27-ago): este guard es default-ABIERTO
 * (sin @Roles pasa cualquier rol autenticado) — correcto para el equipo,
 * pero el visitante es un rol de mínimo privilegio para gente EXTERNA: con
 * el default abierto alcanzaba flota, tarjetas, proveedores y emisoras
 * (verificación adversarial 27-ago). Para él, el default se INVIERTE: sin
 * @Roles solo pasan las rutas de esta lista (todas con filtro "solo lo
 * suyo" en su handler); con @Roles debe incluirlo explícitamente.
 */
const VISITANTE_PREFIJOS = [
  '/v1/me', // perfil propio y descansos propios
  '/v1/expenses', // list/getOne fuerzan usuario_captura_id = él
  '/v1/caja-chica', // solo /me va sin @Roles (su fondo)
  '/v1/devices', // registro del token push al iniciar sesión
  '/v1/config', // banderas de sistema (apertura intencional)
  '/v1/health',
];

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Rol[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const req = context.switchToHttp().getRequest<Request>();

    if (req.user?.rol === Rol.VISITANTE && (!required || !required.length)) {
      const path = req.path;
      const permitido = VISITANTE_PREFIJOS.some(
        (p) => path === p || path.startsWith(`${p}/`),
      );
      if (!permitido) {
        throw new ForbiddenException(
          'Tu cuenta de visitante solo registra gastos: usa la app móvil.',
        );
      }
      return true;
    }

    if (!required || required.length === 0) return true;

    const user = req.user;
    if (!user) {
      throw new ForbiddenException('Authenticated user required');
    }

    if (!required.includes(user.rol)) {
      throw new ForbiddenException(
        `Required role: ${required.join(' | ')}. Current: ${user.rol}`,
      );
    }
    return true;
  }
}
