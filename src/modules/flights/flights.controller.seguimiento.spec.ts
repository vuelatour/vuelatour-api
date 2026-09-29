// Cableado HTTP REAL del SEGUIMIENTO DE LA COTIZACIÓN (29-sep-2026):
// ValidationPipe de main.ts (whitelist + forbidNonWhitelisted) +
// AllExceptionsFilter + versionado URI + RolesGuard. Los servicios pesados se
// stubbean (notifications/jose, calendar/googleapis).
jest.mock('./flights.service', () => ({ FlightsService: class {} }));
jest.mock('./flight-report.service', () => ({
  FlightReportService: class {},
}));
jest.mock('./cobro-recibo.service', () => ({ CobroReciboService: class {} }));
jest.mock('./factura-solicitud.service', () => ({
  FacturaSolicitudService: class {},
}));

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { CobroReciboService } from './cobro-recibo.service';
import { FacturaClienteService } from './factura-cliente.service';
import { FlightReportService } from './flight-report.service';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';
import { VueloSeguimientoService } from './vuelo-seguimiento.service';
import {
  ROLES_SEGUIMIENTO_ESCRITURA,
  ROLES_SEGUIMIENTO_LECTURA,
} from './vuelo-seguimiento.util';

const V358 = 'aaaaaaaa-0000-4000-8000-000000000358';
const NOTA = 'bbbbbbbb-0000-4000-8000-000000000001';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';

type Servidor = Parameters<typeof request>[0];

describe('FlightsController — seguimiento: @Roles en CADA ruta', () => {
  const proto = FlightsController.prototype as unknown as Record<
    string,
    object
  >;
  it.each([
    ['listarSeguimiento', ROLES_SEGUIMIENTO_LECTURA],
    ['crearSeguimiento', ROLES_SEGUIMIENTO_ESCRITURA],
    ['actualizarSeguimiento', ROLES_SEGUIMIENTO_ESCRITURA],
    ['eliminarSeguimiento', ROLES_SEGUIMIENTO_ESCRITURA],
  ])('%s', (metodo, roles) => {
    expect(Reflect.getMetadata(ROLES_KEY, proto[metodo])).toEqual([...roles]);
  });
});

