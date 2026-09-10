// Cableado HTTP REAL de la baja de vuelos (10-sep-2026): Express 5 (sin body
// ⇒ `req.body` undefined) + ValidationPipe de main.ts + AllExceptionsFilter +
// versionado URI. Los servicios se stubbean para no arrastrar la cadena de
// imports (notifications/jose, calendar-sync/googleapis).
jest.mock('./flights.service', () => ({ FlightsService: class {} }));
jest.mock('./flight-report.service', () => ({
  FlightReportService: class {},
}));
jest.mock('./cobro-recibo.service', () => ({ CobroReciboService: class {} }));

import {
  ConflictException,
  NotFoundException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { CobroReciboService } from './cobro-recibo.service';
import { FlightReportService } from './flight-report.service';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const LLAVE = 'aaaaaaaa-0000-4000-8000-00000000cccc';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';

type Servidor = Parameters<typeof request>[0];
type CuerpoError = {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
};

describe('FlightsController — DELETE :id y POST :id/cancel por HTTP', () => {
  let app: INestApplication;
  const deleteFlight = jest.fn();
  const cancel = jest.fn();
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FlightsController],
      providers: [
        { provide: FlightsService, useValue: { deleteFlight, cancel } },
        { provide: FlightReportService, useValue: {} },
        { provide: CobroReciboService, useValue: {} },
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
    deleteFlight.mockReset();
    cancel.mockReset();
    deleteFlight.mockResolvedValue({ deleted: true, id: V1, folio: 118 });
    cancel.mockResolvedValue({ id: V1, estado: 'CANCELADO' });
  });

  it('DELETE sin body ni Content-Type (panel viejo) → 200 y el service recibe motivo/llave undefined', async () => {
    const res = await request(http()).delete(`/v1/flights/${V1}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: V1, folio: 118 });
    expect(deleteFlight).toHaveBeenCalledWith(V1, USER, {
      motivo: undefined,
      clientRequestId: undefined,
    });
  });

  it('DELETE con Content-Type json y cuerpo vacío → 200 (body-parser lo vuelve {})', async () => {
    const res = await request(http())
      .delete(`/v1/flights/${V1}`)
      .set('Content-Type', 'application/json')
      .send('');
    expect(res.status).toBe(200);
    expect(deleteFlight).toHaveBeenCalledWith(V1, USER, {
      motivo: undefined,
      clientRequestId: undefined,
    });
  });

  it('DELETE con {motivo, client_request_id} (app) → el service los recibe', async () => {
    const res = await request(http())
      .delete(`/v1/flights/${V1}`)
      .send({ motivo: 'El cliente nunca confirmó', client_request_id: LLAVE });
    expect(res.status).toBe(200);
    expect(deleteFlight).toHaveBeenCalledWith(V1, USER, {
      motivo: 'El cliente nunca confirmó',
      clientRequestId: LLAVE,
    });
  });

  it('DELETE con motivo corto → 400 y el service NO se llama', async () => {
    const res = await request(http())
      .delete(`/v1/flights/${V1}`)
      .send({ motivo: 'nop' });
    expect(res.status).toBe(400);
    expect(deleteFlight).not.toHaveBeenCalled();
  });

  it('DELETE con campo desconocido → 400 (forbidNonWhitelisted) y el service NO se llama', async () => {
    const res = await request(http())
      .delete(`/v1/flights/${V1}`)
      .send({ otra_cosa: 1 });
    expect(res.status).toBe(400);
    expect(deleteFlight).not.toHaveBeenCalled();
  });

  it('DELETE de id que no es uuid → 400 antes de tocar el service', async () => {
    const res = await request(http()).delete('/v1/flights/abc');
    expect(res.status).toBe(400);
    expect(deleteFlight).not.toHaveBeenCalled();
  });

  it('DELETE: 404 estructurado del service llega como {statusCode, code: VUELO_NO_EXISTE, message, details}', async () => {
    deleteFlight.mockRejectedValue(
      new NotFoundException({
        message: `Vuelo ${V1} not found`,
        error: 'VUELO_NO_EXISTE',
        details: { vuelo_id: V1 },
      }),
    );
    const res = await request(http()).delete(`/v1/flights/${V1}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      statusCode: 404,
      code: 'VUELO_NO_EXISTE',
      message: `Vuelo ${V1} not found`,
      details: { vuelo_id: V1 },
    });
  });

  it('DELETE: 409 VUELO_CON_ACTIVIDAD con details numéricos llega tal cual', async () => {
    deleteFlight.mockRejectedValue(
      new ConflictException({
        message:
          'El vuelo tiene actividad registrada (cobros, gastos o tacómetros); cancélalo en lugar de borrarlo para no perder el rastro.',
        error: 'VUELO_CON_ACTIVIDAD',
        details: { cobros: 1, gastos: 0, tacos: 2 },
      }),
    );
    const res = await request(http()).delete(`/v1/flights/${V1}`);
    expect(res.status).toBe(409);
    const body = res.body as CuerpoError;
    expect(body.code).toBe('VUELO_CON_ACTIVIDAD');
    expect(body.details).toEqual({ cobros: 1, gastos: 0, tacos: 2 });
    expect(body.message).toMatch(/cancélalo en lugar de borrarlo/);
  });

  it('POST :id/cancel {motivo} → 200 y el service recibe (id, motivo, userId)', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V1}/cancel`)
      .send({ motivo: 'Cliente canceló' });
    expect(res.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith(V1, 'Cliente canceló', USER);
  });

  it('POST :id/cancel sin motivo → 400 (contrato intacto)', async () => {
    const res = await request(http()).post(`/v1/flights/${V1}/cancel`).send({});
    expect(res.status).toBe(400);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('POST :id/cancel: 409 VUELO_YA_CANCELADO llega con code y el message de siempre', async () => {
    cancel.mockRejectedValue(
      new ConflictException({
        message: 'No se puede cancelar un vuelo en estado CANCELADO',
        error: 'VUELO_YA_CANCELADO',
        details: { estado: 'CANCELADO', folio: 118 },
      }),
    );
    const res = await request(http())
      .post(`/v1/flights/${V1}/cancel`)
      .send({ motivo: 'Cliente canceló' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      statusCode: 409,
      code: 'VUELO_YA_CANCELADO',
      message: 'No se puede cancelar un vuelo en estado CANCELADO',
      details: { estado: 'CANCELADO', folio: 118 },
    });
  });
});
