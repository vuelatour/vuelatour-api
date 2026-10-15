// El servicio real arrastra pyservices/IA: se stubbea; aquí se prueba el
// CABLEADO HTTP de «Omitir la conciliación» (14-oct-2026, API 0.0.77,
// invariante 75): rutas literales antes de `:id`, roles de la clase, DTOs con
// textos es-MX, 200 en las acciones, `esperado` de «clasificar» y
// `?solo_omitidos` de la lista.
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
import { errorOmitirNoDisponible } from '../../common/omision-cargos-disponible.util';
import { ConciliacionController } from './conciliacion.controller';
import { ConciliacionService } from './conciliacion.service';

type Servidor = Parameters<typeof request>[0];
/** Cuerpo de error del AllExceptionsFilter (supertest lo da como `any`). */
type CuerpoError = { code: string; message: string | string[] };
const cuerpoError = (r: { body: unknown }) => r.body as CuerpoError;
const M1 = 'dddddddd-0000-4000-8000-000000000001';
const M2 = 'dddddddd-0000-4000-8000-000000000002';
const C1 = 'dddddddd-0000-4000-8000-0000000000c1';

describe('ConciliacionController — omitir por metadata', () => {
  it('las rutas nuevas heredan los roles de la clase (ADMIN, FACTURACION)', () => {
    const proto = ConciliacionController.prototype as unknown as Record<
      string,
      object
    >;
    for (const m of ['revisarOmision', 'omitirMovimientos', 'quitarOmision']) {
      expect(Reflect.getMetadata(ROLES_KEY, proto[m])).toBeUndefined();
    }
    expect(Reflect.getMetadata(ROLES_KEY, ConciliacionController)).toEqual([
      Rol.ADMIN,
      Rol.FACTURACION,
    ]);
  });
});