describe('FlightsController — seguimiento de la cotización por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const listar = jest.fn();
  const crear = jest.fn();
  const actualizar = jest.fn();
  const eliminar = jest.fn();
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FlightsController],
      providers: [
        { provide: FlightsService, useValue: {} },
        { provide: FlightReportService, useValue: {} },
        { provide: CobroReciboService, useValue: {} },
        { provide: FacturaClienteService, useValue: {} },
        {
          provide: VueloSeguimientoService,
          useValue: { listar, crear, actualizar, eliminar },
        },
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
      (req as unknown as { user: unknown }).user = { userId: USER, rol };
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
    for (const f of [listar, crear, actualizar, eliminar]) f.mockReset();
    listar.mockResolvedValue([]);
    crear.mockResolvedValue({ id: NOTA, estado: 'PENDIENTE' });
    actualizar.mockResolvedValue({ id: NOTA, estado: 'RESUELTA' });
    eliminar.mockResolvedValue({ ok: true, id: NOTA, vuelo_id: V358 });
  });

  it('GET lista del vuelo (SOCIO y ANALISTA también leen)', async () => {
    for (const r of [Rol.ADMIN, Rol.SOCIO, Rol.ANALISTA]) {
      rol = r;
      const res = await request(http()).get(`/v1/flights/${V358}/seguimiento`);
      expect(res.status).toBe(200);
    }
    expect(listar).toHaveBeenCalledWith(V358);
  });

  it('GET: la tripulación y el visitante NO leen (403)', async () => {
    for (const r of [Rol.PILOTO, Rol.MECANICO, Rol.VISITANTE]) {
      rol = r;
      const res = await request(http()).get(`/v1/flights/${V358}/seguimiento`);
      expect(res.status).toBe(403);
    }
    expect(listar).not.toHaveBeenCalled();
  });

  it('POST → 201 y el service recibe (vuelo, dto recortado, userId)', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V358}/seguimiento`)
      .send({
        texto: '  Los pax pidieron transporte terrestre  ',
        afecta_cotizacion: true,
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: NOTA, estado: 'PENDIENTE' });
    expect(crear).toHaveBeenCalledWith(
      V358,
      {
        texto: 'Los pax pidieron transporte terrestre',
        afecta_cotizacion: true,
      },
      USER,
    );
  });

  it('POST: SOCIO/ANALISTA/PILOTO no escriben (403)', async () => {
    for (const r of [Rol.SOCIO, Rol.ANALISTA, Rol.PILOTO]) {
      rol = r;
      const res = await request(http())
        .post(`/v1/flights/${V358}/seguimiento`)
        .send({ texto: 'x' });
      expect(res.status).toBe(403);
    }
    expect(crear).not.toHaveBeenCalled();
  });

  it('POST inválido ⇒ 400 sin tocar el service (vacío, en blanco, 1001, campo extra, id no uuid)', async () => {
    const casos: Array<[string, Record<string, unknown>]> = [
      [`/v1/flights/${V358}/seguimiento`, {}],
      [`/v1/flights/${V358}/seguimiento`, { texto: '   ' }],
      [`/v1/flights/${V358}/seguimiento`, { texto: 'x'.repeat(1001) }],
      [`/v1/flights/${V358}/seguimiento`, { texto: 'x', estado: 'RESUELTA' }],
      [
        `/v1/flights/${V358}/seguimiento`,
        { texto: 'x', afecta_cotizacion: 'si' },
      ],
      // 'false' en texto NO se vuelve true (enableImplicitConversion).
      [
        `/v1/flights/${V358}/seguimiento`,
        { texto: 'x', afecta_cotizacion: 'false' },
      ],
      ['/v1/flights/no-es-uuid/seguimiento', { texto: 'x' }],
    ];
    for (const [url, body] of casos) {
      const res = await request(http()).post(url).send(body);
      expect([url, body, res.status]).toEqual([url, body, 400]);
    }
    expect(crear).not.toHaveBeenCalled();
  });

  it('PATCH por NOTA llega a `actualizar` (no a PATCH /flights/:id)', async () => {
    const res = await request(http())
      .patch(`/v1/flights/seguimiento/${NOTA}`)
      .send({ estado: 'RESUELTA', resolucion: ' Se cobró aparte ' });
    expect(res.status).toBe(200);
    expect(actualizar).toHaveBeenCalledWith(
      NOTA,
      { estado: 'RESUELTA', resolucion: 'Se cobró aparte' },
      USER,
    );
  });

  it('PATCH afecta_cotizacion=false (JSON) llega false; en texto ⇒ 400', async () => {
    let res = await request(http())
      .patch(`/v1/flights/seguimiento/${NOTA}`)
      .send({ afecta_cotizacion: false });
    expect(res.status).toBe(200);
    expect(actualizar).toHaveBeenCalledWith(
      NOTA,
      { afecta_cotizacion: false },
      USER,
    );
    res = await request(http())
      .patch(`/v1/flights/seguimiento/${NOTA}`)
      .send({ afecta_cotizacion: 'false' });
    expect(res.status).toBe(400);
    expect(actualizar).toHaveBeenCalledTimes(1);
  });

  it('PATCH con `null` en afecta_cotizacion o estado ⇒ 400 (null NO es «false» ni «omitido»)', async () => {
    for (const body of [
      { afecta_cotizacion: null },
      { estado: null },
      { estado: null, resolucion: 'x' },
    ]) {
      const res = await request(http())
        .patch(`/v1/flights/seguimiento/${NOTA}`)
        .send(body);
      expect([body, res.status]).toEqual([body, 400]);
    }
    expect(actualizar).not.toHaveBeenCalled();
  });

  it('PATCH: resolucion null permitido; estado inventado / resolución de 501 ⇒ 400', async () => {
    let res = await request(http())
      .patch(`/v1/flights/seguimiento/${NOTA}`)
      .send({ estado: 'RESUELTA', resolucion: null });
    expect(res.status).toBe(200);
    res = await request(http())
      .patch(`/v1/flights/seguimiento/${NOTA}`)
      .send({ estado: 'CERRADA' });
    expect(res.status).toBe(400);
    res = await request(http())
      .patch(`/v1/flights/seguimiento/${NOTA}`)
      .send({ estado: 'RESUELTA', resolucion: 'r'.repeat(501) });
    expect(res.status).toBe(400);
    expect(actualizar).toHaveBeenCalledTimes(1);
  });

  it('DELETE por NOTA → soft delete con el usuario; FACTURACION puede, SOCIO no', async () => {
    rol = Rol.FACTURACION;
    let res = await request(http()).delete(`/v1/flights/seguimiento/${NOTA}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: NOTA, vuelo_id: V358 });
    expect(eliminar).toHaveBeenCalledWith(NOTA, USER);
    rol = Rol.SOCIO;
    res = await request(http()).delete(`/v1/flights/seguimiento/${NOTA}`);
    expect(res.status).toBe(403);
    expect(eliminar).toHaveBeenCalledTimes(1);
  });
});

describe('FlightsController — seguimiento sin el service inyectado', () => {
  it('503 SEGUIMIENTO_NO_DISPONIBLE (nunca un 500 por undefined)', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FlightsController],
      providers: [
        { provide: FlightsService, useValue: {} },
        { provide: FlightReportService, useValue: {} },
        { provide: CobroReciboService, useValue: {} },
        { provide: FacturaClienteService, useValue: {} },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(new AllExceptionsFilter());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { user: unknown }).user = {
        userId: USER,
        rol: Rol.ADMIN,
      };
      next();
    });
    await app.init();
    const res = await request(app.getHttpServer() as Servidor).get(
      `/v1/flights/${V358}/seguimiento`,
    );
    expect(res.status).toBe(503);
    expect((res.body as { code?: string }).code).toBe(
      'SEGUIMIENTO_NO_DISPONIBLE',
    );
    await app.close();
  });
});
