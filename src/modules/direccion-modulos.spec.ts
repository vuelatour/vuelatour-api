/**
 * DIRECCIÓN Y ADMINISTRACIÓN — LA MATRIZ DE MÓDULOS (6-nov-2026, API
 * 0.0.126, invariante 122). Pedido del dueño: un rol «Dirección» (Ale y
 * Pablo) con todo, y ADMIN = «Administración» sin Estadísticas, Ingresos,
 * Nómina, Gastos personales, Reparto de utilidades ni Pagos a socios.
 *
 * Aquí se congela lo que decide el API:
 *  - RolesGuard: DIRECCION pasa cualquier `@Roles`; ADMIN no pasa uno que
 *    nombre solo a DIRECCION.
 *  - Las rutas SOLO de Dirección ya no nombran a ADMIN; las que Reportes,
 *    Inicio y Conciliación siguen usando lo conservan.
 */
// Solo se lee METADATA: los servicios se simulan para no arrastrar ESM (jose).
jest.mock('./aircraft/aircraft.service', () => ({ AircraftService: class {} }));
jest.mock('./aircraft/aircraft-balance.service', () => ({
  AircraftBalanceService: class {},
}));
jest.mock('./configuracion/configuracion.service', () => ({
  ConfiguracionService: class {},
}));
jest.mock('./ia-uso/ia-uso.service', () => ({ IaUsoService: class {} }));
jest.mock('./pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('./dashboards/dashboards.service', () => ({
  DashboardsService: class {},
}));
jest.mock('./expenses/expenses.service', () => ({ ExpensesService: class {} }));
jest.mock('./expenses/combustible-masivo.service', () => ({
  CombustibleMasivoService: class {},
}));
jest.mock('./ingresos/ingresos.service', () => ({ IngresosService: class {} }));
jest.mock('./profit-sharing/profit-sharing.service', () => ({
  ProfitSharingService: class {},
}));
jest.mock('./profit-sharing/dinero-report.service', () => ({
  DineroReportService: class {},
}));
jest.mock('./profit-sharing/reparto-cuenta.service', () => ({
  RepartoCuentaService: class {},
}));
jest.mock('./profit-sharing/reparto-pago.service', () => ({
  RepartoPagoService: class {},
}));
jest.mock('./users/users.service', () => ({ UsersService: class {} }));
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../common/guards/roles.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { Rol } from '../common/types/auth.types';
import { AircraftController } from './aircraft/aircraft.controller';
import { ConfiguracionController } from './configuracion/configuracion.controller';
import { DashboardsController } from './dashboards/dashboards.controller';
import { ExpensesController } from './expenses/expenses.controller';
import {
  IngresosController,
  ROLES_CONCILIAR,
  ROLES_INGRESOS,
  ROLES_PANTALLA_INGRESOS,
} from './ingresos/ingresos.controller';
import { ProfitSharingController } from './profit-sharing/profit-sharing.controller';
import {
  ROLES_PAGOS_SOCIOS_ESCRITURA,
  ROLES_PAGOS_SOCIOS_LECTURA,
} from './profit-sharing/reparto-pago.util';
import { UsersController } from './users/users.controller';

const roles = (controller: object, metodo: string): Rol[] | undefined =>
  Reflect.getMetadata(
    ROLES_KEY,
    (controller as { prototype: Record<string, object> }).prototype[metodo],
  ) as Rol[] | undefined;

describe('RolesGuard — Dirección es superconjunto de ADMIN', () => {
  const guard = new RolesGuard(new Reflector());
  const soloAdmin = () => undefined;
  Reflect.defineMetadata(ROLES_KEY, [Rol.ADMIN], soloAdmin);
  const soloDireccion = () => undefined;
  Reflect.defineMetadata(ROLES_KEY, [Rol.DIRECCION], soloDireccion);
  const abierto = () => undefined;

  const contexto = (
    rol: Rol | undefined,
    handler: object,
    path = '/v1/aircraft',
  ): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => class Vacia {},
      switchToHttp: () => ({
        getRequest: () => ({ user: rol ? { rol } : undefined, path }),
      }),
    }) as unknown as ExecutionContext;

  it('DIRECCION pasa @Roles(ADMIN) y las rutas abiertas; ADMIN no pasa @Roles(DIRECCION)', () => {
    expect(guard.canActivate(contexto(Rol.DIRECCION, soloAdmin))).toBe(true);
    expect(guard.canActivate(contexto(Rol.DIRECCION, soloDireccion))).toBe(
      true,
    );
    expect(guard.canActivate(contexto(Rol.DIRECCION, abierto))).toBe(true);
    expect(guard.canActivate(contexto(Rol.ADMIN, soloAdmin))).toBe(true);
    expect(() => guard.canActivate(contexto(Rol.ADMIN, soloDireccion))).toThrow(
      ForbiddenException,
    );
    expect(() =>
      guard.canActivate(contexto(Rol.COORDINADOR, soloAdmin)),
    ).toThrow(ForbiddenException);
  });

  it('el VISITANTE sigue con su superficie mínima (no cambia)', () => {
    expect(guard.canActivate(contexto(Rol.VISITANTE, abierto, '/v1/me'))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(contexto(Rol.VISITANTE, abierto, '/v1/aircraft')),
    ).toThrow(ForbiddenException);
  });
});

