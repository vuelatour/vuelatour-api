export enum Rol {
  /**
   * DIRECCIÓN (6-nov-2026, invariante 122): superusuario (Ale y Pablo
   * Canales). Pasa cualquier `@Roles` (RolesGuard) y ve lo que ADMIN
   * («Administración») ya no: Estadísticas, Ingresos, Nómina, Gastos
   * personales, Reparto de utilidades, Pagos a socios, el dinero del avión
   * y la caja chica de Dirección. Reglas: `common/roles.util.ts`.
   */
  DIRECCION = 'DIRECCION',
  /** Administración (la oficina). Antes «acceso total»; ver invariante 122. */
  ADMIN = 'ADMIN',
  COORDINADOR = 'COORDINADOR',
  ANALISTA = 'ANALISTA',
  FACTURACION = 'FACTURACION',
  PILOTO = 'PILOTO',
  SOCIO = 'SOCIO',
  MECANICO = 'MECANICO',
  /** Visitante de trabajo (27-ago): SOLO registra gastos desde la app
   *  (fondo de caja + tarjeta); cero acceso a vuelos y ve solo lo propio. */
  VISITANTE = 'VISITANTE',
}

export enum EstadoUsuario {
  ACTIVO = 'ACTIVO',
  INACTIVO = 'INACTIVO',
  INVITADO = 'INVITADO',
}

export interface AuthenticatedUser {
  authId: string;
  userId: string;
  email: string;
  nombre: string;
  rol: Rol;
  estado: EstadoUsuario;
  jwt: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      requestId?: string;
    }
  }
}
