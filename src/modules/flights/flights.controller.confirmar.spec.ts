// Cableado HTTP REAL de POST /v1/flights/:id/confirmar (16-oct-2026,
// invariante 84): Express 5 (sin body ⇒ `req.body` undefined) + ValidationPipe
// de main.ts + AllExceptionsFilter + versionado URI. Los servicios se
// stubbean para no arrastrar la cadena de imports (notifications/jose,
// calendar-sync/googleapis).
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
  ServiceUnavailableException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { Rol } from '../../common/types/auth.types';
import { CobroReciboService } from './cobro-recibo.service';
import { FacturaClienteService } from './factura-cliente.service';
import { FlightReportService } from './flight-report.service';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const LLAVE = 'aaaaaaaa-0000-4000-8000-00000000cccc';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';

type Servidor = Parameters<typeof request>[0];

describe('FlightsController — POST :id/confirmar por HTTP', () => {
  let app: INestApplication;
  const confirmar = jest.fn();
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FlightsController],
      providers: [
        { provide: FlightsService, useValue: { confirmar } },
        { provide: FlightReportService, useValue: {} },
        { provide: CobroReciboService, useValue: {} },
        { provide: FacturaClienteService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    // Misma configuración que main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    // Los guards globales viven en app.module (APP_GUARD): aquí solo se
    // inyecta el usuario que @CurrentUser lee de req.user.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { user: unknown }).user = {
        userId: USER,
        rol: 'ADMIN',
      };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    confirmar.mockReset();
    confirmar.mockResolvedValue({
      id: V1,
      folio: 118,
      estado: 'CONFIRMADO',
      avisos: [],
    });
  });

  it('solo ADMIN y COORDINADOR (metadata de @Roles que lee el guard global)', () => {
    // Descriptor y no `prototype.confirmar` (regla unbound-method).
    const handler = Object.getOwnPropertyDescriptor(
      FlightsController.prototype,
      'confirmar',
    )?.value as object;
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as Rol[];
    expect(roles).toEqual([Rol.ADMIN, Rol.COORDINADOR]);
  });

  it('sin body ni Content-Type (panel) → 200 y el service recibe banderas en falso/undefined', async () => {
    const res = await request(http()).post(`/v1/flights/${V1}/confirmar`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: V1,
      folio: 118,
      estado: 'CONFIRMADO',
      avisos: [],
    });
    expect(confirmar).toHaveBeenCalledWith(
      V1,
      { aceptarDiscrepanciaAlta: false, clientRequestId: undefined },
      USER,
    );
  });

  it('con {} → 200 (mismo contrato)', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V1}/confirmar`)
      .send({});
    expect(res.status).toBe(200);
    expect(confirmar).toHaveBeenCalledWith(
      V1,
      { aceptarDiscrepanciaAlta: false, clientRequestId: undefined },
      USER,
    );
  });

  it('con {client_request_id, aceptar_discrepancia_alta} (app) → el service los recibe', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V1}/confirmar`)
      .send({ client_request_id: LLAVE, aceptar_discrepancia_alta: true });
    expect(res.status).toBe(200);
    expect(confirmar).toHaveBeenCalledWith(
      V1,
      { aceptarDiscrepanciaAlta: true, clientRequestId: LLAVE },
      USER,
    );
  });

  it('ya CONFIRMADO: el 200 {idempotente: true} del service pasa tal cual', async () => {
    confirmar.mockResolvedValue({
      id: V1,
      estado: 'CONFIRMADO',
      avisos: [],
      idempotente: true,
    });
    const res = await request(http()).post(`/v1/flights/${V1}/confirmar`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ idempotente: true, avisos: [] });
  });

  it('client_request_id que no es uuid → 400 y el service NO se llama', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V1}/confirmar`)
      .send({ client_request_id: 'no-es-uuid' });
    expect(res.status).toBe(400);
    expect(confirmar).not.toHaveBeenCalled();
  });

  it('campo desconocido → 400 (forbidNonWhitelisted) y el service NO se llama', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V1}/confirmar`)
      .send({ motivo: 'no va aquí' });
    expect(res.status).toBe(400);
    expect(confirmar).not.toHaveBeenCalled();
  });

  it('id que no es uuid → 400', async () => {
    const res = await request(http()).post('/v1/flights/118/confirmar');
    expect(res.status).toBe(400);
    expect(confirmar).not.toHaveBeenCalled();
  });

  it('409 VUELO_SIN_ASIGNAR llega con code, message y details.falta', async () => {
    confirmar.mockRejectedValue(
      new ConflictException({
        message:
          'No se puede confirmar el vuelo #118: falta asignar el avión y el piloto.',
        error: 'VUELO_SIN_ASIGNAR',
        details: {
          falta: ['aeronave', 'piloto'],
          estado: 'RESERVA',
          folio: 118,
        },
      }),
    );
    const res = await request(http()).post(`/v1/flights/${V1}/confirmar`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      statusCode: 409,
      code: 'VUELO_SIN_ASIGNAR',
      message:
        'No se puede confirmar el vuelo #118: falta asignar el avión y el piloto.',
      details: { falta: ['aeronave', 'piloto'], estado: 'RESERVA', folio: 118 },
    });
  });

  it.each(['SQUAWK_ALTA_SIN_RESOLVER', 'VUELO_NO_CONFIRMABLE'])(
    '409 %s del service llega con el code intacto',
    async (code) => {
      confirmar.mockRejectedValue(
        new ConflictException({ message: 'rebote', error: code, details: {} }),
      );
      const res = await request(http()).post(`/v1/flights/${V1}/confirmar`);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        code,
        message: 'rebote',
      });
    },
  );

  it('503 CONFIRMACION_NO_DISPONIBLE (confirmador no inyectado) llega como 503 con code', async () => {
    confirmar.mockRejectedValue(
      new ServiceUnavailableException({
        message:
          'La confirmación de cotizaciones no está disponible en este momento.',
        error: 'CONFIRMACION_NO_DISPONIBLE',
      }),
    );
    const res = await request(http()).post(`/v1/flights/${V1}/confirmar`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      statusCode: 503,
      code: 'CONFIRMACION_NO_DISPONIBLE',
    });
  });
});
