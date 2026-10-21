// El servicio real arrastra ExpensesService (BD, IA, pyservices): se stubbea;
// aquí se prueba el CABLEADO HTTP de `POST /v1/compras/:id/registrar-gasto`
// (21-oct-2026, invariante 101): el T.C. obligatorio y numérico, el medio
// del enum, la fecha YYYY-MM-DD, nada fuera de la whitelist, y los roles.
jest.mock('./compra-gasto.service', () => ({ CompraGastoService: class {} }));

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { CompraGastoController } from './compra-gasto.controller';
import { CompraGastoService } from './compra-gasto.service';

type Servidor = Parameters<typeof request>[0];
const llamadas = (m: jest.Mock): unknown[][] => m.mock.calls as unknown[][];

const COMPRA = '0f5e6659-2c39-40d0-89d5-3fbd8d98537d';
const RUTA = `/v1/compras/${COMPRA}/registrar-gasto`;
const cuerpo = (extra: Record<string, unknown> = {}) => ({
  tc_usd_mxn: 18.25,
  fecha_gasto: '2026-10-21',
  medio_pago: 'TRANSFERENCIA',
  ...extra,
});

describe('POST /v1/compras/:id/registrar-gasto — cableado HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = { registrarGasto: jest.fn() };
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CompraGastoController],
      providers: [{ provide: CompraGastoService, useValue: svc }],
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
    svc.registrarGasto.mockReset();
    svc.registrarGasto.mockResolvedValue({
      id: COMPRA,
      gasto_registrado: { id: 'g-1' },
    });
  });

  it('201 con el cuerpo mínimo: el servicio recibe id, dto numérico, usuario y rol', async () => {
    const res = await request(http()).post(RUTA).send(cuerpo());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: COMPRA,
      gasto_registrado: { id: 'g-1' },
    });
    const [id, dto, userId, r] = llamadas(svc.registrarGasto)[0];
    expect(id).toBe(COMPRA);
    expect(dto).toMatchObject({
      tc_usd_mxn: 18.25,
      fecha_gasto: '2026-10-21',
      medio_pago: 'TRANSFERENCIA',
    });
    expect(userId).toBe('u-1');
    expect(r).toBe(Rol.ADMIN);
  });

  it('el T.C. es OBLIGATORIO: sin él, vacío o texto ⇒ 400 sin llamar al servicio', async () => {
    for (const malo of [
      { tc_usd_mxn: undefined },
      { tc_usd_mxn: '' },
      { tc_usd_mxn: 'dieciocho' },
      { tc_usd_mxn: 0 },
    ]) {
      const res = await request(http()).post(RUTA).send(cuerpo(malo));
      expect(res.status).toBe(400);
    }
    expect(svc.registrarGasto).not.toHaveBeenCalled();
  });

  it('medio fuera del enum (BODEGA no es un pago) y fecha que no es YYYY-MM-DD ⇒ 400', async () => {
    expect(
      (
        await request(http())
          .post(RUTA)
          .send(cuerpo({ medio_pago: 'BODEGA' }))
      ).status,
    ).toBe(400);
    expect(
      (
        await request(http())
          .post(RUTA)
          .send(cuerpo({ medio_pago: '' }))
      ).status,
    ).toBe(400);
    expect(
      (
        await request(http())
          .post(RUTA)
          .send(cuerpo({ fecha_gasto: '21/10/2026' }))
      ).status,
    ).toBe(400);
    expect(
      (
        await request(http())
          .post(RUTA)
          .send(cuerpo({ fecha_gasto: '2026-02-30' }))
      ).status,
    ).toBe(400);
    expect(svc.registrarGasto).not.toHaveBeenCalled();
  });

  it('el MONTO no viaja (lo calcula el API): una llave fuera de la whitelist ⇒ 400', async () => {
    const res = await request(http())
      .post(RUTA)
      .send(cuerpo({ monto: 999 }));
    expect(res.status).toBe(400);
    expect(svc.registrarGasto).not.toHaveBeenCalled();
  });

  it('acepta los opcionales (cuenta, proveedor, folio, notas, llave) y un id que no es uuid ⇒ 400', async () => {
    const res = await request(http())
      .post(RUTA)
      .send(
        cuerpo({
          cuenta_bancaria_id: 'c0000000-0000-4000-8000-000000000001',
          proveedor_id: 'a0000000-0000-4000-8000-000000000002',
          folio_ticket: 'F-77',
          notas: 'ok',
          client_request_id: '9b2c7a10-1d2e-4f30-8a4b-5c6d7e8f9a0b',
        }),
      );
    expect(res.status).toBe(201);
    expect(llamadas(svc.registrarGasto)[0][1]).toMatchObject({
      folio_ticket: 'F-77',
      notas: 'ok',
    });
    expect(
      (
        await request(http())
          .post('/v1/compras/12/registrar-gasto')
          .send(cuerpo())
      ).status,
    ).toBe(400);
  });

  it('roles: ADMIN y COORDINADOR sí; PILOTO y FACTURACION, 403', async () => {
    rol = Rol.COORDINADOR;
    expect((await request(http()).post(RUTA).send(cuerpo())).status).toBe(201);
    rol = Rol.PILOTO;
    expect((await request(http()).post(RUTA).send(cuerpo())).status).toBe(403);
    rol = Rol.FACTURACION;
    expect((await request(http()).post(RUTA).send(cuerpo())).status).toBe(403);
    expect(svc.registrarGasto).toHaveBeenCalledTimes(1);
  });
});
