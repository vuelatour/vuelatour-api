// Los servicios reales arrastran Supabase/pyservices/inventario: se
// stubbean; aquí se prueba el CABLEADO HTTP de la descarga del balance de la
// flota (`modo`, nombre del archivo, roles, orden de rutas, 400).
jest.mock('./aircraft.service', () => ({ AircraftService: class {} }));
jest.mock('./aircraft-balance.service', () => ({
  AircraftBalanceService: class {},
}));

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { AircraftBalanceService } from './aircraft-balance.service';
import { AircraftController } from './aircraft.controller';
import { AircraftService } from './aircraft.service';
import { MENSAJE_MODO_BALANCE_INVALIDO } from './balance-general-modo.util';

type Servidor = Parameters<typeof request>[0];
const AVION = 'eeeeeeee-0000-4000-8000-000000000001';
const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const RUTA = '/v1/aircraft/balance-general.xlsx';

/**
 * «Balance mensual» / «Balance general» (6-oct-2026, API 0.0.64):
 * `GET /v1/aircraft/balance-general.xlsx?modo=mensual|general`. Sin `modo`
 * = mensual (el panel previo no lo manda); otro valor = 400; el archivo se
 * llama `balance-<modo>-vuelatour-<desde>-a-<hasta>.xlsx`.
 */
describe('AircraftController — balance de la flota por metadata', () => {
  const proto = AircraftController.prototype as unknown as Record<
    string,
    object
  >;

  it('roles: ADMIN y ANALISTA (los mismos que el libro por avión)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, proto.balanceGeneralXlsx)).toEqual([
      Rol.ADMIN,
      Rol.ANALISTA,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.balanceXlsx)).toEqual([
      Rol.ADMIN,
      Rol.ANALISTA,
    ]);
  });

  it('`balance-general.xlsx` se declara ANTES de las rutas `:id`', () => {
    const rutas = Object.getOwnPropertyNames(proto)
      .filter((m) => m !== 'constructor')
      .map((m) => String(Reflect.getMetadata(PATH_METADATA, proto[m])));
    const primeraConId = rutas.findIndex((r) => r.startsWith(':id'));
    expect(primeraConId).toBeGreaterThanOrEqual(0);
    expect(rutas.indexOf('balance-general.xlsx')).toBeGreaterThanOrEqual(0);
    expect(rutas.indexOf('balance-general.xlsx')).toBeLessThan(primeraConId);
  });
});

