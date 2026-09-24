// Cableado HTTP de las FLECHAS entre cotizaciones (24-sep-2026): orden de
// rutas, roles (idénticos a la lista) y el DTO de filtros por el
// ValidationPipe real de main.ts. Los servicios se stubbean para no arrastrar
// la cadena de imports del cotizador (notifications/jose, googleapis).
jest.mock('./quotes.service', () => ({ QuotesService: class {} }));
jest.mock('./quotes-pdf.service', () => ({ QuotesPdfService: class {} }));
jest.mock('./quotes-pdf-interno.service', () => ({
  QuotesPdfInternoService: class {},
}));

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { VecinosQuotesQuery } from './dto/list-quotes.query';
import { QuotesController } from './quotes.controller';
import { QuotesPdfInternoService } from './quotes-pdf-interno.service';
import { QuotesPdfService } from './quotes-pdf.service';
import { QuotesService } from './quotes.service';

type Servidor = Parameters<typeof request>[0];
const ID = 'bbbbbbbb-0000-4000-8000-000000000341';
const CLIENTE = 'cccccccc-0000-4000-8000-000000000001';
const GRUPO = 'dddddddd-0000-4000-8000-000000000001';

const proto = QuotesController.prototype as unknown as Record<string, object>;

describe('QuotesController — GET :id/vecinos por metadata', () => {
  it('MISMOS roles que la lista (sin filtrado por fila): quien ve la lista, ve las flechas', () => {
    const roles = (m: string) =>
      Reflect.getMetadata(ROLES_KEY, proto[m]) as Rol[];
    expect(roles('vecinos')).toEqual(roles('list'));
    expect(roles('vecinos')).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
      Rol.ANALISTA,
      Rol.SOCIO,
    ]);
    for (const r of [Rol.PILOTO, Rol.MECANICO]) {
      expect(roles('vecinos')).not.toContain(r);
    }
  });

  it('declarada ANTES de `:id` (convención del repo)', () => {
    const metodos = Object.getOwnPropertyNames(proto).filter(
      (m) => m !== 'constructor',
    );
    const rutas = metodos.map((m) =>
      String(Reflect.getMetadata(PATH_METADATA, proto[m])),
    );
    expect(rutas).toContain(':id/vecinos');
    expect(rutas.indexOf(':id/vecinos')).toBeLessThan(rutas.indexOf(':id'));
  });
});

describe('VecinosQuotesQuery — los filtros de la lista, sin paginar', () => {
  const OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;
  const dto = (plain: Record<string, unknown>) =>
    plainToInstance(VecinosQuotesQuery, plain, {
      enableImplicitConversion: true,
    });

  it('acepta los 6 filtros de la lista', async () => {
    const d = dto({
      cliente_id: CLIENTE,
      aeronave_id: CLIENTE,
      estado: 'COTIZADO',
      es_externo: 'true',
      grupo_id: GRUPO,
      q: 'maqar',
    });
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d.es_externo).toBe(true);
  });

  it('limit/offset NO existen aquí (400 con forbidNonWhitelisted)', async () => {
    const errores = await validate(dto({ limit: 10, offset: 0 }), OPTS);
    expect(errores.map((e) => e.property).sort()).toEqual(['limit', 'offset']);
  });

  it('estado fuera del catálogo o cliente_id que no es uuid ⇒ error', async () => {
    const errores = await validate(
      dto({ estado: 'NADA', cliente_id: 'no-uuid' }),
      OPTS,
    );
    expect(errores.map((e) => e.property).sort()).toEqual([
      'cliente_id',
      'estado',
    ]);
  });
});

describe('QuotesController — GET /v1/quotes/:id/vecinos por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const respuesta = {
    anterior: null,
    siguiente: {
      id: 'bbbbbbbb-0000-4000-8000-000000000346',
      folio: 346,
      fecha_vuelo: '2026-09-20T20:30:00+00:00',
      estado: 'COTIZADO',
      cliente_nombre: 'Maqar',
    },
    sin_fecha: false,
  };
  const svc = {
    vecinos: jest.fn().mockResolvedValue(respuesta),
    findById: jest.fn().mockResolvedValue({ id: ID }),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [QuotesController],
      providers: [
        { provide: QuotesService, useValue: svc },
        { provide: QuotesPdfService, useValue: {} },
        { provide: QuotesPdfInternoService, useValue: {} },
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
        nombre: 'Itzi',
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
  });

  it('llega a `vecinos` (no a `:id`) con los filtros ya transformados', async () => {
    const r = await request(http()).get(
      `/v1/quotes/${ID}/vecinos?estado=COTIZADO&cliente_id=${CLIENTE}&q=maqar&grupo_id=${GRUPO}&es_externo=true`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual(respuesta);
    expect(svc.findById).not.toHaveBeenCalled();
    expect(svc.vecinos).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({
        estado: 'COTIZADO',
        cliente_id: CLIENTE,
        q: 'maqar',
        grupo_id: GRUPO,
        es_externo: true,
      }),
    );
  });

  it('SOCIO y FACTURACION pasan; PILOTO/MECANICO/VISITANTE ⇒ 403', async () => {
    for (const r of [
      Rol.SOCIO,
      Rol.FACTURACION,
      Rol.ANALISTA,
      Rol.COORDINADOR,
    ]) {
      rol = r;
      expect(
        (await request(http()).get(`/v1/quotes/${ID}/vecinos`)).status,
      ).toBe(200);
    }
    for (const r of [Rol.PILOTO, Rol.MECANICO, Rol.VISITANTE]) {
      rol = r;
      expect(
        (await request(http()).get(`/v1/quotes/${ID}/vecinos`)).status,
      ).toBe(403);
    }
  });

  it('id que no es uuid ⇒ 400; `limit` ⇒ 400; estado inválido ⇒ 400', async () => {
    expect(
      (await request(http()).get('/v1/quotes/no-es-uuid/vecinos')).status,
    ).toBe(400);
    expect(
      (await request(http()).get(`/v1/quotes/${ID}/vecinos?limit=10`)).status,
    ).toBe(400);
    expect(
      (await request(http()).get(`/v1/quotes/${ID}/vecinos?estado=NADA`))
        .status,
    ).toBe(400);
    expect(svc.vecinos).not.toHaveBeenCalled();
  });
});
