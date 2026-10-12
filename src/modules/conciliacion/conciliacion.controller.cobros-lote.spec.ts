// El servicio real arrastra pyservices/IA: se stubbea; aquí se prueba el
// CABLEADO HTTP de 1 abono ↔ N cobros (12-oct-2026, API 0.0.71): el PATCH
// `movimientos/:id/cobro` con `cobro_ids`, su DTO (1..50 uuid sin repetir) y
// que la liga de siempre (`cobro_id` / `cobro_grupo_id` / {}) no cambie.
jest.mock('./conciliacion.service', () => ({ ConciliacionService: class {} }));

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { errorCobrosLoteNoDisponibles } from '../../common/cobros-lote-disponible.util';
import { ConciliacionController } from './conciliacion.controller';
import { ConciliacionService } from './conciliacion.service';

type Servidor = Parameters<typeof request>[0];
const MOV = 'eeeeeeee-0000-4000-8000-000000000001';
const C1 = 'eeeeeeee-0000-4000-8000-000000000021';
const C2 = 'eeeeeeee-0000-4000-8000-000000000022';
const S1 = 'eeeeeeee-0000-4000-8000-000000000031';

describe('ConciliacionController — 1 abono ↔ N cobros por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    linkCobro: jest.fn().mockResolvedValue({ id: MOV, cobros_n: 2 }),
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
    svc.linkCobro.mockResolvedValue({ id: MOV, cobros_n: 2 });
  });

  const patch = (body: unknown) =>
    request(http())
      .patch(`/v1/conciliacion/movimientos/${MOV}/cobro`)
      .send(body as object);

  it('{cobro_ids} viaja al service junto a cobro_id/cobro_grupo_id en null', async () => {
    const r = await patch({ cobro_ids: [C1, C2] }).expect(200);
    expect(r.body).toEqual({ id: MOV, cobros_n: 2 });
    expect(svc.linkCobro).toHaveBeenCalledWith(
      MOV,
      { cobro_id: null, cobro_grupo_id: null, cobro_ids: [C1, C2] },
      'u-1',
    );
  }, 15000);

  it('la liga de siempre no cambia: {cobro_id}, {cobro_grupo_id}, {} y cobro_ids: null', async () => {
    await patch({ cobro_id: C1 }).expect(200);
    expect(svc.linkCobro).toHaveBeenLastCalledWith(
      MOV,
      { cobro_id: C1, cobro_grupo_id: null },
      'u-1',
    );
    await patch({ cobro_grupo_id: S1 }).expect(200);
    expect(svc.linkCobro).toHaveBeenLastCalledWith(
      MOV,
      { cobro_id: null, cobro_grupo_id: S1 },
      'u-1',
    );
    await patch({}).expect(200);
    expect(svc.linkCobro).toHaveBeenLastCalledWith(
      MOV,
      { cobro_id: null, cobro_grupo_id: null },
      'u-1',
    );
    await patch({ cobro_ids: null, cobro_id: C1 }).expect(200);
    expect(svc.linkCobro).toHaveBeenLastCalledWith(
      MOV,
      { cobro_id: C1, cobro_grupo_id: null },
      'u-1',
    );
  }, 15000);

  it('DTO: vacío, repetido, no-uuid, más de 50 o no-arreglo ⇒ 400 sin llamar al service', async () => {
    const muchos = Array.from(
      { length: 51 },
      (_, i) =>
        `eeeeeeee-0000-4000-8000-${String(100000000000 + i).slice(-12)}`,
    );
    for (const body of [
      { cobro_ids: [] },
      { cobro_ids: [C1, C1] },
      { cobro_ids: [C1, 'no-uuid'] },
      { cobro_ids: muchos },
      { cobro_ids: C1 },
      { cobro_ids: [C1], otro: 1 },
    ]) {
      const r = await patch(body).expect(400);
      expect(r.body).toBeDefined();
    }
    expect(svc.linkCobro).not.toHaveBeenCalled();
  }, 20000);

  it('un 503 del service (migración pendiente) viaja con su code', async () => {
    svc.linkCobro.mockRejectedValueOnce(errorCobrosLoteNoDisponibles());
    const r = await patch({ cobro_ids: [C1, C2] }).expect(503);
    const cuerpo = r.body as { code?: string; error?: string };
    expect(cuerpo.code ?? cuerpo.error).toBe(
      'CONCILIACION_COBROS_NO_DISPONIBLE',
    );
  }, 15000);

  it('un rol fuera de ADMIN/FACTURACION recibe 403', async () => {
    rol = Rol.COORDINADOR;
    await patch({ cobro_ids: [C1, C2] }).expect(403);
    expect(svc.linkCobro).not.toHaveBeenCalled();
  }, 15000);
});
