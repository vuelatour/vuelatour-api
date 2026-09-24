// SUBIDA DE PUNTA A PUNTA (revisión adversaria 24-sep-2026): HTTP multipart
// REAL → FlightsController → FacturaClienteService REAL → Supabase en
// memoria (tabla `vuelo` con los CHECK de la migración 20260924000001 +
// bucket `facturas`). Los otros specs prueban cada pieza con la vecina
// mockeada; éste prueba que el archivo LLEGA AL BUCKET con sus bytes, que el
// path queda en el vuelo y que el bloque que lee el panel (la UI solo dice
// «Factura guardada» con `archivo`) sale de lo que de verdad se guardó.
//
// Contexto del #297 (logs de Supabase del 23-sep): la subida de su PDF (50
// KB) SÍ llegó al bucket; 9 minutos después se QUITÓ con DELETE
// …/archivo. Aquí queda congelado ese ciclo también: quitar borra el objeto
// y deja el folio.
jest.mock('./flights.service', () => ({ FlightsService: class {} }));
jest.mock('./flight-report.service', () => ({
  FlightReportService: class {},
}));
jest.mock('./cobro-recibo.service', () => ({ CobroReciboService: class {} }));
// «Necesito factura» (24-sep-2026): arrastra notifications/jose.
jest.mock('./factura-solicitud.service', () => ({
  FacturaSolicitudService: class {},
}));

import { ValidationPipe, VersioningType } from '@nestjs/common';
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
import { SupabaseService } from '../supabase/supabase.service';

const V = 'dc204a2f-6342-43f1-9406-f76dc1302b97';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';
const MB = 1024 * 1024;

type Servidor = Parameters<typeof request>[0];
type Fila = Record<string, unknown>;

/** CFDI 4.0 con la ESTRUCTURA del XML real FECMID-90255 (BOM incluido). */
const CFDI =
  '﻿<?xml version="1.0" encoding="utf-8"?>' +
  '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" ' +
  'Fecha="2026-06-03T09:47:41" NoCertificado="00001000000704178991" ' +
  'Serie="FECMID" Folio="90255" Certificado="MIIGITCCBAmgAwIBAgIU" Sello="U7DK==">' +
  '<cfdi:Emisor Rfc="AME980401BI7" Nombre="AEROPUERTO DE MERIDA" RegimenFiscal="601"/>' +
  '<cfdi:Complemento><tfd:TimbreFiscalDigital ' +
  'xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" ' +
  'UUID="df1bfb5f-4d88-4f51-ac50-a7b72299128e" FechaTimbrado="2026-06-03T10:48:06"/>' +
  '</cfdi:Complemento></cfdi:Comprobante>';

/** «PDF» de `bytes` bytes con cabecera real y relleno que no se repite. */
function pdfDe(bytes: number): Buffer {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) b[i] = (i * 31 + 7) % 251;
  b.write('%PDF-1.7\n', 0, 'latin1');
  return b;
}

/**
 * Supabase EN MEMORIA: `vuelo` (una fila, con los CHECK de la migración del
 * folio), `usuario` y el bucket `facturas`. `conFolio = false` simula la
 * migración 20260924000001 SIN aplicar (la sonda ve 42703).
 */
