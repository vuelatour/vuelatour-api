// El servicio real arrastra pyservices/IA: se stubbea; aquí se prueba el
// CABLEADO HTTP de «Varios cargos → un gasto» (14-oct-2026, API 0.0.77,
// invariante 76): rutas, roles de la clase, DTOs y 200 en las acciones.
jest.mock('./conciliacion.service', () => ({ ConciliacionService: class {} }));

import {
  ConflictException,
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
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { errorCargosAGastoNoDisponible } from '../../common/omision-cargos-disponible.util';
import { ConciliacionController } from './conciliacion.controller';
import { ConciliacionService } from './conciliacion.service';
import { MENSAJE_LOTE_CARGOS_INVALIDO } from './cargos-a-gasto.util';

type Servidor = Parameters<typeof request>[0];
/** Cuerpo de error del AllExceptionsFilter (supertest lo da como `any`). */
type CuerpoError = { code: string; message: string | string[] };
const cuerpoError = (r: { body: unknown }) => r.body as CuerpoError;
const M1 = 'ffffffff-0000-4000-8000-000000000001';
const M2 = 'ffffffff-0000-4000-8000-000000000002';
const G = 'ffffffff-0000-4000-8000-0000000000aa';

describe('ConciliacionController — cargos → gasto por metadata', () => {
  it('heredan los roles de la clase', () => {
    const proto = ConciliacionController.prototype as unknown as Record<
      string,
      object
    >;
    for (const m of ['gastosCandidatosDeCargos', 'ligarCargosAGasto']) {
      expect(Reflect.getMetadata(ROLES_KEY, proto[m])).toBeUndefined();
    }
  });
});

describe('ConciliacionController — cargos → gasto por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    gastosCandidatosDeCargos: jest.fn().mockResolvedValue({ candidatos: [] }),
    ligarCargosAGasto: jest
      .fn()
      .mockResolvedValue({ gasto_id: G, idempotente: false }),
    conciliacionDeGasto: jest.fn().mockResolvedValue({ cargos: [] }),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ConciliacionController],
      providers: [{ provide: ConciliacionService, useValue: svc }],
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

  it('candidatos: 200, q recortada y dias/limite numéricos', async () => {
    const r = await request(http())
      .post('/v1/conciliacion/cargos/gastos-candidatos')
      .send({ movimiento_ids: [M1, M2], q: '  9700 ', dias: 45, limite: 20 });
    expect(r.status).toBe(200);
    expect(svc.gastosCandidatosDeCargos).toHaveBeenCalledWith(
      expect.objectContaining({
        movimiento_ids: [M1, M2],
        q: '9700',
        dias: 45,
        limite: 20,
      }),
    );
    await request(http())
      .post('/v1/conciliacion/cargos/gastos-candidatos')
      .send({ movimiento_ids: [M1, M2], q: '   ' })
      .expect(200);
    expect(svc.gastosCandidatosDeCargos).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: undefined }),
    );
  });

  it('DTO: 1 cargo, 51, repetidos, no uuid, dias/limite fuera de rango ⇒ 400 con el texto del lote', async () => {
    const muchos = Array.from(
      { length: 51 },
      (_, i) => `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    for (const body of [
      { movimiento_ids: [M1] },
      { movimiento_ids: muchos },
      { movimiento_ids: [M1, M1] },
    ]) {
      const r = await request(http())
        .post('/v1/conciliacion/cargos/gastos-candidatos')
        .send(body);
      expect(r.status).toBe(400);
      expect(cuerpoError(r).message).toContain(MENSAJE_LOTE_CARGOS_INVALIDO);
      const r2 = await request(http())
        .post(`/v1/conciliacion/gastos/${G}/cargos`)
        .send(body);
      expect(r2.status).toBe(400);
    }
    for (const body of [
      { movimiento_ids: [M1, 'x'] },
      { movimiento_ids: [M1, M2], dias: 0 },
      { movimiento_ids: [M1, M2], limite: 301 },
      { movimiento_ids: [M1, M2], extra: true },
    ]) {
      expect(
        (
          await request(http())
            .post('/v1/conciliacion/cargos/gastos-candidatos')
            .send(body)
        ).status,
      ).toBe(400);
    }
    expect(svc.gastosCandidatosDeCargos).not.toHaveBeenCalled();
    expect(svc.ligarCargosAGasto).not.toHaveBeenCalled();
  }, 20_000);

  it('vincular: POST gastos/:id/cargos ⇒ 200 con el gasto, los cargos y quién; GET gastos/:id sigue siendo la conciliación al revés', async () => {
    const r = await request(http())
      .post(`/v1/conciliacion/gastos/${G}/cargos`)
      .send({ movimiento_ids: [M1, M2] });
    expect(r.status).toBe(200);
    expect(svc.ligarCargosAGasto).toHaveBeenCalledWith(G, [M1, M2], 'u-1');
    await request(http()).get(`/v1/conciliacion/gastos/${G}`).expect(200);
    expect(svc.conciliacionDeGasto).toHaveBeenCalledWith(G);
    expect(
      (
        await request(http())
          .post('/v1/conciliacion/gastos/no-uuid/cargos')
          .send({ movimiento_ids: [M1, M2] })
      ).status,
    ).toBe(400);
  });

  it('los 409/503 del servicio llegan con su código y details; COORDINADOR ⇒ 403', async () => {
    svc.ligarCargosAGasto.mockRejectedValueOnce(
      new ConflictException({
        message: 'Los 2 cargos suman $250.00 …',
        error: 'CARGOS_EXCEDEN_GASTO',
        details: { excedente: 50 },
      }),
    );
    const r = await request(http())
      .post(`/v1/conciliacion/gastos/${G}/cargos`)
      .send({ movimiento_ids: [M1, M2] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      code: 'CARGOS_EXCEDEN_GASTO',
      details: { excedente: 50 },
    });
    svc.gastosCandidatosDeCargos.mockRejectedValueOnce(
      errorCargosAGastoNoDisponible(),
    );
    const r2 = await request(http())
      .post('/v1/conciliacion/cargos/gastos-candidatos')
      .send({ movimiento_ids: [M1, M2] });
    expect([r2.status, cuerpoError(r2).code]).toEqual([
      503,
      'CONCILIACION_CARGOS_A_GASTO_NO_DISPONIBLE',
    ]);
    rol = Rol.COORDINADOR;
    expect(
      (
        await request(http())
          .post(`/v1/conciliacion/gastos/${G}/cargos`)
          .send({ movimiento_ids: [M1, M2] })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(http())
          .post('/v1/conciliacion/cargos/gastos-candidatos')
          .send({ movimiento_ids: [M1, M2] })
      ).status,
    ).toBe(403);
  });
});
