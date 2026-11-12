/**
 * NÓMINA Y GASTOS PERSONALES SOLO DE DIRECCIÓN (6-nov-2026, invariante 122).
 * Administración (ADMIN) no lista ni exporta las categorías NOMINA y
 * PERSONAL_DUENO (sus módulos no los ve); el resto de categorías y el resto
 * de roles siguen como antes. HTTP real: ValidationPipe, filtro y RolesGuard.
 *
 * ACCESO A NÓMINA POR PERSONA (12-nov-2026, invariante 132): la NÓMINA sí se
 * le abre a quien de Administración tenga el acceso que da Dirección en
 * Configuración (lista `acceso_nomina`); los gastos personales, nunca.
 */
// Los servicios se simulan: importarlos arrastra dependencias ESM (jose).
jest.mock('./expenses.service', () => ({ ExpensesService: class {} }));
jest.mock('./combustible-masivo.service', () => ({
  CombustibleMasivoService: class {},
}));
import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import {
  CODIGO_CATEGORIA_SOLO_DIRECCION,
  MENSAJE_CATEGORIA_SOLO_DIRECCION,
  MENSAJE_NOMINA_SIN_ACCESO,
} from '../../common/roles.util';
import { Rol } from '../../common/types/auth.types';
import { CombustibleMasivoService } from './combustible-masivo.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

type Servidor = Parameters<typeof request>[0];
type Cuerpo = { code?: string; message?: string };

const MARY = 'e0b26729-1f02-4dc0-9c1a-e7192e638478';
const G1 = '0f5e6659-2c39-40d0-89d5-3fbd8d98537d';
const N41 = '5a82eb4a-086c-4058-97bd-b2aacdc2e942';

