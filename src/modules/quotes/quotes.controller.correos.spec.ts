// Cableado HTTP del CORREO AL CLIENTE (9-nov-2026, invariante 128): orden de
// rutas (`correos` antes de `:id`), roles (ver ≠ enviar) y DTOs por el
// ValidationPipe real. Los servicios se stubbean (misma razón que el spec de
// vecinos: no arrastrar notifications/googleapis).
jest.mock('./quotes.service', () => ({ QuotesService: class {} }));
jest.mock('./quotes-pdf.service', () => ({ QuotesPdfService: class {} }));
jest.mock('./quotes-pdf-interno.service', () => ({
  QuotesPdfInternoService: class {},
}));
jest.mock('./quotes-correo.service', () => ({
  QuotesCorreoService: class {},
}));

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import {
  QuotesController,
  ROLES_VEN_CORREOS_CLIENTE,
} from './quotes.controller';
import { QuotesCorreoService } from './quotes-correo.service';
import { QuotesPdfInternoService } from './quotes-pdf-interno.service';
import { QuotesPdfService } from './quotes-pdf.service';
import { QuotesService } from './quotes.service';

type Servidor = Parameters<typeof request>[0];
const ID = 'bbbbbbbb-0000-4000-8000-000000000538';
const proto = QuotesController.prototype as unknown as Record<string, object>;
const roles = (m: string) => Reflect.getMetadata(ROLES_KEY, proto[m]) as Rol[];

describe('QuotesController — correo al cliente por metadata', () => {
  it('VER (lista, historial, vista previa) = oficina; ENVIAR = quien confirma', () => {
    for (const m of [
      'correos',
      'correosDeVuelo',
      'correoConfirmacionPreview',
    ]) {
      expect(roles(m)).toEqual([...ROLES_VEN_CORREOS_CLIENTE]);
    }
    expect([...ROLES_VEN_CORREOS_CLIENTE]).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
      Rol.ANALISTA,
    ]);
    expect(roles('correoConfirmacionEnviar')).toEqual(roles('confirm'));
    expect(roles('correoConfirmacionEnviar')).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
    ]);
  });

  it('`correos` (literal) declarada ANTES de `:id`', () => {
    const rutas = Object.getOwnPropertyNames(proto)
      .filter((m) => m !== 'constructor')
      .map((m) => String(Reflect.getMetadata(PATH_METADATA, proto[m])));
    expect(rutas.indexOf('correos')).toBeGreaterThan(-1);
    expect(rutas.indexOf('correos')).toBeLessThan(rutas.indexOf(':id'));
  });
});

describe('QuotesController — correo al cliente por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = { detalle: jest.fn().mockResolvedValue({ id: ID }) };
  const correo = {
    listar: jest.fn().mockResolvedValue({ correos: [], truncado: false }),
    historial: jest.fn().mockResolvedValue({ correos: [] }),
    vistaPrevia: jest.fn().mockResolvedValue({ puede_enviar: true }),
    enviar: jest
      .fn()
      .mockResolvedValue({ enviado: true, mensaje: 'ok', correo: null }),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [QuotesController],
      providers: [
        { provide: QuotesService, useValue: svc },
        { provide: QuotesPdfService, useValue: {} },
        { provide: QuotesPdfInternoService, useValue: {} },
        { provide: QuotesCorreoService, useValue: correo },
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
        userId: 'u-itzel',
        nombre: 'Itzel',
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

  it('GET /v1/quotes/correos llega a `listar` (no a `:id`) con el DTO transformado', async () => {
    const r = await request(http()).get(
      '/v1/quotes/correos?desde=2026-11-01&hasta=2026-11-09&limite=50',
    );
    expect(r.status).toBe(200);
    expect(svc.detalle).not.toHaveBeenCalled();
    expect(correo.listar).toHaveBeenCalledWith(
      expect.objectContaining({
        desde: '2026-11-01',
        hasta: '2026-11-09',
        limite: 50,
      }),
    );
  });

  it('fecha mal formada, límite fuera de rango o parámetro desconocido ⇒ 400', async () => {
    for (const qs of ['desde=01/11/2026', 'limite=0', 'limite=501', 'otro=1']) {
      const r = await request(http()).get(`/v1/quotes/correos?${qs}`);
      expect(r.status).toBe(400);
    }
    expect(correo.listar).not.toHaveBeenCalled();
  });

  it('historial y vista previa: GET, no envían', async () => {
    expect((await request(http()).get(`/v1/quotes/${ID}/correos`)).status).toBe(
      200,
    );
    expect(correo.historial).toHaveBeenCalledWith(ID);
    expect(
      (await request(http()).get(`/v1/quotes/${ID}/correo-confirmacion`))
        .status,
    ).toBe(200);
    expect(correo.vistaPrevia).toHaveBeenCalledWith(ID);
    expect(correo.enviar).not.toHaveBeenCalled();
  });

  it('POST envía con el usuario de la sesión; sin body también vale; campo extra ⇒ 400', async () => {
    const con = await request(http())
      .post(`/v1/quotes/${ID}/correo-confirmacion`)
      .send({ reenviar: true });
    expect(con.status).toBe(200);
    expect(correo.enviar).toHaveBeenLastCalledWith(
      ID,
      'u-itzel',
      expect.objectContaining({ reenviar: true }),
    );
    const sin = await request(http()).post(
      `/v1/quotes/${ID}/correo-confirmacion`,
    );
    expect(sin.status).toBe(200);
    expect(correo.enviar).toHaveBeenCalledTimes(2);
    const extra = await request(http())
      .post(`/v1/quotes/${ID}/correo-confirmacion`)
      .send({ to: 'otro@correo.com' });
    expect(extra.status).toBe(400);
    expect(correo.enviar).toHaveBeenCalledTimes(2);
  });

  it('FACTURACION/ANALISTA ven pero NO envían; DIRECCION pasa todo; SOCIO/PILOTO nada', async () => {
    for (const r of [Rol.FACTURACION, Rol.ANALISTA]) {
      rol = r;
      expect(
        (await request(http()).get(`/v1/quotes/${ID}/correos`)).status,
      ).toBe(200);
      expect((await request(http()).get('/v1/quotes/correos')).status).toBe(
        200,
      );
      expect(
        (await request(http()).post(`/v1/quotes/${ID}/correo-confirmacion`))
          .status,
      ).toBe(403);
    }
    rol = Rol.DIRECCION;
    expect(
      (await request(http()).post(`/v1/quotes/${ID}/correo-confirmacion`))
        .status,
    ).toBe(200);
    for (const r of [Rol.SOCIO, Rol.PILOTO, Rol.MECANICO]) {
      rol = r;
      expect((await request(http()).get('/v1/quotes/correos')).status).toBe(
        403,
      );
      expect(
        (await request(http()).get(`/v1/quotes/${ID}/correos`)).status,
      ).toBe(403);
      expect(
        (await request(http()).get(`/v1/quotes/${ID}/correo-confirmacion`))
          .status,
      ).toBe(403);
      expect(
        (await request(http()).post(`/v1/quotes/${ID}/correo-confirmacion`))
          .status,
      ).toBe(403);
    }
  });
});