describe('AircraftController — GET balance-general.xlsx por HTTP (modo)', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const balance = {
    // Como el servicio real: resuelve el periodo default y devuelve el modo
    // que RECIBIÓ (sin inventar uno: si el controlador no lo pasara, el
    // nombre del archivo lo delataría).
    xlsxGeneral: jest.fn((desde?: string, hasta?: string, modo?: string) =>
      Promise.resolve({
        buffer: Buffer.from('libro'),
        desde: desde ?? '2026-10-01',
        hasta: hasta ?? '2026-10-31',
        modo,
      }),
    ),
    xlsx: jest.fn().mockResolvedValue({
      buffer: Buffer.from('libro'),
      matricula: 'XB-TST',
      desde: '2026-09-01',
      hasta: '2026-09-30',
    }),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;
  const bajar = (query = '') =>
    request(http())
      .get(`${RUTA}${query}`)
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on('data', (c: Buffer) => partes.push(c));
        res.on('end', () => cb(null, Buffer.concat(partes)));
      });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AircraftController],
      providers: [
        { provide: AircraftService, useValue: {} },
        { provide: AircraftBalanceService, useValue: balance },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    // Mismo ValidationPipe que main.ts.
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
      (req as unknown as { user: unknown }).user = {
        userId: 'u-1',
        nombre: 'Mary Cruz',
        rol,
      };
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
    jest.clearAllMocks();
  });

  it('sin `modo` ⇒ «Balance mensual»: el servicio recibe mensual y el archivo es balance-mensual-vuelatour-…', async () => {
    const r = await bajar();
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain(XLSX);
    expect(r.headers['content-disposition']).toBe(
      'attachment; filename="balance-mensual-vuelatour-2026-10-01-a-2026-10-31.xlsx"',
    );
    expect(Buffer.isBuffer(r.body)).toBe(true);
    expect((r.body as Buffer).toString()).toBe('libro');
    expect(balance.xlsxGeneral).toHaveBeenCalledTimes(1);
    expect(balance.xlsxGeneral).toHaveBeenCalledWith(
      undefined,
      undefined,
      'mensual',
    );
  });

  it('`modo=general` ⇒ «Balance general» con el periodo pedido', async () => {
    const r = await bajar('?desde=2026-09-01&hasta=2026-09-30&modo=general');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toBe(
      'attachment; filename="balance-general-vuelatour-2026-09-01-a-2026-09-30.xlsx"',
    );
    expect(balance.xlsxGeneral).toHaveBeenCalledWith(
      '2026-09-01',
      '2026-09-30',
      'general',
    );
  });

  it('`modo=mensual` explícito = lo mismo que sin modo', async () => {
    const r = await bajar('?desde=2026-09-01&hasta=2026-09-30&modo=mensual');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toBe(
      'attachment; filename="balance-mensual-vuelatour-2026-09-01-a-2026-09-30.xlsx"',
    );
    expect(balance.xlsxGeneral).toHaveBeenCalledWith(
      '2026-09-01',
      '2026-09-30',
      'mensual',
    );
  });

  it('cualquier otro `modo` ⇒ 400 con el texto es-MX, sin generar nada', async () => {
    for (const q of [
      '?modo=anual',
      '?modo=GENERAL',
      '?modo=Mensual',
      '?modo=',
      '?modo=%20general',
      '?modo=general&modo=mensual',
    ]) {
      const r = await request(http()).get(`${RUTA}${q}`);
      expect({ q, status: r.status }).toEqual({ q, status: 400 });
      expect(JSON.stringify(r.body)).toContain(MENSAJE_MODO_BALANCE_INVALIDO);
    }
    expect(balance.xlsxGeneral).not.toHaveBeenCalled();
  });

  it('el periodo se valida como siempre y un parámetro desconocido sigue siendo 400', async () => {
    for (const q of [
      '?desde=30-09-2026',
      '?hasta=ayer&modo=general',
      // `variante` es del payload a pyservices, no de la URL.
      '?modo=general&variante=general',
      // Con el parser de query de Express 5, `modo[]` es OTRA llave.
      '?modo[]=general',
      '?otro=1',
    ]) {
      const r = await request(http()).get(`${RUTA}${q}`);
      expect({ q, status: r.status }).toEqual({ q, status: 400 });
    }
    expect(balance.xlsxGeneral).not.toHaveBeenCalled();
  });

  it('ANALISTA descarga; COORDINADOR, FACTURACION, SOCIO, PILOTO y VISITANTE ⇒ 403', async () => {
    rol = Rol.ANALISTA;
    expect((await bajar('?modo=general')).status).toBe(200);
    for (const r of [
      Rol.COORDINADOR,
      Rol.FACTURACION,
      Rol.SOCIO,
      Rol.PILOTO,
      Rol.VISITANTE,
    ]) {
      rol = r;
      const res = await request(http()).get(`${RUTA}?modo=general`);
      expect({ rol: r, status: res.status }).toEqual({ rol: r, status: 403 });
    }
    expect(balance.xlsxGeneral).toHaveBeenCalledTimes(1);
  });

  it('el libro de UN avión no tiene modos: `?modo=` ahí es 400 y sin él sigue igual', async () => {
    const conModo = await request(http()).get(
      `/v1/aircraft/${AVION}/balance.xlsx?modo=general`,
    );
    expect(conModo.status).toBe(400);
    expect(balance.xlsx).not.toHaveBeenCalled();
    const sinModo = await request(http())
      .get(`/v1/aircraft/${AVION}/balance.xlsx?desde=2026-09-01`)
      .buffer(true)
      .parse((res, cb) => {
        res.on('data', () => undefined);
        res.on('end', () => cb(null, null));
      });
    expect(sinModo.status).toBe(200);
    expect(sinModo.headers['content-disposition']).toBe(
      'attachment; filename="balance-XB-TST-2026-09-01-a-2026-09-30.xlsx"',
    );
    expect(balance.xlsx).toHaveBeenCalledWith(AVION, '2026-09-01', undefined);
  });
});
