// Cableado HTTP REAL del COSTO REAL AFAC por vuelo (16-oct-2026, API 0.0.89,
// invariante 90): ValidationPipe de main.ts + AllExceptionsFilter +
// versionado URI + RolesGuard. El servicio se stubbea.
jest.mock('./afac-real.service', () => ({ AfacRealService: class {} }));

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { ROLES_AFAC_REAL } from '../../common/afac-real.util';
import { AfacRealController } from './afac-real.controller';
import { AfacRealService } from './afac-real.service';

const USER = 'cccccccc-0000-4000-8000-0000000000a1';
const V = 'aaaaaaaa-0000-4000-8000-000000000236';
type Servidor = Parameters<typeof request>[0];

describe('AfacRealController — @Roles = ROLES_AFAC_REAL en las dos rutas', () => {
  const proto = AfacRealController.prototype as unknown as Record<
    string,
    object
  >;
  it.each(['guardar', 'quitar'])('%s', (metodo) => {
    expect(Reflect.getMetadata(ROLES_KEY, proto[metodo])).toEqual([
      ...ROLES_AFAC_REAL,
    ]);
  });
});

describe('AfacRealController por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const guardar = jest.fn();
  const quitar = jest.fn();
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AfacRealController],
      providers: [{ provide: AfacRealService, useValue: { guardar, quitar } }],
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
        userId: USER,
        rol,
        nombre: 'Ale',
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
    guardar.mockReset().mockResolvedValue({ vuelo_id: V, sin_cambios: false });
    quitar.mockReset().mockResolvedValue({ vuelo_id: V, sin_cambios: true });
  });

  it('PUT: ADMIN, FACTURACION y COORDINADOR (200) con el userId; ANALISTA y PILOTO ⇒ 403', async () => {
    for (const r of [Rol.ADMIN, Rol.FACTURACION, Rol.COORDINADOR]) {
      rol = r;
      const res = await request(http())
        .put(`/v1/flights/${V}/afac-real`)
        .send({ costo_real_mxn: 4500, notas: 'F-123' });
      expect(res.status).toBe(200);
    }
    expect(guardar).toHaveBeenLastCalledWith(
      V,
      { costo_real_mxn: 4500, notas: 'F-123' },
      USER,
    );
    for (const r of [Rol.ANALISTA, Rol.PILOTO, Rol.SOCIO]) {
      rol = r;
      expect(
        (
          await request(http())
            .put(`/v1/flights/${V}/afac-real`)
            .send({ costo_real_mxn: 1 })
        ).status,
      ).toBe(403);
    }
  });

  it('PUT: cuerpo ESTRICTO (texto, negativo, 3 decimales, sin monto, notas > 500, llaves de más) ⇒ 400 sin llamar al servicio; 0 sí', async () => {
    for (const body of [
      { costo_real_mxn: '4427.80' },
      { costo_real_mxn: '' },
      { costo_real_mxn: -1 },
      { costo_real_mxn: 1.234 },
      {},
      { costo_real_mxn: 1, notas: 'x'.repeat(501) },
      { costo_real_mxn: 1, otra: true },
    ]) {
      const res = await request(http())
        .put(`/v1/flights/${V}/afac-real`)
        .send(body);
      expect(res.status).toBe(400);
    }
    expect(guardar).not.toHaveBeenCalled();
    const cero = await request(http())
      .put(`/v1/flights/${V}/afac-real`)
      .send({ costo_real_mxn: 0, notas: null });
    expect(cero.status).toBe(200);
    expect(guardar).toHaveBeenCalledWith(
      V,
      { costo_real_mxn: 0, notas: null },
      USER,
    );
  });

  it('id no UUID ⇒ 400; DELETE quita (200) con el userId; PILOTO ⇒ 403', async () => {
    expect(
      (
        await request(http())
          .put('/v1/flights/236/afac-real')
          .send({ costo_real_mxn: 1 })
      ).status,
    ).toBe(400);
    const res = await request(http()).delete(`/v1/flights/${V}/afac-real`);
    expect(res.status).toBe(200);
    expect(quitar).toHaveBeenCalledWith(V, USER);
    rol = Rol.PILOTO;
    expect(
      (await request(http()).delete(`/v1/flights/${V}/afac-real`)).status,
    ).toBe(403);
  });
});
