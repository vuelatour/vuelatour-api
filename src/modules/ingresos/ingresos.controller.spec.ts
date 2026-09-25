// El servicio real arrastra FlightsService/Conciliación (googleapis, jose):
// se stubbea; aquí se prueba el CABLEADO HTTP (roles de clase y de método,
// orden de rutas, multipart con UN campo `datos`, 200 del replay, 503).
jest.mock('./ingresos.service', () => ({ IngresosService: class {} }));

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
import { errorIngresosNoDisponibles } from '../../common/ingreso-disponible.util';
import {
  IngresosController,
  ROLES_CONCILIAR,
  ROLES_INGRESOS,
} from './ingresos.controller';
import { IngresosService } from './ingresos.service';

type Servidor = Parameters<typeof request>[0];
const ID = 'eeeeeeee-0000-4000-8000-000000000001';
const COBRO = 'eeeeeeee-0000-4000-8000-000000000002';
const MOV = 'eeeeeeee-0000-4000-8000-000000000003';
const VUELO = 'eeeeeeee-0000-4000-8000-000000000004';
const LLAVE = 'eeeeeeee-0000-4000-8000-000000000005';

describe('IngresosController — roles por metadata', () => {
  it('clase = ROLES_INGRESOS (los del menú «Gastos»)', () => {
    expect(ROLES_INGRESOS).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, IngresosController)).toEqual(
      ROLES_INGRESOS,
    );
  });

  it('solo DESAPLICAR y «cobro-de-vuelo» restringen (ADMIN, FACTURACION)', () => {
    expect(ROLES_CONCILIAR).toEqual([Rol.ADMIN, Rol.FACTURACION]);
    const proto = IngresosController.prototype as unknown as Record<
      string,
      object
    >;
    const conRoles = Object.getOwnPropertyNames(proto)
      .filter((m) => m !== 'constructor')
      .filter((m) => Reflect.getMetadata(ROLES_KEY, proto[m]) !== undefined);
    expect(conRoles.sort()).toEqual(['cobroDeVuelo', 'desaplicar']);
    expect(Reflect.getMetadata(ROLES_KEY, proto.desaplicar)).toEqual(
      ROLES_CONCILIAR,
    );
    expect(Reflect.getMetadata(ROLES_KEY, proto.cobroDeVuelo)).toEqual(
      ROLES_CONCILIAR,
    );
  });

  it('rutas literales declaradas ANTES de `:id`', () => {
    const proto = IngresosController.prototype as unknown as Record<
      string,
      object
    >;
    const rutas = Object.getOwnPropertyNames(proto)
      .filter((m) => m !== 'constructor')
      .map((m) => String(Reflect.getMetadata(PATH_METADATA, proto[m])));
    const primeraConId = rutas.findIndex((r) => r.startsWith(':id'));
    for (const l of [
      'resumen',
      'entradas',
      'export.xlsx',
      'vuelos-candidatos',
      'abonos/:movId/cobro-de-vuelo',
    ]) {
      expect(rutas.indexOf(l)).toBeGreaterThanOrEqual(0);
      expect(rutas.indexOf(l)).toBeLessThan(primeraConId);
    }
  });
});

