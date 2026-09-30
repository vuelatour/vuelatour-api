// El servicio real arrastra pyservices/IA: se stubbea; aquí se prueba el
// CABLEADO HTTP de los reversos (30-sep-2026): rutas, roles de la clase,
// DTO (forbidNonWhitelisted) y que `:id` no capture `reversos/auto`.
jest.mock('./conciliacion.service', () => ({ ConciliacionService: class {} }));

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { errorReversosNoDisponibles } from '../../common/reverso-disponible.util';
import { ConciliacionController } from './conciliacion.controller';
import { ConciliacionService } from './conciliacion.service';

type Servidor = Parameters<typeof request>[0];
const ABONO = 'eeeeeeee-0000-4000-8000-000000000001';
const CARGO = 'eeeeeeee-0000-4000-8000-000000000002';
const CTA = 'eeeeeeee-0000-4000-8000-000000000003';

describe('ConciliacionController — reversos por metadata', () => {
  it('las rutas nuevas NO abren roles: heredan los de la clase (ADMIN, FACTURACION)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ConciliacionController)).toEqual([
      Rol.ADMIN,
      Rol.FACTURACION,
    ]);
    const proto = ConciliacionController.prototype as unknown as Record<
      string,
      object
    >;
    for (const m of [
      'autoReversos',
      'reversoCandidatos',
      'emparejarReverso',
      'desemparejarReverso',
    ]) {
      expect(Reflect.getMetadata(ROLES_KEY, proto[m])).toBeUndefined();
    }
  });
});

describe('ConciliacionController — reversos por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    autoReversos: jest.fn().mockResolvedValue({ revisados: 0 }),
    candidatosReverso: jest.fn().mockResolvedValue([]),
    emparejarReverso: jest
      .fn()
      .mockResolvedValue({ abono: {}, cargo: {}, idempotente: false }),
    desemparejarReverso: jest.fn().mockResolvedValue({ abono: {}, cargo: {} }),
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

  it('GET movimientos/:id/reverso-candidatos', async () => {
    const r = await request(http()).get(
      `/v1/conciliacion/movimientos/${ABONO}/reverso-candidatos`,
    );
    expect(r.status).toBe(200);
    expect(svc.candidatosReverso).toHaveBeenCalledWith(ABONO);
    expect(
      (
        await request(http()).get(
          '/v1/conciliacion/movimientos/no-uuid/reverso-candidatos',
        )
      ).status,
    ).toBe(400);
  });

  it('POST movimientos/:id/reverso {cargo_id} (o {abono_id} desde el cargo)', async () => {
    const r = await request(http())
      .post(`/v1/conciliacion/movimientos/${ABONO}/reverso`)
      .send({ cargo_id: CARGO });
    expect(r.status).toBe(200);
    expect(svc.emparejarReverso).toHaveBeenCalledWith(ABONO, CARGO, 'u-1');
    await request(http())
      .post(`/v1/conciliacion/movimientos/${CARGO}/reverso`)
      .send({ abono_id: ABONO })
      .expect(200);
    expect(svc.emparejarReverso).toHaveBeenLastCalledWith(CARGO, ABONO, 'u-1');
  });

  it('POST con campo extra o id inválido ⇒ 400 (DTO)', async () => {
    expect(
      (
        await request(http())
          .post(`/v1/conciliacion/movimientos/${ABONO}/reverso`)
          .send({ cargo_id: CARGO, forzar: true })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(http())
          .post(`/v1/conciliacion/movimientos/${ABONO}/reverso`)
          .send({ cargo_id: 'x' })
      ).status,
    ).toBe(400);
    // cargo_id Y abono_id a la vez ⇒ 400 (antes ganaba cargo_id en silencio).
    const ambos = await request(http())
      .post(`/v1/conciliacion/movimientos/${ABONO}/reverso`)
      .send({ cargo_id: CARGO, abono_id: ABONO });
    expect(ambos.status).toBe(400);
    expect(JSON.stringify(ambos.body)).toContain('REVERSO_SIN_PAR');
    expect(svc.emparejarReverso).not.toHaveBeenCalled();
  });

  it('DELETE movimientos/:id/reverso', async () => {
    await request(http())
      .delete(`/v1/conciliacion/movimientos/${CARGO}/reverso`)
      .expect(200);
    expect(svc.desemparejarReverso).toHaveBeenCalledWith(CARGO, 'u-1');
  });

  it('POST reversos/auto: body opcional, fechas YYYY-MM-DD', async () => {
    await request(http())
      .post('/v1/conciliacion/reversos/auto')
      .send({})
      .expect(200);
    await request(http())
      .post('/v1/conciliacion/reversos/auto')
      .send({
        cuenta_bancaria_id: CTA,
        desde: '2026-09-01',
        hasta: '2026-09-30',
      })
      .expect(200);
    expect(svc.autoReversos).toHaveBeenLastCalledWith(
      { cuenta_bancaria_id: CTA, desde: '2026-09-01', hasta: '2026-09-30' },
      'u-1',
    );
    expect(
      (
        await request(http())
          .post('/v1/conciliacion/reversos/auto')
          .send({ desde: '01/09/2026' })
      ).status,
    ).toBe(400);
  });

  it('COORDINADOR ⇒ 403 (conciliar es de ADMIN y FACTURACION)', async () => {
    rol = Rol.COORDINADOR;
    expect(
      (
        await request(http())
          .post(`/v1/conciliacion/movimientos/${ABONO}/reverso`)
          .send({ cargo_id: CARGO })
      ).status,
    ).toBe(403);
    expect(
      (await request(http()).post('/v1/conciliacion/reversos/auto').send({}))
        .status,
    ).toBe(403);
    rol = Rol.FACTURACION;
    await request(http())
      .delete(`/v1/conciliacion/movimientos/${CARGO}/reverso`)
      .expect(200);
  });

  it('el 503 del servicio llega con su código', async () => {
    svc.candidatosReverso.mockRejectedValueOnce(errorReversosNoDisponibles());
    const r = await request(http()).get(
      `/v1/conciliacion/movimientos/${ABONO}/reverso-candidatos`,
    );
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).toContain('REVERSOS_NO_DISPONIBLE');
  });
});