describe('ConciliacionController — omitir por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    revisarOmision: jest
      .fn()
      .mockResolvedValue({ movimientos: [], no_existen: [], resumen: {} }),
    omitirMovimientos: jest.fn().mockResolvedValue({
      omitidos: 2,
      clasificacion_id: C1,
      movimientos: [],
    }),
    quitarOmision: jest
      .fn()
      .mockResolvedValue({ restaurados: 1, movimientos: [] }),
    clasificarMovimiento: jest
      .fn()
      .mockResolvedValue({ id: M1, omision: null }),
    list: jest.fn().mockResolvedValue({ data: [], count: 0 }),
    reversoCandidatos: jest.fn(),
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

  const post = (ruta: string, body: unknown) =>
    request(http())
      .post(`/v1/conciliacion/${ruta}`)
      .send(body as object);

  it('revisar: 200 y la lista tal cual (no cae en `movimientos/:id`)', async () => {
    const r = await post('movimientos/omitir/revisar', {
      movimiento_ids: [M1, M2],
    });
    expect(r.status).toBe(200);
    expect(svc.revisarOmision).toHaveBeenCalledWith([M1, M2]);
  });

  it('omitir: 200, el motivo recortado, quién y su nombre', async () => {
    const r = await post('movimientos/omitir', {
      movimiento_ids: [M1, M2],
      motivo: '   Comisión o IVA del banco  ',
      aceptar_riesgo_ids: [M2],
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      omitidos: 2,
      clasificacion_id: C1,
      movimientos: [],
    });
    expect(svc.omitirMovimientos).toHaveBeenCalledWith(
      expect.objectContaining({
        movimiento_ids: [M1, M2],
        motivo: 'Comisión o IVA del banco',
        aceptar_riesgo_ids: [M2],
      }),
      'u-1',
      'Alejandro Canales',
    );
  });

  it('deshacer: 200 con la lista y quién', async () => {
    const r = await post('movimientos/quitar-omision', {
      movimiento_ids: [M1],
    });
    expect(r.status).toBe(200);
    expect(svc.quitarOmision).toHaveBeenCalledWith([M1], 'u-1');
  });

  it('DTO: lista vacía, más de 200, repetidos, no uuid y campos de más ⇒ 400 sin llamar al servicio', async () => {
    const muchos = Array.from(
      { length: 201 },
      (_, i) => `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const casos: Array<[unknown, string | null]> = [
      [{ movimiento_ids: [] }, 'Elige al menos un movimiento.'],
      [
        { movimiento_ids: muchos },
        'Se trabajan hasta 200 movimientos por vez: divide la selección.',
      ],
      [
        { movimiento_ids: [M1, M1] },
        'Hay movimientos repetidos en la selección.',
      ],
      [
        { movimiento_ids: ['x'] },
        'Algún movimiento de la selección no es válido: recarga la página.',
      ],
      [{ movimiento_ids: [M1], extra: 1 }, null],
      [{}, null],
    ];
    for (const [body, texto] of casos) {
      for (const ruta of [
        'movimientos/omitir/revisar',
        'movimientos/quitar-omision',
      ]) {
        const r = await post(ruta, body);
        expect(r.status).toBe(400);
        if (texto) expect(cuerpoError(r).message).toContain(texto);
      }
    }
    expect(svc.revisarOmision).not.toHaveBeenCalled();
    expect(svc.quitarOmision).not.toHaveBeenCalled();
  }, 20_000);

  it('el motivo: 10..300 recortado, en una sola cadena', async () => {
    const corto = await post('movimientos/omitir', {
      movimiento_ids: [M1],
      motivo: '   corto    ',
    });
    expect(corto.status).toBe(400);
    expect(cuerpoError(corto).message).toContain(
      'El motivo debe tener al menos 10 caracteres.',
    );
    const largo = await post('movimientos/omitir', {
      movimiento_ids: [M1],
      motivo: 'x'.repeat(301),
    });
    expect(cuerpoError(largo).message).toContain(
      'El motivo admite hasta 300 caracteres.',
    );
    const sin = await post('movimientos/omitir', { movimiento_ids: [M1] });
    expect(sin.status).toBe(400);
    expect(cuerpoError(sin).message).toContain(
      'Escribe el motivo de la omisión.',
    );
    const avisos = await post('movimientos/omitir', {
      movimiento_ids: [M1],
      motivo: 'Comisión del banco',
      aceptar_riesgo_ids: ['no-uuid'],
    });
    expect(avisos.status).toBe(400);
    expect(svc.omitirMovimientos).not.toHaveBeenCalled();
  });

  it('503 del servicio llega con su código; COORDINADOR ⇒ 403', async () => {
    svc.omitirMovimientos.mockRejectedValueOnce(errorOmitirNoDisponible());
    const r = await post('movimientos/omitir', {
      movimiento_ids: [M1],
      motivo: 'Comisión del banco',
    });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({
      statusCode: 503,
      code: 'CONCILIACION_OMITIR_NO_DISPONIBLE',
      message: 'Esta opción todavía no está activa: avisa a sistemas.',
      details: { migracion: '20261014000002' },
    });
    rol = Rol.COORDINADOR;
    for (const [ruta, body] of [
      ['movimientos/omitir/revisar', { movimiento_ids: [M1] }],
      [
        'movimientos/omitir',
        { movimiento_ids: [M1], motivo: 'Comisión del banco' },
      ],
      ['movimientos/quitar-omision', { movimiento_ids: [M1] }],
    ] as const) {
      expect((await post(ruta, body)).status).toBe(403);
    }
  });

  it('clasificar pasa `esperado` (presente, null o ausente) y el nombre de quien firma', async () => {
    const ruta = `/v1/conciliacion/movimientos/${M1}/clasificar`;
    await request(http())
      .patch(ruta)
      .send({ clasificacion_id: C1, esperado_clasificacion_id: null })
      .expect(200);
    expect(svc.clasificarMovimiento).toHaveBeenLastCalledWith(
      M1,
      C1,
      undefined,
      'u-1',
      {
        esperado: null,
        usuarioNombre: 'Alejandro Canales',
      },
    );
    await request(http())
      .patch(ruta)
      .send({ clasificacion_id: null, esperado_clasificacion_id: C1 })
      .expect(200);
    expect(svc.clasificarMovimiento).toHaveBeenLastCalledWith(
      M1,
      null,
      undefined,
      'u-1',
      {
        esperado: C1,
        usuarioNombre: 'Alejandro Canales',
      },
    );
    await request(http())
      .patch(ruta)
      .send({ clasificacion_id: C1 })
      .expect(200);
    const ultima = svc.clasificarMovimiento.mock.calls.at(-1) as unknown[];
    expect((ultima[4] as { esperado: unknown }).esperado).toBeUndefined();
    expect(
      (
        await request(http())
          .patch(ruta)
          .send({ esperado_clasificacion_id: 'x' })
      ).status,
    ).toBe(400);
  });

  it('?solo_omitidos (booleano de query CRUDO)', async () => {
    for (const [v, esperado] of [
      ['true', true],
      ['1', true],
      ['false', false],
      ['0', false],
    ] as const) {
      await request(http())
        .get(`/v1/conciliacion/movimientos?solo_omitidos=${v}`)
        .expect(200);
      expect(svc.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ solo_omitidos: esperado }),
      );
    }
    expect(
      (
        await request(http()).get(
          '/v1/conciliacion/movimientos?solo_omitidos=si',
        )
      ).status,
    ).toBe(400);
  });
});
