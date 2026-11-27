// Cableado HTTP REAL de `PATCH /v1/flights/:id/cliente` (27-nov-2026):
// ValidationPipe de main.ts (whitelist + forbidNonWhitelisted) +
// AllExceptionsFilter + versionado URI + RolesGuard. Los servicios pesados se
// stubbean (notifications/jose, calendar/googleapis).
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
import {
  errorClienteNoExiste,
  errorVueloFacturado,
} from './cambio-cliente.util';

const V = 'aaaaaaaa-0000-4000-8000-000000000501';
const C = 'aaaaaaaa-0000-4000-8000-0000000000c2';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';
const RUTA = `/v1/flights/${V}/cliente`;

type Servidor = Parameters<typeof request>[0];

describe('FlightsController — cambiar cliente: @Roles', () => {
  it('solo ADMIN y COORDINADOR (los mismos que guardan una cotización)', () => {
    const proto = FlightsController.prototype as unknown as Record<
      string,
      object
    >;
    expect(Reflect.getMetadata(ROLES_KEY, proto.cambiarCliente)).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
    ]);
  });
});

describe('FlightsController — PATCH :id/cliente por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const cambiarCliente = jest.fn();
  const update = jest.fn();
  const http = (): Servidor => app.getHttpServer() as Servidor;
  const respuesta = {
    id: V,
    folio: 501,
    cliente_id: C,
    sin_cambio: false,
    avisos: [],
    cliente_anterior: { id: 'x', nombre: 'Beh Kay' },
    cliente: { id: C, nombre: 'January Davila' },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FlightsController],
      providers: [
        { provide: FlightsService, useValue: { cambiarCliente, update } },
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
    cambiarCliente.mockReset();
    cambiarCliente.mockResolvedValue(respuesta);
    update.mockReset();
  });

  it.each([Rol.ADMIN, Rol.COORDINADOR])(
    '%s ⇒ 200 y el service recibe (id, dto, userId); NO cae en PATCH :id',
    async (r) => {
      rol = r;
      const res = await request(http()).patch(RUTA).send({ cliente_id: C });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(respuesta);
      expect(update).not.toHaveBeenCalled();
      const [id, dto, userId] = cambiarCliente.mock.calls[0] as [
        string,
        { cliente_id: string; if_updated_at?: string },
        string,
      ];
      expect(id).toBe(V);
      expect(dto.cliente_id).toBe(C);
      expect(dto.if_updated_at).toBeUndefined();
      expect(userId).toBe(USER);
    },
  );

  it('`if_updated_at` viaja tal cual', async () => {
    const res = await request(http())
      .patch(RUTA)
      .send({ cliente_id: C, if_updated_at: '2026-11-27T15:00:00.123Z' });
    expect(res.status).toBe(200);
    expect(
      (cambiarCliente.mock.calls[0] as [string, { if_updated_at?: string }])[1]
        .if_updated_at,
    ).toBe('2026-11-27T15:00:00.123Z');
  });

  it.each([Rol.FACTURACION, Rol.PILOTO, Rol.SOCIO, Rol.ANALISTA, Rol.MECANICO])(
    '%s ⇒ 403 y el service NO se llama',
    async (r) => {
      rol = r;
      const res = await request(http()).patch(RUTA).send({ cliente_id: C });
      expect(res.status).toBe(403);
      expect(cambiarCliente).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['sin cliente_id', {}],
    ['cliente_id que no es uuid', { cliente_id: 'beh' }],
    [
      'campo extra (no se cuela un precio)',
      { cliente_id: C, monto_total_usd: 1 },
    ],
    ['if_updated_at que no es fecha', { cliente_id: C, if_updated_at: 'ayer' }],
  ])('%s ⇒ 400 sin llamar al service', async (_caso, cuerpo) => {
    const res = await request(http()).patch(RUTA).send(cuerpo);
    expect(res.status).toBe(400);
    expect(cambiarCliente).not.toHaveBeenCalled();
  });

  it('id de vuelo que no es uuid ⇒ 400', async () => {
    const res = await request(http())
      .patch('/v1/flights/abc/cliente')
      .send({ cliente_id: C });
    expect(res.status).toBe(400);
    expect(cambiarCliente).not.toHaveBeenCalled();
  });

  it('los rechazos del service llegan con su `code`, texto y details por el filtro', async () => {
    cambiarCliente.mockRejectedValue(
      errorVueloFacturado({
        folio: 501,
        motivo: 'FACTURA_EMITIDA',
        facturas: ['A-0440'],
      }),
    );
    const res = await request(http()).patch(RUTA).send({ cliente_id: C });
    expect(res.status).toBe(409);
    const cuerpo = res.body as {
      code: string;
      message: string;
      details: Record<string, unknown>;
    };
    expect(cuerpo.code).toBe('VUELO_FACTURADO');
    expect(cuerpo.message).toContain('A-0440');
    expect(cuerpo.details).toEqual({
      motivo: 'FACTURA_EMITIDA',
      facturas: ['A-0440'],
    });

    cambiarCliente.mockRejectedValue(errorClienteNoExiste(C));
    const res404 = await request(http()).patch(RUTA).send({ cliente_id: C });
    expect(res404.status).toBe(404);
    expect((res404.body as { code: string }).code).toBe('CLIENTE_NO_EXISTE');
  });
});
