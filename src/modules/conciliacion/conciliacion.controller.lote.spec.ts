// El servicio real arrastra pyservices/IA: se stubbea; aquí se prueba el
// CABLEADO HTTP de 1 cargo ↔ N gastos (2-oct-2026, API 0.0.52): el PATCH con
// `gasto_ids`, la regla del 400 LOTE_INVALIDO, el DTO y la ruta nueva
// `movimientos/:id/gastos-candidatos` con los roles de la clase.
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
import { errorPartesNoDisponibles } from '../../common/partes-disponible.util';
import { ConciliacionController } from './conciliacion.controller';
import { ConciliacionService } from './conciliacion.service';
import { MENSAJE_LOTE_AMBOS } from './conciliacion-parcial.util';

type Servidor = Parameters<typeof request>[0];
const MOV = 'eeeeeeee-0000-4000-8000-000000000001';
const G1 = 'eeeeeeee-0000-4000-8000-000000000011';
const G2 = 'eeeeeeee-0000-4000-8000-000000000012';

describe('ConciliacionController — lote por metadata', () => {
  it('la ruta nueva hereda los roles de la clase (ADMIN, FACTURACION)', () => {
    const proto = ConciliacionController.prototype as unknown as Record<
      string,
      object
    >;
    expect(
      Reflect.getMetadata(ROLES_KEY, proto.gastosCandidatos),
    ).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, ConciliacionController)).toEqual([
      Rol.ADMIN,
      Rol.FACTURACION,
    ]);
  });
});

describe('ConciliacionController — lote por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    link: jest.fn().mockResolvedValue({ id: MOV }),
    linkGastos: jest.fn().mockResolvedValue({ id: MOV, gastos_estado: [] }),
    gastosCandidatosDeMovimiento: jest
      .fn()
      .mockResolvedValue({ candidatos: [], truncado: false }),
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

  const patch = (body: unknown) =>
    request(http())
      .patch(`/v1/conciliacion/movimientos/${MOV}`)
      .send(body as object);

  it('{gasto_ids} ⇒ linkGastos; {gasto_id} ⇒ link; {gasto_id:null} y {} ⇒ desligar', async () => {
    await patch({ gasto_ids: [G1, G2] }).expect(200);
    expect(svc.linkGastos).toHaveBeenCalledWith(MOV, [G1, G2], 'u-1');
    await patch({ gasto_id: G1 }).expect(200);
    expect(svc.link).toHaveBeenLastCalledWith(MOV, G1, 'u-1');
    await patch({ gasto_id: null }).expect(200);
    expect(svc.link).toHaveBeenLastCalledWith(MOV, null, 'u-1');
    await patch({}).expect(200);
    expect(svc.link).toHaveBeenLastCalledWith(MOV, null, 'u-1');
    // gasto_ids: null = ausente.
    await patch({ gasto_ids: null, gasto_id: G1 }).expect(200);
    expect(svc.link).toHaveBeenLastCalledWith(MOV, G1, 'u-1');
  });

  it('gasto_ids + gasto_id ⇒ 400 LOTE_INVALIDO sin llamar al servicio', async () => {
    const r = await patch({ gasto_ids: [G1, G2], gasto_id: null });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: 'LOTE_INVALIDO',
      message: MENSAJE_LOTE_AMBOS,
    });
    expect(svc.link).not.toHaveBeenCalled();
    expect(svc.linkGastos).not.toHaveBeenCalled();
  });

  it('DTO: vacío, repetidos o no-uuid ⇒ 400', async () => {
    for (const body of [
      { gasto_ids: [] },
      { gasto_ids: [G1, G1] },
      { gasto_ids: ['x'] },
    ]) {
      expect((await patch(body)).status).toBe(400);
    }
    expect(svc.linkGastos).not.toHaveBeenCalled();
  });

  it('GET movimientos/:id/gastos-candidatos con q/dias/limite convertidos', async () => {
    const r = await request(http()).get(
      `/v1/conciliacion/movimientos/${MOV}/gastos-candidatos?q=2801.40&dias=120&limite=50`,
    );
    expect(r.status).toBe(200);
    expect(svc.gastosCandidatosDeMovimiento).toHaveBeenCalledWith(
      MOV,
      expect.objectContaining({ q: '2801.40', dias: 120, limite: 50 }),
    );
    expect(
      (
        await request(http()).get(
          `/v1/conciliacion/movimientos/${MOV}/gastos-candidatos?dias=999`,
        )
      ).status,
    ).toBe(400);
  });

  it('503 del servicio llega con su código; COORDINADOR ⇒ 403', async () => {
    svc.gastosCandidatosDeMovimiento.mockRejectedValueOnce(
      errorPartesNoDisponibles(),
    );
    const r = await request(http()).get(
      `/v1/conciliacion/movimientos/${MOV}/gastos-candidatos`,
    );
    expect(r.status).toBe(503);
    expect((r.body as { code?: string }).code).toBe(
      'CONCILIACION_PARTES_NO_DISPONIBLE',
    );
    rol = Rol.COORDINADOR;
    expect(
      (
        await request(http()).get(
          `/v1/conciliacion/movimientos/${MOV}/gastos-candidatos`,
        )
      ).status,
    ).toBe(403);
  });
});