describe('IngresosController — por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    resumen: jest.fn().mockResolvedValue({ por_moneda: [] }),
    entradas: jest.fn().mockResolvedValue({ data: [] }),
    exportXlsx: jest.fn().mockResolvedValue({
      buffer: Buffer.from('xlsx'),
      filename: 'Ingresos 2026-09-01 a 2026-09-30.xlsx',
    }),
    vuelosCandidatos: jest.fn().mockResolvedValue({ data: [] }),
    lista: jest.fn().mockResolvedValue({ data: [] }),
    obtener: jest.fn().mockResolvedValue({ ingreso: { id: ID } }),
    crear: jest.fn().mockResolvedValue({
      ingreso: { id: ID },
      movimiento_id: null,
      avisos: [],
    }),
    editar: jest.fn().mockResolvedValue({ ingreso: { id: ID }, avisos: [] }),
    baja: jest.fn().mockResolvedValue({ ok: true }),
    aplicar: jest
      .fn()
      .mockResolvedValue({ aplicacion: {}, anticipo: {}, avisos: [] }),
    desaplicar: jest.fn().mockResolvedValue({ ok: true }),
    cobroDeVueloDesdeAbono: jest
      .fn()
      .mockResolvedValue({ cobro: {}, movimiento_id: MOV, avisos: [] }),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IngresosController],
      providers: [{ provide: IngresosService, useValue: svc }],
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

  it('las rutas literales NO las captura `:id`', async () => {
    for (const ruta of ['resumen', 'entradas', 'vuelos-candidatos?q=31']) {
      expect((await request(http()).get(`/v1/ingresos/${ruta}`)).status).toBe(
        200,
      );
    }
    const x = await request(http()).get('/v1/ingresos/export.xlsx');
    expect(x.status).toBe(200);
    expect(String(x.headers['content-disposition'])).toContain(
      'filename="Ingresos 2026-09-01 a 2026-09-30.xlsx"',
    );
    expect(
      (
        await request(http())
          .post(`/v1/ingresos/abonos/${MOV}/cobro-de-vuelo`)
          .send({
            vuelo_id: VUELO,
            client_request_id: LLAVE,
          })
      ).status,
    ).toBe(201);
    expect(svc.obtener).not.toHaveBeenCalled();
  });

  it('COORDINADOR: ve y registra, pero NO desaplica ni concilia (403)', async () => {
    rol = Rol.COORDINADOR;
    expect((await request(http()).get('/v1/ingresos')).status).toBe(200);
    expect(
      (
        await request(http()).post(`/v1/ingresos/${ID}/aplicaciones`).send({
          vuelo_id: VUELO,
          monto: 100,
          client_request_id: LLAVE,
        })
      ).status,
    ).toBe(201);
    expect(
      (await request(http()).delete(`/v1/ingresos/${ID}/aplicaciones/${COBRO}`))
        .status,
    ).toBe(403);
    expect(
      (
        await request(http())
          .post(`/v1/ingresos/abonos/${MOV}/cobro-de-vuelo`)
          .send({
            vuelo_id: VUELO,
            client_request_id: LLAVE,
          })
      ).status,
    ).toBe(403);
    expect(svc.desaplicar).not.toHaveBeenCalled();
    expect(svc.cobroDeVueloDesdeAbono).not.toHaveBeenCalled();
    rol = Rol.FACTURACION;
    expect(
      (await request(http()).delete(`/v1/ingresos/${ID}/aplicaciones/${COBRO}`))
        .status,
    ).toBe(200);
  });

  it('PILOTO, SOCIO y ANALISTA ⇒ 403', async () => {
    for (const r of [Rol.PILOTO, Rol.SOCIO, Rol.ANALISTA]) {
      rol = r;
      expect((await request(http()).get('/v1/ingresos/resumen')).status).toBe(
        403,
      );
    }
  });

  it('alta multipart: UN campo `datos` + `archivo`; otro campo de texto ⇒ 400', async () => {
    const ok = await request(http())
      .post('/v1/ingresos')
      .field('datos', JSON.stringify({ categoria: 'OTRO_INGRESO' }))
      .attach('archivo', Buffer.from('%PDF-1.7'), 'a.pdf');
    expect(ok.status).toBe(201);
    expect(svc.crear).toHaveBeenCalledWith(
      JSON.stringify({ categoria: 'OTRO_INGRESO' }),
      expect.objectContaining({ originalname: 'a.pdf' }),
      expect.objectContaining({ userId: 'u-1', rol: Rol.ADMIN }),
    );
    const extra = await request(http())
      .post('/v1/ingresos')
      .field('datos', '{}')
      .field('monto', '1');
    expect(extra.status).toBe(400);
  });

  it('el REPLAY idempotente responde 200 (alta y aplicación)', async () => {
    svc.crear.mockResolvedValueOnce({
      ingreso: { id: ID },
      movimiento_id: null,
      avisos: [],
      idempotente: true,
    });
    const a = await request(http()).post('/v1/ingresos').field('datos', '{}');
    expect(a.status).toBe(200);
    svc.aplicar.mockResolvedValueOnce({
      aplicacion: {},
      anticipo: {},
      avisos: [],
      idempotente: true,
    });
    const b = await request(http())
      .post(`/v1/ingresos/${ID}/aplicaciones`)
      .send({ vuelo_id: VUELO, monto: 100, client_request_id: LLAVE });
    expect(b.status).toBe(200);
  });

  it('DTOs: llave obligatoria, enums de texto (nunca booleanos en query), campos extra ⇒ 400', async () => {
    expect(
      (
        await request(http())
          .post(`/v1/ingresos/${ID}/aplicaciones`)
          .send({ vuelo_id: VUELO, monto: 100 })
      ).status,
    ).toBe(400);
    expect(
      (await request(http()).get('/v1/ingresos/entradas?origen=otro')).status,
    ).toBe(400);
    expect((await request(http()).get('/v1/ingresos?bajas=true')).status).toBe(
      400,
    );
    expect(
      (await request(http()).get('/v1/ingresos?desde=24-09-2026')).status,
    ).toBe(400);
    expect(
      (
        await request(http())
          .post(`/v1/ingresos/${ID}/baja`)
          .send({ motivo: 'x', otro: 1 })
      ).status,
    ).toBe(400);
    expect((await request(http()).get('/v1/ingresos/no-es-uuid')).status).toBe(
      400,
    );
  });

  it('sin la migración ⇒ 503 INGRESOS_NO_DISPONIBLE', async () => {
    svc.resumen.mockRejectedValueOnce(errorIngresosNoDisponibles());
    const r = await request(http()).get('/v1/ingresos/resumen');
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).toContain('INGRESOS_NO_DISPONIBLE');
  });
});
