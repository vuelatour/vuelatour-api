// El servicio real arrastra pyservices/IA: se stubbea; aquí se prueba el
// CABLEADO HTTP de «un cobro, varios abonos» (14-oct-2026, API 0.0.78,
// invariante 77): `corregir_comision` en el PATCH movimientos/:id/cobro (DTO
// con ValidationPipe real: booleano, forbidNonWhitelisted) y que los 409/400/
// 503 nuevos lleguen con su `code`, su texto es-MX y sus `details`.
jest.mock('./conciliacion.service', () => ({ ConciliacionService: class {} }));

import {
  BadRequestException,
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
import { Rol } from '../../common/types/auth.types';
import { errorCobrosParcialesNoDisponibles } from '../../common/cobros-parciales-disponible.util';
import { ConciliacionController } from './conciliacion.controller';
import { ConciliacionService } from './conciliacion.service';

type Servidor = Parameters<typeof request>[0];
const MOV = 'eeeeeeee-0000-4000-8000-000000000001';
const C1 = 'eeeeeeee-0000-4000-8000-000000000021';
const C2 = 'eeeeeeee-0000-4000-8000-000000000022';
const S1 = 'eeeeeeee-0000-4000-8000-000000000031';

describe('ConciliacionController — un cobro, varios abonos por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    linkCobro: jest.fn().mockResolvedValue({ id: MOV, cobros_n: 1 }),
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
    svc.linkCobro.mockResolvedValue({ id: MOV, cobros_n: 1 });
  });

  const patch = (body: unknown) =>
    request(http())
      .patch(`/v1/conciliacion/movimientos/${MOV}/cobro`)
      .send(body as object);

  it('corregir_comision: true viaja al service (con cobro_id y con cobro_ids de 1); false o ausente NO viaja', async () => {
    await patch({ cobro_id: C1, corregir_comision: true }).expect(200);
    expect(svc.linkCobro).toHaveBeenLastCalledWith(
      MOV,
      { cobro_id: C1, cobro_grupo_id: null, corregir_comision: true },
      'u-1',
    );
    await patch({ cobro_ids: [C1], corregir_comision: true }).expect(200);
    expect(svc.linkCobro).toHaveBeenLastCalledWith(
      MOV,
      {
        cobro_id: null,
        cobro_grupo_id: null,
        cobro_ids: [C1],
        corregir_comision: true,
      },
      'u-1',
    );
    await patch({ cobro_id: C1, corregir_comision: false }).expect(200);
    expect(svc.linkCobro).toHaveBeenLastCalledWith(
      MOV,
      { cobro_id: C1, cobro_grupo_id: null },
      'u-1',
    );
  }, 15000);

  it('DTO: corregir_comision no booleano (también «"false"», que la conversión implícita volvería true) o una propiedad desconocida ⇒ 400 sin llamar al service', async () => {
    for (const body of [
      { cobro_id: C1, corregir_comision: 'true' },
      { cobro_id: C1, corregir_comision: 'false' },
      { cobro_id: C1, corregir_comision: 1 },
      { cobro_id: C1, corregir_comision: null, otra: true },
      { cobro_id: C1, parcial: true },
    ]) {
      const r = await patch(body).expect(400);
      expect(r.body).toBeDefined();
    }
    expect(svc.linkCobro).not.toHaveBeenCalled();
  }, 15000);

  it('un 409 del service (ABONO_EXCEDE_COBRO) viaja con su code, el texto es-MX y los details con sugeridos', async () => {
    svc.linkCobro.mockRejectedValueOnce(
      new ConflictException({
        message:
          'Este abono ($69,183.00 MXN) es mayor que lo que falta del cobro del vuelo #315 ($68,205.55 MXN): sobran $977.45 MXN.',
        error: 'ABONO_EXCEDE_COBRO',
        details: {
          cobro_id: C1,
          excedente: 977.45,
          sugeridos: [{ cobro_id: C2, folio: 332, faltante: 977.45 }],
        },
      }),
    );
    const r = await patch({ cobro_id: C1 }).expect(409);
    const cuerpo = r.body as {
      code?: string;
      message?: string;
      details?: { sugeridos?: unknown[] };
    };
    expect(cuerpo.code).toBe('ABONO_EXCEDE_COBRO');
    expect(cuerpo.message).toContain('sobran $977.45 MXN');
    expect(cuerpo.details?.sugeridos).toEqual([
      { cobro_id: C2, folio: 332, faltante: 977.45 },
    ]);
  }, 15000);

  it('400 CORREGIR_COMISION_NO_APLICA y 503 CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE llegan con su code', async () => {
    svc.linkCobro.mockRejectedValueOnce(
      new BadRequestException({
        message:
          'La comisión solo se corrige al vincular UN cobro de vuelo que todavía no tiene abonos, cuando el depósito es menor o igual que el cobro.',
        error: 'CORREGIR_COMISION_NO_APLICA',
        details: { motivo: 'SOBRE' },
      }),
    );
    const r400 = await patch({
      cobro_grupo_id: S1,
      corregir_comision: true,
    }).expect(400);
    expect(r400.body).toMatchObject({
      code: 'CORREGIR_COMISION_NO_APLICA',
      details: { motivo: 'SOBRE' },
    });
    svc.linkCobro.mockRejectedValueOnce(errorCobrosParcialesNoDisponibles());
    const r503 = await patch({ cobro_id: C1 }).expect(503);
    expect(r503.body).toMatchObject({
      code: 'CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE',
      details: { migracion: '20261014000003' },
    });
  }, 15000);

  it('roles de siempre: fuera de ADMIN/FACTURACION ⇒ 403 sin llamar al service', async () => {
    rol = Rol.PILOTO;
    await patch({ cobro_id: C1, corregir_comision: true }).expect(403);
    expect(svc.linkCobro).not.toHaveBeenCalled();
    rol = Rol.FACTURACION;
    await patch({ cobro_id: C1, corregir_comision: true }).expect(200);
  }, 15000);
});
