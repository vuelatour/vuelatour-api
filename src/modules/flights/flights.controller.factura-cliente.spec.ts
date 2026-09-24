// Cableado HTTP REAL de la factura del servicio (22-sep-2026): ValidationPipe
// de main.ts (whitelist + forbidNonWhitelisted) + AllExceptionsFilter +
// versionado URI + FileInterceptor. Los servicios se stubbean para no
// arrastrar la cadena de imports (notifications/jose, calendar/googleapis).
jest.mock('./flights.service', () => ({ FlightsService: class {} }));
jest.mock('./flight-report.service', () => ({
  FlightReportService: class {},
}));
jest.mock('./cobro-recibo.service', () => ({ CobroReciboService: class {} }));
// «Necesito factura» (24-sep-2026): arrastra notifications/jose.
jest.mock('./factura-solicitud.service', () => ({
  FacturaSolicitudService: class {},
}));

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
  const actualizar = jest.fn();
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
          useValue: { actualizar, subirArchivo, quitarArchivo, archivoUrl },
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
    for (const f of [actualizar, subirArchivo, quitarArchivo, archivoUrl]) {
      f.mockReset();
    }
    const bloque = { estatus: 'ELABORADA_ENVIADA', archivo: null };
    actualizar.mockResolvedValue(bloque);
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
    expect(actualizar).toHaveBeenCalledWith(
      V1,
      { estatus: 'ELABORADA_ENVIADA' },
      USER,
    );
  });

  it('PATCH con un estatus inventado → 400 y el service NO se llama', async () => {
    const res = await request(http())
      .patch(`/v1/flights/${V1}/factura-cliente`)
      .send({ estatus: 'EN_PROCESO' });
    expect(res.status).toBe(400);
    expect(actualizar).not.toHaveBeenCalled();
  });

  it('PATCH con campo desconocido → 400 (forbidNonWhitelisted)', async () => {
    const res = await request(http())
      .patch(`/v1/flights/${V1}/factura-cliente`)
      .send({ estatus: 'FACTURADO', otra_cosa: 1 });
    expect(res.status).toBe(400);
    expect(actualizar).not.toHaveBeenCalled();
  });

  it('PATCH de id que no es uuid → 400 antes de tocar el service', async () => {
    const res = await request(http())
      .patch('/v1/flights/no-es-uuid/factura-cliente')
      .send({ estatus: 'FACTURADO' });
    expect(res.status).toBe(400);
    expect(actualizar).not.toHaveBeenCalled();
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
    // Sin campo `folio` el service recibe null (no se toca el que ya había).
    const opts = (subirArchivo.mock.calls[0] as unknown[])[3];
    expect(opts).toEqual({ folio: null });
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
    actualizar.mockRejectedValue(
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

/**
 * DIAGNÓSTICO de la subida (24-sep-2026). El vuelo #297 quedó «Facturado»
 * SIN archivo y el bucket `facturas/vuelos/` está vacío. (Los logs de
 * Supabase del 23-sep muestran que ese PDF de 50 KB SÍ se subió y que 9 min
 * después se QUITÓ con `DELETE …/archivo`; este spec blinda la cadena para
 * archivos grandes y errores legibles.) Aquí se reproduce el flujo REAL del lado API —
 * el mismo multipart que arma la server action del panel (`FormData` con el
 * campo `file` + el campo de texto `folio`) con un PDF típico de 2.5 MB —
 * por la cadena completa: ValidationPipe (whitelist + forbidNonWhitelisted),
 * FileInterceptor con su tope y AllExceptionsFilter.
 */
describe('FlightsController — subida REAL de la factura (diagnóstico 24-sep)', () => {
  let app: INestApplication;
  const actualizar = jest.fn();
  const subirArchivo = jest.fn();
  const http = (): Servidor => app.getHttpServer() as Servidor;
  const MB = 1024 * 1024;

  /** «PDF» de `bytes` bytes (cabecera real + relleno). */
  const pdfDe = (bytes: number) => {
    const b = Buffer.alloc(bytes, 0x20);
    b.write('%PDF-1.7\n', 0, 'latin1');
    return b;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FlightsController],
      providers: [
        { provide: FlightsService, useValue: {} },
        { provide: FlightReportService, useValue: {} },
        { provide: CobroReciboService, useValue: {} },
        {
          provide: FacturaClienteService,
          useValue: { actualizar, subirArchivo },
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
    actualizar.mockReset();
    subirArchivo.mockReset();
    const bloque = {
      estatus: 'FACTURADO',
      archivo: { path: 'vuelos/x/y.pdf', nombre: 'Factura A-1234.pdf' },
      folio: 'A-1234',
      uuid: null,
    };
    actualizar.mockResolvedValue(bloque);
    subirArchivo.mockResolvedValue(bloque);
  });

  it('PDF de 2.5 MB + folio por multipart: llega COMPLETO al service con su folio', async () => {
    const bytes = Math.round(2.5 * MB);
    const res = await request(http())
      .post(`/v1/flights/${V1}/factura-cliente/archivo`)
      .field('folio', ' A-1234 ')
      .attach('file', pdfDe(bytes), {
        filename: 'Factura A-1234.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      folio: 'A-1234',
      archivo: { path: 'vuelos/x/y.pdf' },
    });
    const [id, archivo, userId, opts] = subirArchivo.mock.calls[0] as [
      string,
      { buffer: Buffer; nombre: string; mime: string },
      string,
      { folio: string | null },
    ];
    expect(id).toBe(V1);
    expect(userId).toBe(USER);
    expect(archivo.buffer.length).toBe(bytes);
    expect(archivo.buffer.subarray(0, 8).toString('latin1')).toBe('%PDF-1.7');
    expect(archivo.nombre).toBe('Factura A-1234.pdf');
    // El trim/normalización la hace el service (fuente única).
    expect(opts).toEqual({ folio: ' A-1234 ' });
  });

  it('el campo de texto `folio` NO lo tumba forbidNonWhitelisted (está en el DTO)', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V1}/factura-cliente/archivo`)
      .field('folio', 'B-9')
      .attach('file', pdfDe(1000), 'f.pdf');
    expect(res.status).toBe(200);
  });

  it('un campo EXTRA del formulario sí se rechaza (400) — el panel solo debe mandar file + folio', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V1}/factura-cliente/archivo`)
      .field('nombre', 'x')
      .attach('file', pdfDe(1000), 'f.pdf');
    expect(res.status).toBe(400);
    expect(subirArchivo).not.toHaveBeenCalled();
  });

  it('folio de más de 40 caracteres ⇒ 400 antes de tocar el service', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V1}/factura-cliente/archivo`)
      .field('folio', 'X'.repeat(41))
      .attach('file', pdfDe(1000), 'f.pdf');
    expect(res.status).toBe(400);
    expect(subirArchivo).not.toHaveBeenCalled();
  });

  it('10.5 MB: multer lo DEJA pasar (margen de 1 MB) para que el service diga cuánto pesa', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V1}/factura-cliente/archivo`)
      .attach('file', pdfDe(Math.round(10.5 * MB)), 'grande.pdf');
    expect(res.status).toBe(200);
    const [, archivo] = subirArchivo.mock.calls[0] as [
      string,
      { buffer: Buffer },
    ];
    expect(archivo.buffer.length).toBe(Math.round(10.5 * MB));
  });

  it('11.5 MB: multer corta con 413 LEGIBLE y el peso aproximado', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V1}/factura-cliente/archivo`)
      .attach('file', pdfDe(Math.round(11.5 * MB)), 'enorme.pdf');
    expect(res.status).toBe(413);
    const body = res.body as CuerpoError;
    // Antes (0.0.28) salía { code: 'PAYLOAD_TOO_LARGE', message: 'File too
    // large' } en INGLÉS: Nest convierte el MulterError antes del filtro.
    expect(body.code).toBe('ARCHIVO_MUY_GRANDE');
    expect(body.message).toMatch(
      /^El archivo pesa aprox\. 11\.5 MB y supera el tamaño máximo permitido/,
    );
    expect(subirArchivo).not.toHaveBeenCalled();
  });

  it('archivo en OTRO campo (no `file`) ⇒ 400 en español que dice cuál', async () => {
    const res = await request(http())
      .post(`/v1/flights/${V1}/factura-cliente/archivo`)
      .attach('archivo', pdfDe(1000), 'f.pdf');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'CAMPO_ARCHIVO_INVALIDO',
      message:
        'El archivo tiene que ir en el campo «file» del formulario (llegó en «archivo»).',
    });
    expect(subirArchivo).not.toHaveBeenCalled();
  });

  it('PATCH { folio } sin estatus: captura el folio (caso #297, Facturado sin archivo)', async () => {
    const res = await request(http())
      .patch(`/v1/flights/${V1}/factura-cliente`)
      .send({ folio: 'A-1234' });
    expect(res.status).toBe(200);
    expect(actualizar).toHaveBeenCalledWith(V1, { folio: 'A-1234' }, USER);
  });

  it('PATCH { folio: null } llega como borrado explícito', async () => {
    const res = await request(http())
      .patch(`/v1/flights/${V1}/factura-cliente`)
      .send({ folio: null });
    expect(res.status).toBe(200);
    expect(actualizar).toHaveBeenCalledWith(V1, { folio: null }, USER);
  });

  it('PATCH con folio de más de 40 ⇒ 400', async () => {
    const res = await request(http())
      .patch(`/v1/flights/${V1}/factura-cliente`)
      .send({ folio: 'X'.repeat(41) });
    expect(res.status).toBe(400);
    expect(actualizar).not.toHaveBeenCalled();
  });
});
