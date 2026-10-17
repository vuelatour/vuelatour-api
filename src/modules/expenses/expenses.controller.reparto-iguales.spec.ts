// Los servicios reales arrastran BD, pyservices e IA: se stubbean; aquí se
// prueba el CABLEADO HTTP de `POST /v1/expenses/reparto-iguales` (16-oct-2026,
// API 0.0.90, invariante 91): roles, DTO estricto (booleano CRUDO), la ruta
// literal antes de `:id` y `excluir_categoria` en la lista y el Excel.
jest.mock('./expenses.service', () => ({ ExpensesService: class {} }));
jest.mock('./combustible-masivo.service', () => ({
  CombustibleMasivoService: class {},
}));

import {
  BadRequestException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { CombustibleMasivoService } from './combustible-masivo.service';

type Servidor = Parameters<typeof request>[0];
/** Cuerpo de error del AllExceptionsFilter. */
type CuerpoError = { code: string; message: string | string[] };

const G1 = '0f5e6659-2c39-40d0-89d5-3fbd8d98537d';
const G2 = 'e0e069f3-5def-499e-b87c-c95160fc6b66';
const N41 = '5a82eb4a-086c-4058-97bd-b2aacdc2e942';
const VGV = '3d0546c3-941f-45cc-b8a9-e3ee77545e68';
const RESPUESTA = {
  simulado: true,
  quitar: false,
  aeronaves: [{ id: N41, matricula: 'N4142R' }],
  gastos: [],
  totales: [],
  aplicados: 0,
  errores: 0,
};

describe('POST /v1/expenses/reparto-iguales — nómina en partes iguales', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    putRepartoIguales: jest.fn(),
    putRepartoMasivo: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    listXlsx: jest.fn(),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;
  const ruta = '/v1/expenses/reparto-iguales';
  const CUERPO = { gasto_ids: [G1, G2], aeronave_ids: [N41, VGV] };

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
    svc.putRepartoIguales.mockResolvedValue(RESPUESTA);
    svc.list.mockResolvedValue({ data: [], count: 0, limit: 50, offset: 0 });
    svc.listXlsx.mockResolvedValue(Buffer.from('xlsx'));
  });

  it('ADMIN, COORDINADOR y FACTURACION ⇒ 200 (no 201) con la respuesta del servicio, que recibe (dto, usuario)', async () => {
    for (const r of [Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION]) {
      rol = r;
      const res = await request(http()).post(ruta).send(CUERPO);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(RESPUESTA);
      expect(svc.putRepartoIguales).toHaveBeenLastCalledWith(CUERPO, 'u-1');
    }
    expect(svc.findById).not.toHaveBeenCalled();
  }, 20_000);

  it('ANALISTA, SOCIO, PILOTO, MECANICO y VISITANTE ⇒ 403 sin llamar al servicio', async () => {
    for (const r of [
      Rol.ANALISTA,
      Rol.SOCIO,
      Rol.PILOTO,
      Rol.MECANICO,
      Rol.VISITANTE,
    ]) {
      rol = r;
      const res = await request(http()).post(ruta).send(CUERPO);
      expect(res.status).toBe(403);
      expect((res.body as CuerpoError).code).toBe('FORBIDDEN');
    }
    expect(svc.putRepartoIguales).not.toHaveBeenCalled();
  }, 20_000);

  it('@Roles = los MISMOS del reparto masivo', () => {
    const roles = (metodo: string) =>
      Reflect.getMetadata(
        ROLES_KEY,
        Object.getOwnPropertyDescriptor(ExpensesController.prototype, metodo)!
          .value as object,
      ) as Rol[];
    expect(roles('repartoIguales')).toEqual(roles('repartoMasivo'));
    expect(roles('repartoIguales')).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
    ]);
  });

  it('la ruta literal se declara ANTES de las rutas `:id` del controller', () => {
    const fuente = readFileSync(
      join(__dirname, 'expenses.controller.ts'),
      'utf8',
    );
    const literal = fuente.indexOf("@Post('reparto-iguales')");
    expect(literal).toBeGreaterThan(-1);
    for (const ruta of [
      "@Get(':id')",
      "@Post(':id/",
      "@Put(':id/",
      "@Patch(':id')",
    ]) {
      expect([ruta, literal < fuente.indexOf(ruta)]).toEqual([ruta, true]);
    }
  });

  it('simular true/false viaja tal cual; aeronave_ids [] (quitar) es válido', async () => {
    for (const simular of [true, false]) {
      const res = await request(http())
        .post(ruta)
        .send({ ...CUERPO, simular });
      expect(res.status).toBe(200);
      expect(svc.putRepartoIguales).toHaveBeenLastCalledWith(
        { ...CUERPO, simular },
        'u-1',
      );
    }
    const quitar = await request(http())
      .post(ruta)
      .send({ gasto_ids: [G1], aeronave_ids: [] });
    expect(quitar.status).toBe(200);
    expect(svc.putRepartoIguales).toHaveBeenLastCalledWith(
      { gasto_ids: [G1], aeronave_ids: [] },
      'u-1',
    );
  });

  it('DTO estricto ⇒ 400 BAD_REQUEST sin llamar al servicio (simular "false" crudo, vacíos, repetidos, uuid, tope, llaves de más)', async () => {
    const muchos = Array.from(
      { length: 201 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const aviones21 = muchos.slice(0, 21);
    const casos: Array<[Record<string, unknown>, string]> = [
      // Con enableImplicitConversion, 'false' sería Boolean('false') = true
      // y ESCRIBIRÍA: se valida el valor CRUDO del body.
      [{ ...CUERPO, simular: 'false' }, 'simular debe ser true o false'],
      [{ ...CUERPO, simular: 'true' }, 'simular debe ser true o false'],
      [{ ...CUERPO, simular: 1 }, 'simular debe ser true o false'],
      [{ ...CUERPO, gasto_ids: [] }, 'Elige al menos un pago.'],
      [{ ...CUERPO, gasto_ids: [G1, G1] }, 'Hay un pago repetido en la lista.'],
      [
        { ...CUERPO, gasto_ids: ['no-uuid'] },
        'Cada pago debe ser un id válido (uuid).',
      ],
      [
        { ...CUERPO, gasto_ids: muchos },
        'Se reparten hasta 200 pagos por vez.',
      ],
      [
        { ...CUERPO, aeronave_ids: [N41, N41] },
        'Hay un avión repetido en la lista.',
      ],
      [
        { ...CUERPO, aeronave_ids: ['x'] },
        'Cada avión debe ser un id válido (uuid).',
      ],
      [
        { ...CUERPO, aeronave_ids: aviones21 },
        'Se reparte entre hasta 20 aviones.',
      ],
      [{ gasto_ids: [G1] }, 'aeronave_ids debe ser una lista de aviones'],
      [{ ...CUERPO, items: [] }, 'property items should not exist'],
      [{ ...CUERPO, porcentaje: 25 }, 'property porcentaje should not exist'],
    ];
    for (const [cuerpo, mensaje] of casos) {
      const res = await request(http()).post(ruta).send(cuerpo);
      expect([mensaje, res.status]).toEqual([mensaje, 400]);
      const error = res.body as CuerpoError;
      expect(error.code).toBe('BAD_REQUEST');
      expect(([] as string[]).concat(error.message)).toContain(mensaje);
    }
    expect(svc.putRepartoIguales).not.toHaveBeenCalled();
  }, 20_000);

  it('el 400 AERONAVE_INACTIVA del servicio llega con su code', async () => {
    svc.putRepartoIguales.mockRejectedValueOnce(
      new BadRequestException({
        message:
          'Alguno de los aviones elegidos no existe o está inactivo: solo se reparte entre aviones activos.',
        error: 'AERONAVE_INACTIVA',
        details: { aeronave_ids: [VGV] },
      }),
    );
    const res = await request(http()).post(ruta).send(CUERPO);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'AERONAVE_INACTIVA',
      message:
        'Alguno de los aviones elegidos no existe o está inactivo: solo se reparte entre aviones activos.',
      details: { aeronave_ids: [VGV] },
    });
  });

  it('GET /v1/expenses y /export aceptan `excluir_categoria` (enum) y lo pasan al servicio; un valor fuera del enum ⇒ 400', async () => {
    const lista = await request(http())
      .get('/v1/expenses')
      .query({ excluir_categoria: 'NOMINA', pendientes: 'true' });
    expect(lista.status).toBe(200);
    expect(svc.list).toHaveBeenLastCalledWith(
      expect.objectContaining({
        excluir_categoria: 'NOMINA',
        pendientes: true,
      }),
    );
    const xlsx = await request(http())
      .get('/v1/expenses/export')
      .query({ excluir_categoria: 'NOMINA' });
    expect(xlsx.status).toBe(200);
    expect(svc.listXlsx).toHaveBeenLastCalledWith(
      expect.objectContaining({ excluir_categoria: 'NOMINA' }),
      { detalleBanco: true },
    );
    const malo = await request(http())
      .get('/v1/expenses')
      .query({ excluir_categoria: 'NOMINAS' });
    expect(malo.status).toBe(400);
    expect(svc.list).toHaveBeenCalledTimes(1);
  });
});
