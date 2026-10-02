// Cableado HTTP de `POST /v1/storage/firmar` (1-oct-2026): ValidationPipe y
// filtro global como en main.ts, RolesGuard real y el StorageService REAL
// sobre un Storage simulado (se verifica bucket, vigencia y paths que llegan
// a Supabase).
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { SEGUNDOS_URL_MINIATURA } from '../../common/url-firmada.util';
import { SupabaseService } from '../supabase/supabase.service';
import { MAX_PATHS_FIRMA } from './storage-firma.util';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

type Servidor = Parameters<typeof request>[0];
const RUTA = '/v1/storage/firmar';
const BASE = 'https://bjesduasnzbzywofukbf.supabase.co/storage/v1';
const GASTO =
  '02996dd1-417d-4871-b4eb-87c4a9697cac/2026-09/20c7ef4a-889c-47a4-bcac-d3aafb08d96d.jpg';
const TACO =
  '3d5b8f23-dde7-4204-954c-07d3f5483fc7/2026-07/00dbe54c-acf8-4687-81a0-c4dda71210cd.jpg';
const NO_EXISTE = '02996dd1-417d-4871-b4eb-87c4a9697cac/2026-09/borrada.jpg';

type ItemFirma = {
  path: string;
  signedUrl: string | null;
  error: string | null;
};

