// El servicio real arrastra FlightsService/notifications (googleapis, jose):
// se stubbea; aquí se prueba el CABLEADO HTTP (roles, orden de rutas,
// multipart con UN campo `datos`).
jest.mock('./facturas-emitidas.service', () => ({
  FacturasEmitidasService: class {},
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
import { FacturasEmitidasController } from './facturas-emitidas.controller';
import { FacturasEmitidasService } from './facturas-emitidas.service';

type Servidor = Parameters<typeof request>[0];
const ID = 'eeeeeeee-0000-4000-8000-000000000001';

describe('FacturasEmitidasController — roles por metadata', () => {
  it('clase: ADMIN y FACTURACION; archivo-url suma COORDINADOR', () => {
    expect(Reflect.getMetadata(ROLES_KEY, FacturasEmitidasController)).toEqual([
      Rol.ADMIN,
      Rol.FACTURACION,
    ]);
    const proto = FacturasEmitidasController.prototype as unknown as Record<
      string,
      object
    >;
    expect(Reflect.getMetadata(ROLES_KEY, proto.archivoUrl)).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
    ]);
    // Ningún otro método afloja el candado de la clase.
    for (const m of Object.getOwnPropertyNames(proto)) {
      if (m === 'constructor' || m === 'archivoUrl') continue;
      expect(Reflect.getMetadata(ROLES_KEY, proto[m])).toBeUndefined();
    }
  });

  it('rutas literales declaradas ANTES de `:id`', () => {
    const proto = FacturasEmitidasController.prototype as unknown as Record<
      string,
      object
    >;
    const rutas = Object.getOwnPropertyNames(proto)
      .filter((m) => m !== 'constructor')
      .map((m) => String(Reflect.getMetadata(PATH_METADATA, proto[m])));
    const primeraConId = rutas.findIndex((r) => r.startsWith(':id'));
    const literales = [
      'por-facturar/conteo',
      'por-facturar',
      'export.xlsx',
      'vuelos-candidatos',
      'leer-archivo',
    ];
    for (const l of literales) {
      expect(rutas.indexOf(l)).toBeGreaterThanOrEqual(0);
      expect(rutas.indexOf(l)).toBeLessThan(primeraConId);
    }
  });
});

describe('FacturasEmitidasController — por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    conteoPorFacturar: jest
      .fn()
      .mockResolvedValue({ por_facturar: 2, paga_contra_factura: 1 }),
    porFacturar: jest.fn().mockResolvedValue({ data: [], count: 0 }),
    obtener: jest.fn().mockResolvedValue({ id: ID }),
    archivoUrl: jest
      .fn()
      .mockResolvedValue({ url: 'https://x', nombre: 'a.pdf' }),
    crear: jest.fn().mockResolvedValue({ factura: { id: ID }, avisos: [] }),
    lista: jest.fn().mockResolvedValue({ data: [] }),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FacturasEmitidasController],
      providers: [{ provide: FacturasEmitidasService, useValue: svc }],
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
  });

  it('`por-facturar/conteo` y `por-facturar` no los captura `:id`', async () => {
    const a = await request(http()).get(
      '/v1/facturas-emitidas/por-facturar/conteo',
    );
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ por_facturar: 2, paga_contra_factura: 1 });
    const b = await request(http()).get('/v1/facturas-emitidas/por-facturar');
    expect(b.status).toBe(200);
    expect(svc.obtener).not.toHaveBeenCalled();
  });

  it('COORDINADOR: 403 en la lista, 200 en archivo-url; PILOTO 403 en todo', async () => {
    rol = Rol.COORDINADOR;
    expect((await request(http()).get('/v1/facturas-emitidas')).status).toBe(
      403,
    );
    const url = await request(http()).get(
      `/v1/facturas-emitidas/${ID}/archivo-url?tipo=pdf`,
    );
    expect(url.status).toBe(200);
    expect(svc.archivoUrl).toHaveBeenCalledWith(ID, 'pdf');
    rol = Rol.PILOTO;
    expect(
      (await request(http()).get(`/v1/facturas-emitidas/${ID}/archivo-url`))
        .status,
    ).toBe(403);
    rol = Rol.FACTURACION;
    expect((await request(http()).get('/v1/facturas-emitidas')).status).toBe(
      200,
    );
  });

  it('alta multipart: UN campo `datos`; otro campo de texto ⇒ 400', async () => {
    const ok = await request(http())
      .post('/v1/facturas-emitidas')
      .field('datos', JSON.stringify({ folio: '1' }))
      .attach('pdf', Buffer.from('%PDF-1.7'), 'a.pdf');
    expect(ok.status).toBe(201);
    expect(svc.crear).toHaveBeenCalledWith(
      JSON.stringify({ folio: '1' }),
      expect.objectContaining({
        pdf: [expect.objectContaining({ originalname: 'a.pdf' })],
      }),
      { userId: 'u-1', nombre: 'Mary Cruz' },
    );
    const extra = await request(http())
      .post('/v1/facturas-emitidas')
      .field('datos', '{}')
      .field('folio', '1');
    expect(extra.status).toBe(400);
  });

  it('?tipo inválido ⇒ 400; id no uuid ⇒ 400', async () => {
    expect(
      (
        await request(http()).get(
          `/v1/facturas-emitidas/${ID}/archivo-url?tipo=doc`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await request(http()).get('/v1/facturas-emitidas/no-es-uuid')).status,
    ).toBe(400);
  });
});