function supabaseFalso(conFolio: boolean) {
  const vuelo: Fila = {
    id: V,
    facturado: false,
    factura_estatus: 'FACTURADO',
    factura_archivo_path: null,
    factura_archivo_nombre: null,
    factura_archivo_subida_at: null,
    factura_archivo_subida_por: null,
    ...(conFolio ? { factura_folio: null, factura_uuid: null } : {}),
  };
  const bucket = new Map<string, { bytes: Buffer; contentType: string }>();
  const errCol = (c: string) => ({
    code: '42703',
    message: `column vuelo.${c} does not exist`,
  });
  const faltante = (cols: string) =>
    cols
      .split(',')
      .map((c) => c.trim())
      .find((c) => c && !(c in vuelo));

  const tablaVuelo = () => {
    let cols = '*';
    let patch: Fila | null = null;
    const q: Record<string, unknown> = {};
    const proyectar = () =>
      Object.fromEntries(
        cols.split(',').map((c) => [c.trim(), vuelo[c.trim()] ?? null]),
      );
    q.select = (c: string) => {
      cols = c;
      return q;
    };
    q.limit = () => {
      const f = faltante(cols);
      return Promise.resolve(
        f ? { data: null, error: errCol(f) } : { data: [], error: null },
      );
    };
    q.update = (p: Fila) => {
      patch = p;
      return q;
    };
    q.in = () => {
      const f = faltante(cols);
      return Promise.resolve(
        f
          ? { data: null, error: errCol(f) }
          : { data: [proyectar()], error: null },
      );
    };
    q.eq = (_c: string, id: string) => {
      if (patch) {
        const p = patch;
        const f = Object.keys(p).find(
          (k) => k !== 'updated_by' && !(k in vuelo),
        );
        if (f) return Promise.resolve({ error: errCol(f) });
        // Los CHECK de la migración 20260924000001, tal cual.
        const folio = p.factura_folio;
        if (
          typeof folio === 'string' &&
          (folio.length < 1 || folio.length > 40 || folio !== folio.trim())
        ) {
          return Promise.resolve({
            error: { code: '23514', message: 'vuelo_factura_folio_chk' },
          });
        }
        const uuid = p.factura_uuid;
        if (
          typeof uuid === 'string' &&
          !/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(
            uuid,
          )
        ) {
          return Promise.resolve({
            error: { code: '23514', message: 'vuelo_factura_uuid_chk' },
          });
        }
        if (id === V) Object.assign(vuelo, p);
        return Promise.resolve({ error: null });
      }
      q.maybeSingle = () => {
        const f = faltante(cols);
        if (f) return Promise.resolve({ data: null, error: errCol(f) });
        return Promise.resolve({
          data: id === V ? proyectar() : null,
          error: null,
        });
      };
      return q;
    };
    return q;
  };

  const service = {
    from: (tabla: string) => {
      if (tabla === 'vuelo') return tablaVuelo();
      if (tabla === 'usuario') {
        return {
          select: () => ({
            in: () =>
              Promise.resolve({
                data: [{ id: USER, nombre: 'Mary Cruz' }],
                error: null,
              }),
          }),
        };
      }
      throw new Error(`tabla inesperada ${tabla}`);
    },
    storage: {
      from: (b: string) => {
        expect(b).toBe('facturas');
        return {
          upload: (
            path: string,
            bytes: Buffer,
            o: { contentType: string; upsert: boolean },
          ) => {
            if (bucket.has(path) && !o.upsert) {
              return Promise.resolve({ error: { message: 'Duplicate' } });
            }
            bucket.set(path, {
              bytes: Buffer.from(bytes),
              contentType: o.contentType,
            });
            return Promise.resolve({ data: { path }, error: null });
          },
          remove: (paths: string[]) => {
            for (const p of paths) bucket.delete(p);
            return Promise.resolve({ data: [], error: null });
          },
          createSignedUrl: (path: string) =>
            Promise.resolve(
              bucket.has(path)
                ? {
                    data: { signedUrl: `https://firmada/${path}` },
                    error: null,
                  }
                : { data: null, error: { message: 'Object not found' } },
            ),
        };
      },
    },
  };
  return { supabase: { service } as unknown as SupabaseService, vuelo, bucket };
}

async function levantar(conFolio: boolean) {
  const falso = supabaseFalso(conFolio);
  const moduleRef = await Test.createTestingModule({
    controllers: [FlightsController],
    providers: [
      { provide: FlightsService, useValue: {} },
      { provide: FlightReportService, useValue: {} },
      { provide: CobroReciboService, useValue: {} },
      { provide: SupabaseService, useValue: falso.supabase },
      FacturaClienteService,
    ],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
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
    (req as unknown as { user: unknown }).user = { userId: USER, rol: 'ADMIN' };
    next();
  });
  await app.init();
  return { app, ...falso, http: () => app.getHttpServer() as Servidor };
}