describe('StorageController — POST /v1/storage/firmar', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  let falloLote: { message: string } | null = null;
  const from = jest.fn();
  const createSignedUrls = jest.fn((paths: string[], segundos: number) => {
    if (falloLote) return Promise.resolve({ data: null, error: falloLote });
    const data: ItemFirma[] = paths.map((p) =>
      p === NO_EXISTE
        ? {
            path: p,
            signedUrl: null,
            error: 'Either the object does not exist',
          }
        : {
            path: p,
            signedUrl: `${BASE}/object/sign/b/${p}?token=t${segundos}`,
            error: null,
          },
    );
    return Promise.resolve({ data, error: null });
  });
  const supabase = {
    service: {
      storage: {
        from: (bucket: string) => {
          from(bucket);
          return { createSignedUrls };
        },
      },
    },
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;
  const firmar = (body: unknown) =>
    request(http())
      .post(RUTA)
      .send(body as object);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StorageController],
      providers: [
        StorageService,
        { provide: SupabaseService, useValue: supabase },
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
        nombre: 'Oficina',
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
    falloLote = null;
    jest.clearAllMocks();
  });

  it('firma con vigencia de 8 h y responde {urls: {path: url}, expira_en_s}', async () => {
    const r = await firmar({ bucket: 'gasto-fotos', paths: [GASTO, TACO] });
    expect(r.status).toBe(200);
    expect(from).toHaveBeenCalledWith('gasto-fotos');
    expect(createSignedUrls).toHaveBeenCalledWith([GASTO, TACO], 28800);
    expect(SEGUNDOS_URL_MINIATURA).toBe(28800);
    expect(r.body).toEqual({
      urls: {
        [GASTO]: `${BASE}/object/sign/b/${GASTO}?token=t28800`,
        [TACO]: `${BASE}/object/sign/b/${TACO}?token=t28800`,
      },
      expira_en_s: 28800,
    });
  });

  it('un path inexistente NO aparece (el panel pinta el placeholder); repetidos y vacíos se limpian', async () => {
    const r = await firmar({
      bucket: 'taco-fotos',
      paths: [TACO, NO_EXISTE, TACO, ''],
    });
    expect(r.status).toBe(200);
    expect(createSignedUrls).toHaveBeenCalledWith([TACO, NO_EXISTE], 28800);
    expect(Object.keys((r.body as { urls: object }).urls)).toEqual([TACO]);
  });

  it('arreglo vacío ⇒ 200 sin tocar Storage', async () => {
    const r = await firmar({ bucket: 'facturas', paths: [] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ urls: {}, expira_en_s: 28800 });
    expect(createSignedUrls).not.toHaveBeenCalled();
  });

  describe('lista blanca', () => {
    it('bucket desconocido ⇒ 400 BUCKET_NO_PERMITIDO sin tocar Storage (csd, avatars…)', async () => {
      for (const bucket of ['csd', 'avatars', 'aeronave-imagenes', 'otro']) {
        const r = await firmar({ bucket, paths: ['a/b.key'] });
        expect(r.status).toBe(400);
        expect((r.body as { code: string }).code).toBe('BUCKET_NO_PERMITIDO');
      }
      expect(from).not.toHaveBeenCalled();
    });

    it('path con traversal o URL completa ⇒ 400 PATH_INVALIDO', async () => {
      for (const p of [
        '../csd/llave.key',
        '/gasto-fotos/a.jpg',
        `${BASE}/object/sign/gasto-fotos/${GASTO}?token=x`,
      ]) {
        const r = await firmar({ bucket: 'gasto-fotos', paths: [GASTO, p] });
        expect(r.status).toBe(400);
        expect((r.body as { code: string }).code).toBe('PATH_INVALIDO');
      }
      expect(createSignedUrls).not.toHaveBeenCalled();
    });
  });

  describe('roles', () => {
    it('oficina (ADMIN, COORDINADOR, FACTURACION, SOCIO, ANALISTA) firma gasto-fotos, taco-fotos y planes-vuelo', async () => {
      for (const r of [
        Rol.ADMIN,
        Rol.COORDINADOR,
        Rol.FACTURACION,
        Rol.SOCIO,
        Rol.ANALISTA,
      ]) {
        rol = r;
        for (const bucket of ['gasto-fotos', 'taco-fotos', 'planes-vuelo']) {
          expect((await firmar({ bucket, paths: [GASTO] })).status).toBe(200);
        }
      }
    });

    it('buckets privados: los mismos roles que su endpoint específico (default-deny)', async () => {
      const casos: Array<[string, Rol, number]> = [
        ['estados-cuenta', Rol.ADMIN, 200],
        ['estados-cuenta', Rol.FACTURACION, 200],
        ['estados-cuenta', Rol.COORDINADOR, 403],
        ['estados-cuenta', Rol.ANALISTA, 403],
        ['estados-cuenta', Rol.SOCIO, 403],
        ['facturas', Rol.COORDINADOR, 200],
        ['facturas', Rol.ANALISTA, 403],
        ['ingresos', Rol.SOCIO, 403],
        ['documentos-flota', Rol.COORDINADOR, 200],
        ['documentos-flota', Rol.FACTURACION, 403],
        ['cobro-vouchers', Rol.FACTURACION, 200],
        ['cobro-vouchers', Rol.SOCIO, 403],
        // Pagos a socios (1-oct-2026): = GET profit-sharing/pagos.
        ['reparto-comprobantes', Rol.SOCIO, 200],
        ['reparto-comprobantes', Rol.ANALISTA, 200],
        ['reparto-comprobantes', Rol.FACTURACION, 200],
        ['reparto-comprobantes', Rol.COORDINADOR, 403],
      ];
      for (const [bucket, r, status] of casos) {
        rol = r;
        jest.clearAllMocks();
        const res = await firmar({ bucket, paths: [GASTO] });
        expect([bucket, r, res.status]).toEqual([bucket, r, status]);
        if (status === 403) {
          expect((res.body as { code: string }).code).toBe(
            'BUCKET_FUERA_DE_ROL',
          );
          expect(createSignedUrls).not.toHaveBeenCalled();
        }
      }
    });

    it('PILOTO/MECANICO: gasto-fotos y taco-fotos sí; otro bucket ⇒ 403 BUCKET_FUERA_DE_ROL', async () => {
      for (const r of [Rol.PILOTO, Rol.MECANICO]) {
        rol = r;
        expect(
          (await firmar({ bucket: 'gasto-fotos', paths: [GASTO] })).status,
        ).toBe(200);
        expect(
          (await firmar({ bucket: 'taco-fotos', paths: [TACO] })).status,
        ).toBe(200);
        jest.clearAllMocks();
        for (const bucket of ['cobro-vouchers', 'facturas', 'estados-cuenta']) {
          const res = await firmar({ bucket, paths: [GASTO] });
          expect(res.status).toBe(403);
          expect((res.body as { code: string }).code).toBe(
            'BUCKET_FUERA_DE_ROL',
          );
        }
        expect(createSignedUrls).not.toHaveBeenCalled();
      }
    });

    it('VISITANTE ⇒ 403 del RolesGuard, ni para gasto-fotos', async () => {
      rol = Rol.VISITANTE;
      const r = await firmar({ bucket: 'gasto-fotos', paths: [GASTO] });
      expect(r.status).toBe(403);
      expect(createSignedUrls).not.toHaveBeenCalled();
    });
  });

  describe('tope y DTO', () => {
    it(`${MAX_PATHS_FIRMA} paths pasan; ${MAX_PATHS_FIRMA + 1} ⇒ 400 sin tocar Storage`, async () => {
      const paths = Array.from(
        { length: MAX_PATHS_FIRMA + 1 },
        (_, i) => `u/2026-09/${i}.jpg`,
      );
      const ok = await firmar({
        bucket: 'gasto-fotos',
        paths: paths.slice(0, MAX_PATHS_FIRMA),
      });
      expect(ok.status).toBe(200);
      expect(createSignedUrls).toHaveBeenCalledTimes(1);
      jest.clearAllMocks();
      const r = await firmar({ bucket: 'gasto-fotos', paths });
      expect(r.status).toBe(400);
      expect(createSignedUrls).not.toHaveBeenCalled();
    });

    it('sin bucket, paths que no son arreglo de textos o campo extra ⇒ 400', async () => {
      for (const body of [
        { paths: [GASTO] },
        { bucket: 'gasto-fotos' },
        { bucket: 'gasto-fotos', paths: GASTO },
        { bucket: 'gasto-fotos', paths: [1, 2] },
        { bucket: 'gasto-fotos', paths: [GASTO], extra: true },
        { bucket: '', paths: [GASTO] },
      ]) {
        expect((await firmar(body)).status).toBe(400);
      }
      expect(createSignedUrls).not.toHaveBeenCalled();
    });
  });

  it('falla de Storage para TODO el lote ⇒ 503 FIRMA_NO_DISPONIBLE (el panel ofrece «Reintentar»)', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    falloLote = { message: 'fetch failed' };
    const r = await firmar({ bucket: 'gasto-fotos', paths: [GASTO] });
    expect(r.status).toBe(503);
    expect((r.body as { code: string }).code).toBe('FIRMA_NO_DISPONIBLE');
    log.mockRestore();
  });
});
