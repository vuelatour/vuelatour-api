// Cableado HTTP REAL de «Omitir el tacómetro» (15-oct-2026, invariante 79):
// rutas y métodos, roles (RolesGuard), 400 del DTO en es-MX y `code`/`details`
// del AllExceptionsFilter en 404/409/503. El servicio se stubbea para no
// arrastrar la cadena de imports (notifications/jose, calendar/googleapis).
jest.mock('./flights.service', () => ({ FlightsService: class {} }));
jest.mock('./flight-report.service', () => ({
  FlightReportService: class {},
}));
jest.mock('./cobro-recibo.service', () => ({ CobroReciboService: class {} }));
jest.mock('./factura-solicitud.service', () => ({
  FacturaSolicitudService: class {},
}));
jest.mock('./factura-cliente.service', () => ({
  FacturaClienteService: class {},
}));

import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
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
import { CobroReciboService } from './cobro-recibo.service';
import { FacturaClienteService } from './factura-cliente.service';
import { FlightReportService } from './flight-report.service';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';

const LEG = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';
const RUTA = `/v1/flights/legs/${LEG}/taco/omitir`;
const MSG_MOTIVO =
  'Escribe el motivo por el que no se pudo capturar el tacómetro (de 10 a 500 caracteres).';

type Servidor = Parameters<typeof request>[0];
type CuerpoError = {
  statusCode: number;
  code: string;
  message: string | string[];
  details?: unknown;
};

const RESPUESTA = {
  escala: { id: LEG, taco_omitido_por_nombre: 'Itzi' },
  vuelo: {
    id: 'v300',
    folio: 300,
    estado: 'EN_VUELO',
    completable: true,
    requiere_iniciar: false,
    omitidos: 1,
  },
};