const RUTA = `/v1/flights/${V}/factura-cliente`;

describe('Factura del servicio — subida de punta a punta (con la migración del folio)', () => {
  let ctx: Awaited<ReturnType<typeof levantar>>;
  beforeAll(async () => {
    ctx = await levantar(true);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('PDF de 3 MB + folio tecleado: los BYTES llegan al bucket, el path queda en el vuelo y el bloque lo confirma', async () => {
    const pdf = pdfDe(3 * MB);
    const res = await request(ctx.http())
      .post(`${RUTA}/archivo`)
      .field('folio', '  A-1234  ')
      .attach('file', pdf, {
        filename: 'Factura A-1234.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(200);
    // El objeto está en el bucket con los MISMOS bytes.
    expect(ctx.bucket.size).toBe(1);
    const [path, obj] = [...ctx.bucket.entries()][0];
    expect(path).toMatch(new RegExp(`^vuelos/${V}/[0-9a-f-]{36}\\.pdf$`));
    expect(obj.contentType).toBe('application/pdf');
    expect(obj.bytes.equals(pdf)).toBe(true);
    // El vuelo apunta a ESE objeto y guarda el folio normalizado.
    expect(ctx.vuelo).toMatchObject({
      factura_archivo_path: path,
      factura_archivo_nombre: 'Factura A-1234.pdf',
      factura_archivo_subida_por: USER,
      factura_folio: 'A-1234',
      factura_uuid: null,
    });
    // Lo que lee el panel (`confirmarSubida` exige `archivo`).
    expect(res.body).toMatchObject({
      estatus: 'FACTURADO',
      archivo: {
        path,
        nombre: 'Factura A-1234.pdf',
        subida_por_nombre: 'Mary Cruz',
      },
      folio: 'A-1234',
      uuid: null,
    });
    // «Ver»: la URL firmada sale del objeto que de verdad existe.
    const ver = await request(ctx.http()).get(`${RUTA}/archivo-url`);
    expect(ver.status).toBe(200);
    expect((ver.body as { url: string }).url).toBe(`https://firmada/${path}`);
  });

  it('reemplazo con el XML REAL (sin teclear): folio SERIE-FOLIO + UUID del timbre; el PDF anterior se borra del bucket', async () => {
    const pdfPath = ctx.vuelo.factura_archivo_path as string;
    const res = await request(ctx.http())
      .post(`${RUTA}/archivo`)
      .attach('file', Buffer.from(CFDI, 'utf8'), {
        filename: 'FECMID-90255.xml',
        // Los navegadores mandan el XML como octet-stream más veces de las
        // que se cree: la extensión manda.
        contentType: 'application/octet-stream',
      });
    expect(res.status).toBe(200);
    expect(ctx.bucket.has(pdfPath)).toBe(false);
    expect(ctx.bucket.size).toBe(1);
    const [path, obj] = [...ctx.bucket.entries()][0];
    expect(path.endsWith('.xml')).toBe(true);
    expect(obj.contentType).toBe('application/xml');
    expect(res.body).toMatchObject({
      folio: 'FECMID-90255',
      uuid: 'DF1BFB5F-4D88-4F51-AC50-A7B72299128E',
      archivo: { path, nombre: 'FECMID-90255.xml' },
    });
  });

  it('XML + folio tecleado: el TECLEADO gana; el UUID sigue siendo el del timbre', async () => {
    const res = await request(ctx.http())
      .post(`${RUTA}/archivo`)
      .field('folio', 'VT-77')
      .attach('file', Buffer.from(CFDI, 'utf8'), 'cfdi.xml');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      folio: 'VT-77',
      uuid: 'DF1BFB5F-4D88-4F51-AC50-A7B72299128E',
    });
  });

  it('PATCH { folio } sin archivo lo corrige; PDF nuevo sin folio lo CONSERVA', async () => {
    const p = await request(ctx.http()).patch(RUTA).send({ folio: 'A-9' });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ folio: 'A-9' });
    const s = await request(ctx.http())
      .post(`${RUTA}/archivo`)
      .attach('file', pdfDe(1000), 'papel.pdf');
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({
      folio: 'A-9',
      archivo: { nombre: 'papel.pdf' },
    });
  });

  it('archivo de 11.5 MB: 413 legible y el bucket y el vuelo NO cambian', async () => {
    const antes = { ...ctx.vuelo };
    const objetos = [...ctx.bucket.keys()];
    const res = await request(ctx.http())
      .post(`${RUTA}/archivo`)
      .attach('file', pdfDe(Math.round(11.5 * MB)), 'enorme.pdf');
    expect(res.status).toBe(413);
    expect((res.body as { code: string }).code).toBe('ARCHIVO_MUY_GRANDE');
    expect((res.body as { message: string }).message).toMatch(
      /^El archivo pesa/,
    );
    expect([...ctx.bucket.keys()]).toEqual(objetos);
    expect(ctx.vuelo).toEqual(antes);
  });

  it('«Quitar archivo» (lo que pasó en el #297): borra el OBJETO del bucket y el path; el folio y el estatus se quedan', async () => {
    const res = await request(ctx.http()).delete(`${RUTA}/archivo`);
    expect(res.status).toBe(200);
    expect(ctx.bucket.size).toBe(0);
    expect(res.body).toMatchObject({
      estatus: 'FACTURADO',
      archivo: null,
      folio: 'A-9',
    });
    const ver = await request(ctx.http()).get(`${RUTA}/archivo-url`);
    expect(ver.status).toBe(404);
  });
});

