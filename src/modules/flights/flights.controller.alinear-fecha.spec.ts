// Cableado HTTP REAL de `POST /v1/flights/:id/tramos/alinear-fecha`
// (5-oct-2026): ValidationPipe de main.ts (whitelist + forbidNonWhitelisted)
// + AllExceptionsFilter + versionado URI + RolesGuard. Los servicios pesados
// se stubbean (notifications/jose, calendar/googleapis).
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

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { CobroReciboService } from './cobro-recibo.service';
import { FacturaClienteService } from './factura-cliente.service';
import { FlightReportService } from './flight-report.service';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';
import { errorVueloYaVolo, MENSAJE_VUELO_YA_VOLO } from './alinear-fecha.util';

const V = 'aaaaaaaa-0000-4000-8000-000000000338';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';
const RUTA = `/v1/flights/${V}/tramos/alinear-fecha`;

type Servidor = Parameters<typeof request>[0];

describe('FlightsController — alinear-fecha: @Roles', () => {
  it('solo ADMIN y COORDINADOR', () => {
    const proto = FlightsController.prototype as unknown as Record<
      string,
      object
    >;
    expect(Reflect.getMetadata(ROLES_KEY, proto.alinearFechaTramos)).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
    ]);
  });
});

describe('FlightsController — POST :id/tramos/alinear-fecha por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const alinearFechaTramos = jest.fn();
  const http = (): Servidor => app.getHttpServer() as Servidor;
  const respuesta = {
    vuelo_id: V,
    folio: 338,
    delta_dias: 3,
    fecha_objetivo: '2026-10-13T14:00:00.000Z',
    tramos: [],
    fecha_traslado_final: null,
    tramos_movidos: 2,
    fecha_traslado_final_antes: null,
    fecha_traslado_final_movida: false,
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FlightsController],
      providers: [
        { provide: FlightsService, useValue: { alinearFechaTramos } },
        { provide: FlightReportService, useValue: {} },
        { provide: CobroReciboService, useValue: {} },
        { provide: FacturaClienteService, useValue: {} },
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
      (req as unknown as { user: unknown }).user = { userId: USER, rol };
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
    alinearFechaTramos.mockReset();
    alinearFechaTramos.mockResolvedValue(respuesta);
  });

  it.each([Rol.ADMIN, Rol.COORDINADOR])(
    '%s con cuerpo {} (lo que manda el panel) ⇒ 200 y el service recibe (id, dto, userId)',
    async (r) => {
      rol = r;
      const res = await request(http()).post(RUTA).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual(respuesta);
      expect(alinearFechaTramos).toHaveBeenCalledTimes(1);
      const [id, dto, userId] = alinearFechaTramos.mock.calls[0] as [
        string,
        { fecha_vuelo?: string },
        string,
      ];
      expect(id).toBe(V);
      expect(dto.fecha_vuelo).toBeUndefined();
      expect(userId).toBe(USER);
    },
  );

  it('sin cuerpo ni Content-Type ⇒ 200 (DTO vacío)', async () => {
    const res = await request(http()).post(RUTA);
    expect(res.status).toBe(200);
    expect(alinearFechaTramos).toHaveBeenCalledTimes(1);
  });

  it('con `fecha_vuelo` ISO ⇒ el service la recibe tal cual', async () => {
    const res = await request(http())
      .post(RUTA)
      .send({ fecha_vuelo: '2026-10-13T14:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(
      (
        alinearFechaTramos.mock.calls[0] as [string, { fecha_vuelo?: string }]
      )[1].fecha_vuelo,
    ).toBe('2026-10-13T14:00:00.000Z');
  });

  it.each([Rol.FACTURACION, Rol.PILOTO, Rol.SOCIO, Rol.ANALISTA, Rol.MECANICO])(
    '%s ⇒ 403 y el service NO se llama',
    async (r) => {
      rol = r;
      const res = await request(http()).post(RUTA).send({});
      expect(res.status).toBe(403);
      expect(alinearFechaTramos).not.toHaveBeenCalled();
    },
  );

  it('campo extra en el DTO ⇒ 400 (forbidNonWhitelisted) sin llamar al service', async () => {
    const res = await request(http()).post(RUTA).send({ dias: 3 });
    expect(res.status).toBe(400);
    expect(alinearFechaTramos).not.toHaveBeenCalled();
  });

  it('`fecha_vuelo` que no es ISO ⇒ 400', async () => {
    const res = await request(http())
      .post(RUTA)
      .send({ fecha_vuelo: '13/10/2026' });
    expect(res.status).toBe(400);
    expect(alinearFechaTramos).not.toHaveBeenCalled();
  });

  it('id que no es uuid ⇒ 400 antes de tocar el service', async () => {
    const res = await request(http())
      .post('/v1/flights/abc/tramos/alinear-fecha')
      .send({});
    expect(res.status).toBe(400);
    expect(alinearFechaTramos).not.toHaveBeenCalled();
  });

  it('el 409 del service llega con su `code` y su texto a través del filtro', async () => {
    alinearFechaTramos.mockRejectedValue(errorVueloYaVolo(V, 338));
    const res = await request(http()).post(RUTA).send({});
    expect(res.status).toBe(409);
    const cuerpo = res.body as { code: string; message: string };
    expect(cuerpo.code).toBe('VUELO_YA_VOLO');
    expect(cuerpo.message).toBe(MENSAJE_VUELO_YA_VOLO);
  });
});