describe('FlightsController — POST/DELETE legs/:legId/taco/omitir por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const omitirTaco = jest.fn();
  const deshacerOmisionTaco = jest.fn();
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FlightsController],
      providers: [
        {
          provide: FlightsService,
          useValue: { omitirTaco, deshacerOmisionTaco },
        },
        { provide: FlightReportService, useValue: {} },
        { provide: CobroReciboService, useValue: {} },
        { provide: FacturaClienteService, useValue: {} },
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
      (req as unknown as { user: unknown }).user = { userId: USER, rol };
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
    omitirTaco.mockReset().mockResolvedValue(RESPUESTA);
    deshacerOmisionTaco.mockReset().mockResolvedValue(RESPUESTA);
  });

  it('POST con motivo ⇒ 200 y el service recibe (legId, dto, userId)', async () => {
    const res = await request(http())
      .post(RUTA)
      .send({ motivo: 'Falló el tacómetro' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(RESPUESTA);
    expect(omitirTaco).toHaveBeenCalledWith(
      LEG,
      { motivo: 'Falló el tacómetro' },
      USER,
    );
  });

  it('DELETE sin cuerpo ⇒ 200 y el service recibe (legId, userId)', async () => {
    const res = await request(http()).delete(RUTA);
    expect(res.status).toBe(200);
    expect(deshacerOmisionTaco).toHaveBeenCalledWith(LEG, USER);
  });

  it('ADMIN, COORDINADOR y FACTURACION pasan; PILOTO, MECANICO, VISITANTE, ANALISTA y SOCIO ⇒ 403 sin tocar el service', async () => {
    for (const r of [Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION]) {
      rol = r;
      const p = await request(http())
        .post(RUTA)
        .send({ motivo: 'Falló el tacómetro' });
      expect(p.status).toBe(200);
      const d = await request(http()).delete(RUTA);
      expect(d.status).toBe(200);
    }
    omitirTaco.mockClear();
    deshacerOmisionTaco.mockClear();
    for (const r of [
      Rol.PILOTO,
      Rol.MECANICO,
      Rol.VISITANTE,
      Rol.ANALISTA,
      Rol.SOCIO,
    ]) {
      rol = r;
      const p = await request(http())
        .post(RUTA)
        .send({ motivo: 'Falló el tacómetro' });
      expect(p.status).toBe(403);
      const d = await request(http()).delete(RUTA);
      expect(d.status).toBe(403);
    }
    expect(omitirTaco).not.toHaveBeenCalled();
    expect(deshacerOmisionTaco).not.toHaveBeenCalled();
  });

  it.each([
    ['sin motivo', {}],
    ['motivo de 9 caracteres', { motivo: 'x'.repeat(9) }],
    ['motivo de 501 caracteres', { motivo: 'x'.repeat(501) }],
    ['motivo null', { motivo: null }],
  ])(
    'POST %s ⇒ 400 con el texto es-MX y el service NO se llama',
    async (_n, body) => {
      const res = await request(http()).post(RUTA).send(body);
      expect(res.status).toBe(400);
      const cuerpo = res.body as CuerpoError;
      const msg = Array.isArray(cuerpo.message)
        ? cuerpo.message.join(' | ')
        : cuerpo.message;
      expect(msg).toContain(MSG_MOTIVO);
      expect(omitirTaco).not.toHaveBeenCalled();
    },
  );

  it('POST con campo desconocido ⇒ 400 (forbidNonWhitelisted)', async () => {
    const res = await request(http())
      .post(RUTA)
      .send({ motivo: 'Falló el tacómetro', otra: 1 });
    expect(res.status).toBe(400);
    expect(omitirTaco).not.toHaveBeenCalled();
  });

  it('legId que no es uuid ⇒ 400 antes de tocar el service', async () => {
    const res = await request(http())
      .post('/v1/flights/legs/abc/taco/omitir')
      .send({ motivo: 'Falló el tacómetro' });
    expect(res.status).toBe(400);
    expect(omitirTaco).not.toHaveBeenCalled();
  });

  it('503 MIGRACION_PENDIENTE: el filtro proyecta code y details', async () => {
    omitirTaco.mockRejectedValue(
      new ServiceUnavailableException({
        message: 'Omitir el tacómetro necesita la migración 20261015000001',
        error: 'MIGRACION_PENDIENTE',
        details: { migracion: '20261015000001' },
      }),
    );
    const res = await request(http())
      .post(RUTA)
      .send({ motivo: 'Falló el tacómetro' });
    expect(res.status).toBe(503);
    const cuerpo = res.body as CuerpoError;
    expect(cuerpo.code).toBe('MIGRACION_PENDIENTE');
    expect(cuerpo.details).toEqual({ migracion: '20261015000001' });
  });

  it('404 ESCALA_NO_EXISTE y 409 TACO_YA_OMITIDO / TACO_NO_OMITIDO con details', async () => {
    omitirTaco.mockRejectedValueOnce(
      new NotFoundException({
        message: 'Ese tramo ya no existe',
        error: 'ESCALA_NO_EXISTE',
        details: { escala_id: LEG },
      }),
    );
    const r404 = await request(http())
      .post(RUTA)
      .send({ motivo: 'Falló el tacómetro' });
    expect(r404.status).toBe(404);
    expect((r404.body as CuerpoError).code).toBe('ESCALA_NO_EXISTE');
    expect((r404.body as CuerpoError).details).toEqual({ escala_id: LEG });

    const det = {
      por: USER,
      nombre: 'Itzi',
      at: '2026-10-15T15:40:00.000Z',
      motivo: 'Falló el tacómetro',
    };
    omitirTaco.mockRejectedValueOnce(
      new ConflictException({
        message: 'Este tramo ya tiene el tacómetro omitido',
        error: 'TACO_YA_OMITIDO',
        details: det,
      }),
    );
    const r409 = await request(http())
      .post(RUTA)
      .send({ motivo: 'Falló el tacómetro' });
    expect(r409.status).toBe(409);
    expect((r409.body as CuerpoError).code).toBe('TACO_YA_OMITIDO');
    expect((r409.body as CuerpoError).details).toEqual(det);

    deshacerOmisionTaco.mockRejectedValueOnce(
      new ConflictException({
        message: 'Este tramo no tiene el tacómetro omitido',
        error: 'TACO_NO_OMITIDO',
        details: { escala_id: LEG },
      }),
    );
    const d409 = await request(http()).delete(RUTA);
    expect(d409.status).toBe(409);
    expect((d409.body as CuerpoError).code).toBe('TACO_NO_OMITIDO');
  });
});