describe('Factura del servicio — SIN la migración del folio aplicada (el API se porta como hoy)', () => {
  let ctx: Awaited<ReturnType<typeof levantar>>;
  beforeAll(async () => {
    ctx = await levantar(false);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('PDF de 3 MB sin folio: se guarda igual que hoy y el bloque dice folio null', async () => {
    const pdf = pdfDe(3 * MB);
    const res = await request(ctx.http())
      .post(`${RUTA}/archivo`)
      .attach('file', pdf, 'factura.pdf');
    expect(res.status).toBe(200);
    expect(ctx.bucket.size).toBe(1);
    expect([...ctx.bucket.values()][0].bytes.equals(pdf)).toBe(true);
    expect(res.body).toMatchObject({ folio: null, uuid: null });
    expect((res.body as { archivo: unknown }).archivo).not.toBeNull();
    expect('factura_folio' in ctx.vuelo).toBe(false);
  });

  it('XML sin teclear: se guarda; el folio extraído NO se escribe (la columna no existe) — nunca un 500', async () => {
    const res = await request(ctx.http())
      .post(`${RUTA}/archivo`)
      .attach('file', Buffer.from(CFDI, 'utf8'), 'cfdi.xml');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ folio: null });
  });

  it('folio TECLEADO: 409 FACTURA_FOLIO_NO_DISPONIBLE ANTES de subir nada (el panel reintenta sin folio)', async () => {
    const objetos = [...ctx.bucket.keys()];
    const antes = { ...ctx.vuelo };
    const res = await request(ctx.http())
      .post(`${RUTA}/archivo`)
      .field('folio', 'A-1')
      .attach('file', pdfDe(2000), 'f.pdf');
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe(
      'FACTURA_FOLIO_NO_DISPONIBLE',
    );
    expect([...ctx.bucket.keys()]).toEqual(objetos);
    expect(ctx.vuelo).toEqual(antes);
    // PATCH { folio } igual: 409 sin escribir.
    const p = await request(ctx.http()).patch(RUTA).send({ folio: 'A-1' });
    expect(p.status).toBe(409);
    expect(ctx.vuelo).toEqual(antes);
    // …y el estatus solo sigue funcionando como hoy.
    const e = await request(ctx.http())
      .patch(RUTA)
      .send({ estatus: 'ELABORADA_ENVIADA' });
    expect(e.status).toBe(200);
    expect(ctx.vuelo.factura_estatus).toBe('ELABORADA_ENVIADA');
  });
});
