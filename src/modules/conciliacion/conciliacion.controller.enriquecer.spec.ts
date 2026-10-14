// El servicio real arrastra pyservices/IA: se stubbea; aquí se prueba el
// CABLEADO HTTP del concepto del SPEI (13-oct-2026, API 0.0.75, invariante
// 69): la vista previa `POST importar/vista-previa` (200, sin escribir,
// roles de la clase) y `solo_enriquecer` en el cuerpo de la importación.
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
import { ConciliacionController } from './conciliacion.controller';
import { ConciliacionService } from './conciliacion.service';

type Servidor = Parameters<typeof request>[0];
const CTA = 'eeeeeeee-0000-4000-8000-000000000001';
const MOVS = [
  {
    fecha: '2026-09-07',
    tipo: 'CARGO',
    monto: 1118.12,
    descripcion: 'SEL TRANSF. INTERBANCARIA SPEI BANORTE fact vip 7350',
  },
];
const VISTA = {
  total: 1,
  ya_estaban: 1,
  nuevos: 0,
  nuevos_mismo_dia_y_monto: 0,
  se_enriquecen: 1,
  enriquecimiento_omitidos: 0,
  moneda: 'MXN',
  omitidos: [],
  nuevos_detalle: [],
  enriquecibles_detalle: [],
};

describe('ConciliacionController — concepto del SPEI por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    vistaPreviaImport: jest.fn().mockResolvedValue(VISTA),
    importar: jest.fn().mockResolvedValue({ importados: 0 }),
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
    svc.vistaPreviaImport.mockResolvedValue(VISTA);
    svc.importar.mockResolvedValue({ importados: 0 });
  });

  const vista = (body: unknown) =>
    request(http())
      .post('/v1/conciliacion/importar/vista-previa')
      .send(body as object);

  it('vista previa: 200 (no 201) y el cuerpo viaja SIN archivo', async () => {
    const r = await vista({
      cuenta_bancaria_id: CTA,
      movimientos: MOVS,
    }).expect(200);
    expect(r.body).toEqual(VISTA);
    expect(svc.vistaPreviaImport).toHaveBeenCalledTimes(1);
    const [dto] = svc.vistaPreviaImport.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(dto.cuenta_bancaria_id).toBe(CTA);
    expect(dto.file_base64).toBeUndefined();
    expect(svc.importar).not.toHaveBeenCalled();
  }, 15000);

  it('solo ADMIN y FACTURACION (roles de la clase)', async () => {
    rol = Rol.FACTURACION;
    await vista({ cuenta_bancaria_id: CTA, movimientos: MOVS }).expect(200);
    for (const otro of [Rol.COORDINADOR, Rol.PILOTO, Rol.SOCIO]) {
      rol = otro;
      await vista({ cuenta_bancaria_id: CTA, movimientos: MOVS }).expect(403);
    }
    expect(svc.vistaPreviaImport).toHaveBeenCalledTimes(1);
  }, 15000);

  it('cuenta inválida ⇒ 400 sin llamar al servicio', async () => {
    await vista({ cuenta_bancaria_id: 'no-uuid', movimientos: MOVS }).expect(
      400,
    );
    expect(svc.vistaPreviaImport).not.toHaveBeenCalled();
  }, 15000);

  it('importar: `solo_enriquecer: true` llega al servicio; «"si"» ⇒ 400', async () => {
    await request(http())
      .post('/v1/conciliacion/importar')
      .send({
        cuenta_bancaria_id: CTA,
        movimientos: MOVS,
        solo_enriquecer: true,
      })
      .expect(201);
    const [dto] = svc.importar.mock.calls[0] as [Record<string, unknown>];
    expect(dto.solo_enriquecer).toBe(true);
    await request(http())
      .post('/v1/conciliacion/importar')
      .send({
        cuenta_bancaria_id: CTA,
        movimientos: MOVS,
        solo_enriquecer: 'si',
      })
      .expect(400);
    expect(svc.importar).toHaveBeenCalledTimes(1);
  }, 15000);
});
