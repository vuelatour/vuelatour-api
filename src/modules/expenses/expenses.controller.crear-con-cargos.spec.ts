// Los servicios reales arrastran BD, pyservices e IA: se stubbean; aquí se
// prueba el CABLEADO HTTP del campo `conciliar_con_movimientos` de
// `POST /v1/expenses` («Créalo por la suma», 14-oct-2026, API 0.0.77,
// invariante 76): 403 a quien no concilia ANTES del servicio y el DTO.
jest.mock('./expenses.service', () => ({ ExpensesService: class {} }));
jest.mock('./combustible-masivo.service', () => ({
  CombustibleMasivoService: class {},
}));

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { MENSAJE_LOTE_CARGOS_INVALIDO } from '../conciliacion/cargos-a-gasto.util';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { CombustibleMasivoService } from './combustible-masivo.service';

type Servidor = Parameters<typeof request>[0];
/** Cuerpo de error del AllExceptionsFilter (supertest lo da como `any`). */
type CuerpoError = { code: string; message: string | string[] };
const cuerpoError = (r: { body: unknown }) => r.body as CuerpoError;
const C1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const C2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const LLAVE = '11111111-2222-4333-8444-555555555555';

describe('POST /v1/expenses con `conciliar_con_movimientos`', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    create: jest.fn().mockResolvedValue({ id: 'g-1', conciliacion: {} }),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;
  const cuerpo = (extra: Record<string, unknown> = {}) => ({
    categoria: 'OPERACIONES',
    monto: 9700,
    moneda: 'MXN',
    fecha_gasto: '2026-09-24',
    medio_pago: 'TRANSFERENCIA',
    client_request_id: LLAVE,
    conciliar_con_movimientos: [C1, C2],
    ...extra,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ExpensesController],
      providers: [
        { provide: ExpensesService, useValue: svc },
        { provide: CombustibleMasivoService, useValue: {} },
      ],
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

  it('ADMIN y FACTURACION llegan al servicio con los ids', async () => {
    for (const r of [Rol.ADMIN, Rol.FACTURACION]) {
      rol = r;
      const res = await request(http()).post('/v1/expenses').send(cuerpo());
      expect(res.status).toBe(201);
      expect(svc.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          conciliar_con_movimientos: [C1, C2],
          client_request_id: LLAVE,
        }),
        'u-1',
        r,
      );
    }
  });

  it('quien no concilia ⇒ 403 CONCILIAR_SOLO_ADMIN_FACTURACION sin llamar al servicio', async () => {
    for (const r of [Rol.COORDINADOR, Rol.PILOTO, Rol.MECANICO]) {
      rol = r;
      const res = await request(http())
        .post('/v1/expenses')
        .send(cuerpo(r === Rol.MECANICO ? { categoria: 'GAS' } : {}));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: 'CONCILIAR_SOLO_ADMIN_FACTURACION',
        message: 'Solo Administración y Facturación concilian con el banco.',
      });
    }
    expect(svc.create).not.toHaveBeenCalled();
    // Sin el campo, el COORDINADOR captura como siempre.
    rol = Rol.COORDINADOR;
    const { conciliar_con_movimientos: _fuera, ...sinCampo } = cuerpo();
    void _fuera;
    expect(
      (await request(http()).post('/v1/expenses').send(sinCampo)).status,
    ).toBe(201);
  });

  it('la llave en `null` = ausente (el MISMO criterio del servicio): 201 para cualquier rol que captura', async () => {
    for (const r of [Rol.COORDINADOR, Rol.PILOTO, Rol.ADMIN]) {
      rol = r;
      const res = await request(http())
        .post('/v1/expenses')
        .send(cuerpo({ conciliar_con_movimientos: null }));
      expect(res.status).toBe(201);
      expect(svc.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ conciliar_con_movimientos: null }),
        'u-1',
        r,
      );
    }
  });

  it('DTO: 1 cargo, repetidos, más de 50 o no uuid ⇒ 400 con el texto del lote', async () => {
    const muchos = Array.from(
      { length: 51 },
      (_, i) => `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    for (const ids of [[C1], [C1, C1], muchos]) {
      const res = await request(http())
        .post('/v1/expenses')
        .send(cuerpo({ conciliar_con_movimientos: ids }));
      expect(res.status).toBe(400);
      expect(cuerpoError(res).message).toContain(MENSAJE_LOTE_CARGOS_INVALIDO);
    }
    const res = await request(http())
      .post('/v1/expenses')
      .send(cuerpo({ conciliar_con_movimientos: [C1, 'x'] }));
    expect(res.status).toBe(400);
    expect(svc.create).not.toHaveBeenCalled();
  });
});