describe('Módulos SOLO de Dirección: ADMIN salió de sus @Roles', () => {
  it('Estadísticas: finanzas, gastos y tarjetas; operativo y horas de piloto siguen (Inicio y Reportes)', () => {
    expect(roles(DashboardsController, 'overview')).toEqual([
      Rol.DIRECCION,
      Rol.ANALISTA,
      Rol.SOCIO,
    ]);
    expect(roles(DashboardsController, 'gastos')).toEqual([
      Rol.DIRECCION,
      Rol.ANALISTA,
    ]);
    expect(roles(DashboardsController, 'tarjetas')).toEqual([Rol.DIRECCION]);
    expect(roles(DashboardsController, 'operativo')).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
    ]);
    expect(roles(DashboardsController, 'horasPiloto')).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
    ]);
  });

  it('Ingresos: la pantalla es ROLES_PANTALLA_INGRESOS; lo que usa Conciliación hereda la clase (con ADMIN)', () => {
    expect(ROLES_PANTALLA_INGRESOS).toEqual([
      Rol.DIRECCION,
      Rol.COORDINADOR,
      Rol.FACTURACION,
    ]);
    expect(ROLES_INGRESOS).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
    ]);
    expect(ROLES_CONCILIAR).toEqual([Rol.ADMIN, Rol.FACTURACION]);
    for (const m of [
      'resumen',
      'entradas',
      'exportXlsx',
      'lista',
      'crear',
      'obtener',
      'editar',
      'baja',
      'aplicar',
    ]) {
      expect(roles(IngresosController, m)).toEqual(ROLES_PANTALLA_INGRESOS);
    }
    for (const m of ['vuelosCandidatos', 'archivoUrl', 'quitarArchivo']) {
      expect(roles(IngresosController, m)).toBeUndefined();
    }
    expect(roles(IngresosController, 'cobroDeVuelo')).toEqual(ROLES_CONCILIAR);
    expect(roles(IngresosController, 'desaplicar')).toEqual(ROLES_CONCILIAR);
    expect(Reflect.getMetadata(ROLES_KEY, IngresosController)).toEqual(
      ROLES_INGRESOS,
    );
  });

  it('Reparto de utilidades y la pantalla por avión; pdf/xlsx/dinero y pre-cierre siguen con ADMIN (Reportes)', () => {
    expect(roles(ProfitSharingController, 'compute')).toEqual([
      Rol.DIRECCION,
      Rol.ANALISTA,
      Rol.SOCIO,
    ]);
    for (const m of ['avionDetalle', 'avionHistorico']) {
      expect(roles(ProfitSharingController, m)).toEqual([
        Rol.DIRECCION,
        Rol.ANALISTA,
        Rol.FACTURACION,
        Rol.SOCIO,
      ]);
    }
    expect(roles(ProfitSharingController, 'pdf')).toEqual([
      Rol.ADMIN,
      Rol.ANALISTA,
      Rol.SOCIO,
    ]);
    expect(roles(ProfitSharingController, 'xlsx')).toEqual([
      Rol.ADMIN,
      Rol.ANALISTA,
    ]);
    expect(roles(ProfitSharingController, 'dineroXlsx')).toEqual([
      Rol.ADMIN,
      Rol.ANALISTA,
    ]);
    expect(roles(ProfitSharingController, 'preCierre')).toContain(Rol.ADMIN);
  });

  it('Pagos a socios: leen Dirección, ANALISTA, FACTURACION y SOCIO; escriben Dirección y FACTURACION', () => {
    expect(ROLES_PAGOS_SOCIOS_LECTURA).toEqual([
      Rol.DIRECCION,
      Rol.ANALISTA,
      Rol.FACTURACION,
      Rol.SOCIO,
    ]);
    expect(ROLES_PAGOS_SOCIOS_ESCRITURA).toEqual([
      Rol.DIRECCION,
      Rol.FACTURACION,
    ]);
    expect(roles(ProfitSharingController, 'resumenCuentasSocios')).toEqual(
      ROLES_PAGOS_SOCIOS_LECTURA,
    );
    expect(roles(ProfitSharingController, 'crearPagoSocio')).toEqual(
      ROLES_PAGOS_SOCIOS_ESCRITURA,
    );
  });

  it('Nómina: el reparto en partes iguales es de Dirección, Coordinación y Facturación; Administración pasa el @Roles solo para el acceso por persona (invariante 132: sin él, 403 en el handler); el masivo de Otros gastos no cambia', () => {
    expect(roles(ExpensesController, 'repartoIguales')).toEqual([
      Rol.DIRECCION,
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
    ]);
    expect(roles(ExpensesController, 'repartoMasivo')).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
    ]);
  });

  it('Acceso a Nómina por persona (invariante 132): Administración lee la lista; SOLO Dirección la cambia', () => {
    expect(roles(ConfiguracionController, 'accesoNomina')).toEqual([Rol.ADMIN]);
    expect(roles(ConfiguracionController, 'setAccesoNomina')).toEqual([
      Rol.DIRECCION,
    ]);
  });

  it('lo que Administración conserva no se tocó: métricas del avión (solo gastos), usuarios, balances', () => {
    expect(roles(AircraftController, 'metrics')).toEqual([
      Rol.ADMIN,
      Rol.ANALISTA,
      Rol.SOCIO,
    ]);
    expect(roles(AircraftController, 'getOne')).toBeUndefined();
    expect(roles(UsersController, 'list')).toEqual([Rol.ADMIN]);
    expect(roles(UsersController, 'create')).toEqual([Rol.ADMIN]);
  });
});