describe('ExpensesController — categorías solo de Dirección', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    list: jest.fn(),
    listXlsx: jest.fn(),
    putRepartoIguales: jest.fn(),
    /** ¿Dirección le dio el acceso a Nómina? (lista `acceso_nomina`). */
    tieneAccesoNomina: jest.fn(),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ExpensesController],
      providers: [
        { provide: ExpensesService, useValue: svc },
        { provide: CombustibleMasivoService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { user: unknown }).user = { userId: MARY, rol };
      next();
    });
    app.useGlobalGuards(new RolesGuard(new Reflector()));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    rol = Rol.ADMIN;
    svc.list.mockReset();
    svc.listXlsx.mockReset();
    svc.putRepartoIguales.mockReset();
    svc.tieneAccesoNomina.mockReset();
    svc.list.mockResolvedValue({ data: [], count: 0, limit: 50, offset: 0 });
    svc.listXlsx.mockResolvedValue(Buffer.from('xlsx'));
    svc.putRepartoIguales.mockResolvedValue({ aplicados: 0, errores: 0 });
    // Por defecto NADIE de Administración tiene el acceso (como el 0.0.136).
    svc.tieneAccesoNomina.mockResolvedValue(false);
  });

  it('Administración SIN el acceso: NOMINA y PERSONAL_DUENO ⇒ 403 CATEGORIA_SOLO_DIRECCION sin tocar el servicio', async () => {
    const mensajes: Record<string, string> = {
      // A quien le falta el acceso se le dice a quién pedírselo y dónde.
      NOMINA: MENSAJE_NOMINA_SIN_ACCESO,
      PERSONAL_DUENO: MENSAJE_CATEGORIA_SOLO_DIRECCION,
    };
    for (const cat of ['NOMINA', 'PERSONAL_DUENO']) {
      const lista = await request(http()).get(`/v1/expenses?categoria=${cat}`);
      expect(lista.status).toBe(403);
      expect((lista.body as Cuerpo).code).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
      expect((lista.body as Cuerpo).message).toBe(mensajes[cat]);
      const excel = await request(http()).get(
        `/v1/expenses/export?categoria=${cat}`,
      );
      expect(excel.status).toBe(403);
      expect((excel.body as Cuerpo).code).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
      expect((excel.body as Cuerpo).message).toBe(mensajes[cat]);
    }
    expect(svc.list).not.toHaveBeenCalled();
    expect(svc.listXlsx).not.toHaveBeenCalled();
    expect(MENSAJE_NOMINA_SIN_ACCESO).toContain('Acceso a Nómina');
  });

  it('Administración CON el acceso por persona (invariante 132): lista y exporta la NÓMINA; los gastos personales siguen vedados', async () => {
    svc.tieneAccesoNomina.mockResolvedValue(true);
    expect(
      (await request(http()).get('/v1/expenses?categoria=NOMINA')).status,
    ).toBe(200);
    expect(
      (await request(http()).get('/v1/expenses/export?categoria=NOMINA'))
        .status,
    ).toBe(200);
    expect(svc.list).toHaveBeenCalledTimes(1);
    expect(svc.listXlsx).toHaveBeenCalledTimes(1);
    // La lista se consultó con QUIEN pide (permiso por persona, no por rol).
    expect(svc.tieneAccesoNomina).toHaveBeenCalledTimes(2);
    expect(svc.tieneAccesoNomina).toHaveBeenLastCalledWith(MARY);

    svc.tieneAccesoNomina.mockClear();
    for (const ruta of ['/v1/expenses', '/v1/expenses/export']) {
      const r = await request(http()).get(`${ruta}?categoria=PERSONAL_DUENO`);
      expect(r.status).toBe(403);
      expect((r.body as Cuerpo).message).toBe(MENSAJE_CATEGORIA_SOLO_DIRECCION);
    }
    // Para los gastos personales ni se pregunta: el acceso no los abre.
    expect(svc.tieneAccesoNomina).not.toHaveBeenCalled();
    expect(svc.list).toHaveBeenCalledTimes(1);
  });

  it('Administración: las demás categorías y la lista sin categoría siguen abiertas (sin consultar el acceso)', async () => {
    expect(
      (await request(http()).get('/v1/expenses?categoria=GAS')).status,
    ).toBe(200);
    expect((await request(http()).get('/v1/expenses')).status).toBe(200);
    expect(
      (await request(http()).get('/v1/expenses/export?categoria=GAS')).status,
    ).toBe(200);
    expect(svc.list).toHaveBeenCalledTimes(2);
    expect(svc.listXlsx).toHaveBeenCalledTimes(1);
    expect(svc.tieneAccesoNomina).not.toHaveBeenCalled();
  });

  it('Dirección, COORDINADOR y FACTURACION siguen leyendo la nómina por su rol (sin consultar el acceso)', async () => {
    for (const r of [Rol.DIRECCION, Rol.COORDINADOR, Rol.FACTURACION]) {
      rol = r;
      const res = await request(http()).get('/v1/expenses?categoria=NOMINA');
      expect(res.status).toBe(200);
    }
    expect(svc.list).toHaveBeenCalledTimes(3);
    expect(svc.tieneAccesoNomina).not.toHaveBeenCalled();
  });

  it('reparto-iguales (el reparto de la NÓMINA): Administración solo con el acceso por persona; sin él ⇒ 403 CATEGORIA_SOLO_DIRECCION sin tocar el servicio', async () => {
    const cuerpo = { gasto_ids: [G1], aeronave_ids: [N41] };
    const sin = await request(http())
      .post('/v1/expenses/reparto-iguales')
      .send(cuerpo);
    expect(sin.status).toBe(403);
    expect((sin.body as Cuerpo).code).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
    expect((sin.body as Cuerpo).message).toBe(MENSAJE_NOMINA_SIN_ACCESO);
    expect(svc.putRepartoIguales).not.toHaveBeenCalled();

    svc.tieneAccesoNomina.mockResolvedValue(true);
    const con = await request(http())
      .post('/v1/expenses/reparto-iguales')
      .send(cuerpo);
    expect(con.status).toBe(200);
    expect(svc.putRepartoIguales).toHaveBeenCalledWith(cuerpo, MARY);
  });

  it('@Roles de reparto-iguales: Dirección, Administración (solo con el acceso, arriba), COORDINADOR y FACTURACION; el masivo no cambia', () => {
    const roles = (metodo: string) =>
      Reflect.getMetadata(
        ROLES_KEY,
        Object.getOwnPropertyDescriptor(ExpensesController.prototype, metodo)!
          .value as object,
      ) as Rol[];
    expect(roles('repartoIguales')).toEqual([
      Rol.DIRECCION,
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
    ]);
    expect(roles('repartoMasivo')).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
    ]);
  });
});
