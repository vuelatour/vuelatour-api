// Cableado HTTP REAL de la factura del servicio (22-sep-2026): ValidationPipe
// de main.ts (whitelist + forbidNonWhitelisted) + AllExceptionsFilter +
// versionado URI + FileInterceptor. Los servicios se stubbean para no
// arrastrar la cadena de imports (notifications/jose, calendar/googleapis).
jest.mock('./flights.service', () => ({ FlightsService: class {} }));
jest.mock('./flight-report.service', () => ({
  FlightReportService: class {},
}));
jest.mock('./cobro-recibo.service', () => ({ CobroReciboService: class {} }));

import {
  ConflictException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { CobroReciboService } from './cobro-recibo.service';
import { FacturaClienteService } from './factura-cliente.service';
import { FlightReportService } from './flight-report.service';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';

/**
 * ESTE spec existe porque el multipart es NUEVO en el repo (todo lo demás
 * sube en base64 dentro del JSON): hay que probar que el campo `file` llega
 * al servicio, que el camino base64 sigue sirviendo, y que el
 * `forbidNonWhitelisted` de main.ts no rechaza una petición multipart.
 */

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';

type Servidor = Parameters<typeof request>[0];
type CuerpoError = { statusCode: number; code: string; message: string };

describe('FlightsController — factura del servicio por HTTP', () => {
  let app: INestApplication;
  const setEstatus = jest.fn();
  const subirArchivo = jest.fn();
  const quitarArchivo = jest.fn();
  const archivoUrl = jest.fn();
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FlightsController],
      providers: [
        { provide: FlightsService, useValue: {} },
        { provide: FlightReportService, useValue: {} },
        { provide: CobroReciboService, useValue: {} },
        {
          provide: FacturaClienteService,
          useValue: { setEstatus, subirArchivo, quitarArchivo, archivoUrl },
        },
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
    for (const f of [setEstatus, subirArchivo, quitarArchivo, archivoUrl]) {
      f.mockReset();
    }
    const bloque = { estatus: 'ELABORADA_ENVIADA', archivo: null };
    setEstatus.mockResolvedValue(bloque);
    subirArchivo.mockResolvedValue(bloque);
    quitarArchivo.mockResolvedValue({ estatus: 'SIN_FACTURA', archivo: null });
    archivoUrl.mockResolvedValue({ url: 'https://firmada/x.pdf' });
  });

  it('PATCH con un estatus válido → 200 y el service recibe (id, estatus, userId)', async () => {
    const res = await request(http())
      .patch(`/v1/flights/${V1}/factura-cliente`)
      .send({ estatus: 'ELABORADA_ENVIADA' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ estatus: 'ELABORADA_ENVIADA', archivo: null });
    expect(setEstatus).toHaveBeenCalledWith(V1, 'ELABORADA_ENVIADA', USER);
  });

  it('PATCH con un estatus inventado → 400 y el service NO se llama', async () => {
    const res = await request(http())
      .patch(`/v1/flights/${V1}/factura-cliente`)
      .send({ estatus: 'EN_PROCESO' });
    expect(res.status).toBe(400);
    expect(setEstatus).not.toHaveBeenCalled();
  });

  it('PATCH con campo desconocido → 400 (forbidNonWhitelisted)', async () => {
    const res = await request(http())
      .patch(`/v1/flights/${V1}/factura-cliente`)
      .send({ estatus: 'FACTURADO', otra_cosa: 1 });
    expect(res.status).toBe(400);
    expect(setEstatus).not.toHaveBeenCalled();
  });

  it('PATCH de id que no es uuid → 400 antes de tocar el service', async () => {
    const res = await request(http())
      .patch('/v1/flights/no-es-uuid/factura-cliente')
      .send({ estatus: 'FACTURADO' });
    expect(res.status).toBe(400);
    expect(setEstatus).not.toHaveBeenCalled();
  });

  it('POST multipart con el campo `file`: el PDF llega al service', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V1}/factura-cliente/archivo`)
      .attach('file', Buffer.from('%PDF-1.7 dry'), {
        filename: 'Factura A-1.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(200);
    const [id, archivo, userId] = subirArchivo.mock.calls[0] as [
      string,
      { buffer: Buffer; nombre: string; mime: string },
      string,
    ];
    expect(id).toBe(V1);
    expect(userId).toBe(USER);
    expect(archivo.nombre).toBe('Factura A-1.pdf');
    expect(archivo.mime).toBe('application/pdf');
    expect(archivo.buffer.toString()).toBe('%PDF-1.7 dry');
  });

  it('POST JSON base64 (cliente sin multipart): mismo contrato', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V1}/factura-cliente/archivo`)
      .send({
        file_base64: Buffer.from('<cfdi/>').toString('base64'),
        filename: 'cfdi.xml',
        content_type: 'application/xml',
      });
    expect(res.status).toBe(200);
    const [, archivo] = subirArchivo.mock.calls[0] as [
      string,
      { buffer: Buffer; nombre: string },
    ];
    expect(archivo.nombre).toBe('cfdi.xml');
    expect(archivo.buffer.toString()).toBe('<cfdi/>');
  });

  it('POST sin archivo → 400 que dice CÓMO mandarlo, y el service NO se llama', async () => {
    const res = await request(http()).post(
      `/v1/flights/${V1}/factura-cliente/archivo`,
    );
    expect(res.status).toBe(400);
    expect((res.body as CuerpoError).message).toContain('file');
    expect(subirArchivo).not.toHaveBeenCalled();
  });

  it('DELETE del archivo → 200 y el service recibe (id, userId)', async () => {
    const res = await request(http()).delete(
      `/v1/flights/${V1}/factura-cliente/archivo`,
    );
    expect(res.status).toBe(200);
    expect(quitarArchivo).toHaveBeenCalledWith(V1, USER);
  });

  it('GET archivo-url → 200 con la URL firmada', async () => {
    const res = await request(http()).get(
      `/v1/flights/${V1}/factura-cliente/archivo-url`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://firmada/x.pdf' });
    expect(archivoUrl).toHaveBeenCalledWith(V1);
  });

  it('el 409 VUELO_CON_CFDI del service llega con su code y su mensaje', async () => {
    setEstatus.mockRejectedValue(
      new ConflictException({
        message: 'Este vuelo ya tiene un CFDI timbrado…',
        error: 'VUELO_CON_CFDI',
        details: { vuelo_id: V1 },
      }),
    );
    const res = await request(http())
      .patch(`/v1/flights/${V1}/factura-cliente`)
      .send({ estatus: 'SIN_FACTURA' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'VUELO_CON_CFDI',
      message: 'Este vuelo ya tiene un CFDI timbrado…',
      details: { vuelo_id: V1 },
    });
  });
});
