// El servicio real arrastra pyservices/IA: se stubbea; aquí se prueba el
// CABLEADO HTTP de la conciliación al revés de una ENTRADA (14-oct-2026, API
// 0.0.78, invariante 78): `GET cobros/:id` y `GET ingresos/:id` con los
// roles de la CLASE, ParseUUIDPipe, los códigos estables y que
// `cobros-sin-banco` siga llegando a su método.
jest.mock('./conciliacion.service', () => ({ ConciliacionService: class {} }));

import {
  NotFoundException,
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
import { errorIngresosNoDisponibles } from '../../common/ingreso-disponible.util';
import { ConciliacionController } from './conciliacion.controller';
import { ConciliacionService } from './conciliacion.service';

type Servidor = Parameters<typeof request>[0];
const COBRO = 'd7b0890c-9d0f-441f-a5cd-edd27fa50f0f'; // #332
const INGRESO = 'ffb57607-77e4-4334-8ee9-94afdba75f91'; // ING-3

describe('ConciliacionController — conciliación al revés de una ENTRADA por metadata', () => {
  it('cobros/:id e ingresos/:id NO tienen @Roles propio: heredan ROLES_CONCILIACION (ADMIN, FACTURACION)', () => {
    const proto = ConciliacionController.prototype as unknown as Record<
      string,
      object
    >;
    expect(
      Reflect.getMetadata(ROLES_KEY, proto.conciliacionDeCobroVuelo),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(ROLES_KEY, proto.conciliacionDeIngresoBanco),
    ).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, ConciliacionController)).toEqual([
      Rol.ADMIN,
      Rol.FACTURACION,
    ]);
  });
});

describe('ConciliacionController — conciliación al revés de una ENTRADA por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    conciliacionDeEntrada: jest
      .fn()
      .mockResolvedValue({ estado: 'CONCILIADO', abonos: [] }),
    cobrosSinBanco: jest.fn().mockResolvedValue({ data: [] }),
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
        nombre: 'Alejandro Canales',
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

  it('ADMIN y FACTURACION ⇒ 200 con el origen correcto; el resto ⇒ 403 sin llamar al servicio', async () => {
    for (const r of [Rol.ADMIN, Rol.FACTURACION]) {
      rol = r;
      const c = await request(http()).get(`/v1/conciliacion/cobros/${COBRO}`);
      expect(c.status).toBe(200);
      expect(c.body).toEqual({ estado: 'CONCILIADO', abonos: [] });
      expect(svc.conciliacionDeEntrada).toHaveBeenLastCalledWith(
        'COBRO_VUELO',
        COBRO,
      );
      const i = await request(http()).get(
        `/v1/conciliacion/ingresos/${INGRESO}`,
      );
      expect(i.status).toBe(200);
      expect(svc.conciliacionDeEntrada).toHaveBeenLastCalledWith(
        'INGRESO',
        INGRESO,
      );
    }
    svc.conciliacionDeEntrada.mockClear();
    for (const r of [
      Rol.COORDINADOR,
      Rol.ANALISTA,
      Rol.SOCIO,
      Rol.PILOTO,
      Rol.MECANICO,
      Rol.VISITANTE,
    ]) {
      rol = r;
      expect(
        (await request(http()).get(`/v1/conciliacion/cobros/${COBRO}`)).status,
      ).toBe(403);
      expect(
        (await request(http()).get(`/v1/conciliacion/ingresos/${INGRESO}`))
          .status,
      ).toBe(403);
    }
    expect(svc.conciliacionDeEntrada).not.toHaveBeenCalled();
  }, 20_000);

  it('uuid inválido ⇒ 400 sin llamar al servicio', async () => {
    expect(
      (await request(http()).get('/v1/conciliacion/cobros/332')).status,
    ).toBe(400);
    expect(
      (await request(http()).get('/v1/conciliacion/ingresos/ING-3')).status,
    ).toBe(400);
    expect(svc.conciliacionDeEntrada).not.toHaveBeenCalled();
  });

  it('404 con `code` (COBRO_NO_EXISTE / INGRESO_NO_EXISTE) y 503 INGRESOS_NO_DISPONIBLE', async () => {
    svc.conciliacionDeEntrada.mockRejectedValueOnce(
      new NotFoundException({
        message: 'Ese cobro ya no existe: recarga la página.',
        error: 'COBRO_NO_EXISTE',
      }),
    );
    const c = await request(http()).get(`/v1/conciliacion/cobros/${COBRO}`);
    expect(c.status).toBe(404);
    expect(c.body).toMatchObject({
      code: 'COBRO_NO_EXISTE',
      message: 'Ese cobro ya no existe: recarga la página.',
    });
    svc.conciliacionDeEntrada.mockRejectedValueOnce(
      new NotFoundException({
        message: 'Ese ingreso ya no existe: recarga la página.',
        error: 'INGRESO_NO_EXISTE',
      }),
    );
    const i = await request(http()).get(`/v1/conciliacion/ingresos/${INGRESO}`);
    expect(i.status).toBe(404);
    expect(i.body).toMatchObject({
      code: 'INGRESO_NO_EXISTE',
      message: 'Ese ingreso ya no existe: recarga la página.',
    });
    svc.conciliacionDeEntrada.mockRejectedValueOnce(
      errorIngresosNoDisponibles(),
    );
    const s = await request(http()).get(`/v1/conciliacion/ingresos/${INGRESO}`);
    expect(s.status).toBe(503);
    expect((s.body as { code?: string }).code).toBe('INGRESOS_NO_DISPONIBLE');
  });

  it('GET cobros-sin-banco (otro segmento) sigue llegando a su método', async () => {
    const r = await request(http()).get(
      '/v1/conciliacion/cobros-sin-banco?desde=2026-09-01&hasta=2026-09-30',
    );
    expect(r.status).toBe(200);
    expect(svc.cobrosSinBanco).toHaveBeenCalledWith('2026-09-01', '2026-09-30');
    expect(svc.conciliacionDeEntrada).not.toHaveBeenCalled();
  });
});
