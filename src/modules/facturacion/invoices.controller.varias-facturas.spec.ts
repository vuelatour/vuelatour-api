// El servicio real arrastra BD, pyservices y el PAC: se stubbea; aquí se
// prueba el CABLEADO HTTP de «varias facturas por gasto» (16-oct-2026,
// invariante 87): DTO de `archivos[]`, la ruta de quitar la liga y sus roles.
jest.mock('./invoices.service', () => ({ InvoicesService: class {} }));

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

type Servidor = Parameters<typeof request>[0];
type CuerpoError = { code: string; message: string | string[] };

const G = '24b941d4-bc81-44d3-a388-a6bc17c05cdf';
const F = '7a301bfe-630f-4f55-a3c9-b170645035cf';

describe('HTTP — varias facturas por gasto', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    crearRecibidaDeGasto: jest.fn(),
    quitarFacturaDeGasto: jest.fn(),
    deleteRecibida: jest.fn(),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InvoicesController],
      providers: [{ provide: InvoicesService, useValue: svc }],
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
    svc.crearRecibidaDeGasto.mockResolvedValue({ id: F, ya_existia: false });
    svc.quitarFacturaDeGasto.mockResolvedValue({ ok: true });
  });

  it('POST de-gasto acepta `archivos[]` (1–10) y lo pasa tal cual', async () => {
    const archivos = [
      { xml_b64: 'PHgvPg==', pdf_b64: 'JVBERg==', nombre: 'FCUN_1.pdf' },
      { pdf_b64: 'JVBERg==' },
    ];
    const res = await request(http())
      .post('/v1/invoices/recibidas/de-gasto')
      .send({ gasto_id: G, archivos });
    expect(res.status).toBe(200);
    expect(svc.crearRecibidaDeGasto).toHaveBeenCalledWith(
      expect.objectContaining({ gasto_id: G, archivos }),
      'u-1',
    );
  }, 20_000);

  it('el shape viejo sigue pasando igual', async () => {
    const res = await request(http())
      .post('/v1/invoices/recibidas/de-gasto')
      .send({ gasto_id: G, pdf_b64: 'JVBERg==', pdf_nombre: 'a.pdf' });
    expect(res.status).toBe(200);
    expect(svc.crearRecibidaDeGasto).toHaveBeenCalledWith(
      { gasto_id: G, pdf_b64: 'JVBERg==', pdf_nombre: 'a.pdf' },
      'u-1',
    );
  }, 20_000);

  it('`archivos` vacío, de 11, o con llaves desconocidas ⇒ 400 sin llamar al servicio', async () => {
    for (const archivos of [
      [],
      Array.from({ length: 11 }, () => ({ pdf_b64: 'JVBERg==' })),
      [{ pdf_b64: 'JVBERg==', pdf_nombre: 'mal.pdf' }],
    ]) {
      const res = await request(http())
        .post('/v1/invoices/recibidas/de-gasto')
        .send({ gasto_id: G, archivos });
      expect(res.status).toBe(400);
    }
    expect(svc.crearRecibidaDeGasto).not.toHaveBeenCalled();
  }, 20_000);

  it('DELETE recibidas/:id/gastos/:gastoId: ADMIN, COORDINADOR y FACTURACION ⇒ 200; el resto 403', async () => {
    const ruta = `/v1/invoices/recibidas/${F}/gastos/${G}`;
    for (const r of [Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION]) {
      rol = r;
      const res = await request(http()).delete(ruta);
      expect(res.status).toBe(200);
      expect(svc.quitarFacturaDeGasto).toHaveBeenLastCalledWith(F, G, 'u-1');
    }
    svc.quitarFacturaDeGasto.mockClear();
    for (const r of [
      Rol.ANALISTA,
      Rol.SOCIO,
      Rol.PILOTO,
      Rol.MECANICO,
      Rol.VISITANTE,
    ]) {
      rol = r;
      const res = await request(http()).delete(ruta);
      expect(res.status).toBe(403);
      expect((res.body as CuerpoError).code).toBe('FORBIDDEN');
    }
    expect(svc.quitarFacturaDeGasto).not.toHaveBeenCalled();
    // No cae en DELETE recibidas/:id (borrar la factura).
    expect(svc.deleteRecibida).not.toHaveBeenCalled();
  }, 20_000);

  it('ids que no son UUID ⇒ 400', async () => {
    const res = await request(http()).delete(
      `/v1/invoices/recibidas/${F}/gastos/no-es-uuid`,
    );
    expect(res.status).toBe(400);
  }, 20_000);
});
