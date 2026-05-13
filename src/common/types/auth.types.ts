export enum Rol {
  ADMIN = 'ADMIN',
  COORDINADOR = 'COORDINADOR',
  ANALISTA = 'ANALISTA',
  FACTURACION = 'FACTURACION',
  PILOTO = 'PILOTO',
  SOCIO = 'SOCIO',
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
