// El servicio real arrastra InventoryService (notificaciones → `jose`, ESM
// puro): se stubbea. Aquí se prueba el CABLEADO HTTP de `POST /v1/compras`
// (17-nov-2026, API 0.0.142, invariante 137): 201 en el alta y 200 en el
// replay idempotente, la llave `client_request_id` en el DTO (uuid o 400),
// los `code` / `details` por el filtro y los roles de siempre.
jest.mock('./compras.service', () => ({ ComprasService: class {} }));

import {
  ConflictException,
  Logger,
  ServiceUnavailableException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { ComprasController } from './compras.controller';
import { ComprasService } from './compras.service';

type Servidor = Parameters<typeof request>[0];
const llamadas = (m: jest.Mock): unknown[][] => m.mock.calls as unknown[][];

const COMPRA = '0f5e6659-2c39-40d0-89d5-3fbd8d98537d';
const KEY = '9b2c7a10-1d2e-4f30-8a4b-5c6d7e8f9a0b';
const RUTA = '/v1/compras';

/** El cuerpo que manda la app para una compra de la tienda. */
const cuerpo = (extra: Record<string, unknown> = {}) => ({
  fecha: '2026-11-17',
  moneda: 'MXN',
  tc_usd_mxn: 18.5,
  notas: 'Registrada desde la app (control 9B2C7A10)',
  lineas: [{ nombre: 'Aceite 15W-50', cantidad: 12, costo_unitario: 210 }],
  ...extra,
});

const DETALLE = {
  id: COMPRA,
  folio: 41,
  estado: 'ABIERTA',
  lineas: [{ nombre: 'Aceite 15W-50' }],
  pagos: [],
  resumen: { total_factura: 2520 },
};

describe('POST /v1/compras — cableado HTTP del alta idempotente', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = { create: jest.fn(), update: jest.fn() };
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ComprasController],
      providers: [{ provide: ComprasService, useValue: svc }],
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
        authId: 'auth-1',
        nombre: 'Oficina',
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
    svc.create.mockReset();
    svc.create.mockResolvedValue(DETALLE);
    svc.update.mockReset();
    svc.update.mockResolvedValue(DETALLE);
  });

  it('alta: 201 con el detalle tal cual (sin `idempotente`); el servicio recibe la llave y al usuario', async () => {
    const res = await request(http())
      .post(RUTA)
      .send(cuerpo({ client_request_id: KEY }));

    expect(res.status).toBe(201);
    expect(res.body).toEqual(DETALLE);
    const [dto, userId] = llamadas(svc.create)[0];
    expect(dto).toMatchObject({
      client_request_id: KEY,
      moneda: 'MXN',
      tc_usd_mxn: 18.5,
      lineas: [{ nombre: 'Aceite 15W-50', cantidad: 12, costo_unitario: 210 }],
    });
    expect(userId).toBe('u-1');
  });

  it('replay idempotente (misma llave): 200 con el MISMO detalle más idempotente:true', async () => {
    svc.create.mockResolvedValue({ ...DETALLE, idempotente: true });

    const res = await request(http())
      .post(RUTA)
      .send(cuerpo({ client_request_id: KEY }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...DETALLE, idempotente: true });
  });

  it('sin llave (panel): 201 como siempre y el DTO llega sin llave', async () => {
    const res = await request(http()).post(RUTA).send(cuerpo());

    expect(res.status).toBe(201);
    expect(res.body).toEqual(DETALLE);
    const [dto] = llamadas(svc.create)[0] as [{ client_request_id?: string }];
    expect(dto.client_request_id).toBeUndefined();
  });

  it('la llave debe ser uuid: texto libre, vacía, número o null explícito no pasan como llave (400 sin llamar al servicio, salvo null = sin llave)', async () => {
    for (const mala of ['7F3A9C1D', '', 'no-es-uuid', 123]) {
      const res = await request(http())
        .post(RUTA)
        .send(cuerpo({ client_request_id: mala }));
      expect([mala, res.status]).toEqual([mala, 400]);
      expect(JSON.stringify(res.body)).toContain('client_request_id');
    }
    expect(svc.create).not.toHaveBeenCalled();

    // `@IsOptional()`: null = no viene (alta sin idempotencia, como el panel).
    const res = await request(http())
      .post(RUTA)
      .send(cuerpo({ client_request_id: null }));
    expect(res.status).toBe(201);
  });

  it('503 COMPRA_EN_PROCESO y 409 COMPRA_INCOMPLETA salen con `code` y `details` por el filtro', async () => {
    // El filtro registra todo 5xx: callado aquí, la salida de jest queda limpia.
    const registro = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    svc.create.mockRejectedValueOnce(
      new ServiceUnavailableException({
        message: 'La compra #41 todavía se está guardando.',
        error: 'COMPRA_EN_PROCESO',
        details: { client_request_id: KEY, compra_id: COMPRA, folio: 41 },
      }),
    );
    const r503 = await request(http())
      .post(RUTA)
      .send(cuerpo({ client_request_id: KEY }));
    expect(r503.status).toBe(503);
    expect(r503.body).toMatchObject({
      code: 'COMPRA_EN_PROCESO',
      message: 'La compra #41 todavía se está guardando.',
      details: { client_request_id: KEY, compra_id: COMPRA, folio: 41 },
    });
    registro.mockRestore();

    svc.create.mockRejectedValueOnce(
      new ConflictException({
        message: 'La compra #41 ya está registrada pero quedó incompleta.',
        error: 'COMPRA_INCOMPLETA',
        details: { compra_id: COMPRA, folio: 41, falta: 'GASTO' },
      }),
    );
    const r409 = await request(http())
      .post(RUTA)
      .send(cuerpo({ client_request_id: KEY }));
    expect(r409.status).toBe(409);
    expect(r409.body).toMatchObject({
      code: 'COMPRA_INCOMPLETA',
      details: { compra_id: COMPRA, folio: 41, falta: 'GASTO' },
    });
  });

  it('el resto del DTO no cambió: una llave fuera de la whitelist ⇒ 400; la llave es SOLO del alta (PATCH la rechaza)', async () => {
    expect(
      (
        await request(http())
          .post(RUTA)
          .send(cuerpo({ idempotente: true }))
      ).status,
    ).toBe(400);
    expect(svc.create).not.toHaveBeenCalled();

    const patch = await request(http())
      .patch(`${RUTA}/${COMPRA}`)
      .send({ notas: 'x', client_request_id: KEY });
    expect(patch.status).toBe(400);
    expect(svc.update).not.toHaveBeenCalled();
  });

  it('roles de siempre: ADMIN, COORDINADOR y DIRECCION sí; PILOTO y MECANICO, 403', async () => {
    for (const r of [Rol.ADMIN, Rol.COORDINADOR, Rol.DIRECCION]) {
      rol = r;
      expect(
        (
          await request(http())
            .post(RUTA)
            .send(cuerpo({ client_request_id: KEY }))
        ).status,
      ).toBe(201);
    }
    for (const r of [Rol.PILOTO, Rol.MECANICO]) {
      rol = r;
      expect(
        (
          await request(http())
            .post(RUTA)
            .send(cuerpo({ client_request_id: KEY }))
        ).status,
      ).toBe(403);
    }
    expect(svc.create).toHaveBeenCalledTimes(3);
  });
});
