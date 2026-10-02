// Cableado HTTP REAL de los PAGOS A SOCIOS (1-oct-2026): ValidationPipe de
// main.ts (whitelist + forbidNonWhitelisted + conversión implícita) +
// AllExceptionsFilter + versionado URI + RolesGuard. Los servicios se
// stubbean (el real arrastra pyservices / tipo de cambio / conciliación).
jest.mock('./profit-sharing.service', () => ({
  ProfitSharingService: class {},
}));
jest.mock('./dinero-report.service', () => ({
  DineroReportService: class {},
}));
jest.mock('./reparto-pago.service', () => ({
  RepartoPagoService: class {},
}));

import {
  ConflictException,
  ServiceUnavailableException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { DineroReportService } from './dinero-report.service';
import { ProfitSharingController } from './profit-sharing.controller';
import { ProfitSharingService } from './profit-sharing.service';
import { RepartoPagoService } from './reparto-pago.service';
import {
  ROLES_PAGOS_SOCIOS_ESCRITURA,
  ROLES_PAGOS_SOCIOS_LECTURA,
} from './reparto-pago.util';

const N4142R = 'aaaaaaaa-0000-4000-8000-000000004142';
const MAURICIO = 'bbbbbbbb-0000-4000-8000-000000000069';
const PAGO = 'dddddddd-0000-4000-8000-000000000001';
const USER = 'cccccccc-0000-4000-8000-0000000000a1';
const KEY = 'eeeeeeee-0000-4000-8000-000000000001';

type Servidor = Parameters<typeof request>[0];

const ALTA = {
  aeronave_id: N4142R,
  socio_id: MAURICIO,
  mes: '2026-09',
  monto: 1395.94,
  moneda: 'USD',
  fecha_pago: '2026-10-01',
  metodo: 'TRANSFERENCIA',
};

describe('ProfitSharingController — pagos a socios: @Roles en CADA ruta', () => {
  const proto = ProfitSharingController.prototype as unknown as Record<
    string,
    object
  >;
  it.each([
    ['listarPagosSocios', ROLES_PAGOS_SOCIOS_LECTURA],
    ['crearPagoSocio', ROLES_PAGOS_SOCIOS_ESCRITURA],
    ['actualizarPagoSocio', ROLES_PAGOS_SOCIOS_ESCRITURA],
    ['eliminarPagoSocio', ROLES_PAGOS_SOCIOS_ESCRITURA],
    ['subirComprobantePagoSocio', ROLES_PAGOS_SOCIOS_ESCRITURA],
  ])('%s', (metodo, roles) => {
    expect(Reflect.getMetadata(ROLES_KEY, proto[metodo])).toEqual([...roles]);
  });
});

describe('ProfitSharingController — pagos a socios por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const listar = jest.fn();
  const crear = jest.fn();
  const actualizar = jest.fn();
  const eliminar = jest.fn();
  const subirComprobante = jest.fn();
  const compute = jest.fn();
  const preCierre = jest.fn();
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProfitSharingController],
      providers: [
        { provide: ProfitSharingService, useValue: { compute, preCierre } },
        { provide: DineroReportService, useValue: {} },
        {
          provide: RepartoPagoService,
          useValue: { listar, crear, actualizar, eliminar, subirComprobante },
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
    for (const f of [
      listar,
      crear,
      actualizar,
      eliminar,
      subirComprobante,
      compute,
      preCierre,
    ])
      f.mockReset();
    preCierre.mockResolvedValue({ listo: true, items: [] });
    listar.mockResolvedValue({ disponible: true, mes: '2026-09', filas: [] });
    crear.mockResolvedValue({ pago: { id: PAGO }, fila: null });
    actualizar.mockResolvedValue({ pago: { id: PAGO }, fila: null });
    eliminar.mockResolvedValue({ deleted: true, fila: null });
    subirComprobante.mockResolvedValue({ pago: { id: PAGO } });
  });

  it('GET pagos: ADMIN, ANALISTA, FACTURACION y SOCIO leen; el service recibe (mes, avión, actor)', async () => {
    for (const r of [Rol.ADMIN, Rol.ANALISTA, Rol.FACTURACION, Rol.SOCIO]) {
      rol = r;
      const res = await request(http()).get(
        `/v1/profit-sharing/pagos?mes=2026-09&aeronave_id=${N4142R}`,
      );
      expect(res.status).toBe(200);
    }
    expect(listar).toHaveBeenLastCalledWith(
      '2026-09',
      N4142R,
      expect.objectContaining({ userId: USER, rol: Rol.SOCIO }),
    );
    // La ruta literal `pagos` NO cae en el reparto (`GET /`).
    expect(compute).not.toHaveBeenCalled();
  });

  it('GET pagos: COORDINADOR, PILOTO, MECANICO y VISITANTE ⇒ 403', async () => {
    for (const r of [
      Rol.COORDINADOR,
      Rol.PILOTO,
      Rol.MECANICO,
      Rol.VISITANTE,
    ]) {
      rol = r;
      expect(
        (await request(http()).get('/v1/profit-sharing/pagos?mes=2026-09'))
          .status,
      ).toBe(403);
    }
    expect(listar).not.toHaveBeenCalled();
  });

  it('GET pre-cierre: el controller pasa el ROL al service (decide si salen los items de pagos a socios); COORDINADOR sigue entrando', async () => {
    for (const r of [
      Rol.ADMIN,
      Rol.ANALISTA,
      Rol.FACTURACION,
      Rol.COORDINADOR,
    ]) {
      rol = r;
      const res = await request(http()).get(
        '/v1/profit-sharing/pre-cierre?desde=2026-09-01&hasta=2026-09-30',
      );
      expect(res.status).toBe(200);
      expect(preCierre).toHaveBeenLastCalledWith(
        expect.objectContaining({ desde: '2026-09-01', hasta: '2026-09-30' }),
        r,
      );
    }
  });

  it('GET pagos: mes inválido o ausente ⇒ 400 sin tocar el service', async () => {
    for (const q of [
      '',
      '?mes=2026-9',
      '?mes=2026-13',
      '?mes=2026-09-01',
      '?mes=2026-09&aeronave_id=x',
    ]) {
      expect(
        (await request(http()).get(`/v1/profit-sharing/pagos${q}`)).status,
      ).toBe(400);
    }
    expect(listar).not.toHaveBeenCalled();
  });

  it('POST pagos: 201 con el DTO limpio; replay idempotente ⇒ 200', async () => {
    const res = await request(http())
      .post('/v1/profit-sharing/pagos')
      .send({
        ...ALTA,
        referencia: '  SPEI 1  ',
        aceptar_exceso: false,
        client_request_id: KEY,
      });
    expect(res.status).toBe(201);
    expect(crear).toHaveBeenCalledWith(
      expect.objectContaining({
        ...ALTA,
        referencia: 'SPEI 1',
        aceptar_exceso: false,
        client_request_id: KEY,
      }),
      expect.objectContaining({ userId: USER }),
    );
    crear.mockResolvedValueOnce({
      pago: { id: PAGO },
      fila: null,
      idempotente: true,
    });
    const replay = await request(http())
      .post('/v1/profit-sharing/pagos')
      .send({ ...ALTA, client_request_id: KEY });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ idempotente: true });
  });

  it('POST pagos: el texto «false» en aceptar_exceso es 400 (no se convierte en true)', async () => {
    const res = await request(http())
      .post('/v1/profit-sharing/pagos')
      .send({ ...ALTA, aceptar_exceso: 'false' });
    expect(res.status).toBe(400);
    expect(crear).not.toHaveBeenCalled();
  });

  it('POST pagos: forma inválida ⇒ 400 (campo extra, monto con 3 decimales, método, moneda, fecha)', async () => {
    for (const malo of [
      { ...ALTA, aeronave_id: 'x' },
      { ...ALTA, monto: 10.005 },
      { ...ALTA, monto: 0 },
      { ...ALTA, moneda: 'EUR' },
      { ...ALTA, metodo: 'DEPOSITO' },
      { ...ALTA, fecha_pago: '01/10/2026' },
      { ...ALTA, mes: '2026-09-01' },
      { ...ALTA, referencia: 'r'.repeat(121) },
      { ...ALTA, factura_folio: 'f'.repeat(61) },
      { ...ALTA, notas: 'n'.repeat(501) },
      { ...ALTA, socio_nombre: 'Mauricio' },
    ]) {
      const res = await request(http())
        .post('/v1/profit-sharing/pagos')
        .send(malo);
      expect([JSON.stringify(Object.keys(malo)), res.status]).toEqual([
        JSON.stringify(Object.keys(malo)),
        400,
      ]);
    }
    expect(crear).not.toHaveBeenCalled();
  });

  it('POST pagos: COORDINADOR, ANALISTA y SOCIO no escriben (403)', async () => {
    for (const r of [Rol.COORDINADOR, Rol.ANALISTA, Rol.SOCIO]) {
      rol = r;
      expect(
        (await request(http()).post('/v1/profit-sharing/pagos').send(ALTA))
          .status,
      ).toBe(403);
    }
    rol = Rol.FACTURACION;
    expect(
      (await request(http()).post('/v1/profit-sharing/pagos').send(ALTA))
        .status,
    ).toBe(201);
  });

  it('el 409 del exceso y el 503 sin migración llegan con code y details por el filtro', async () => {
    crear.mockRejectedValueOnce(
      new ConflictException({
        message: 'Con este pago…',
        error: 'PAGO_EXCEDE_UTILIDAD',
        details: {
          utilidad_usd: 1395.94,
          pagado_usd: 1000,
          monto_usd: 500,
          exceso_usd: 104.06,
        },
      }),
    );
    const r409 = await request(http())
      .post('/v1/profit-sharing/pagos')
      .send(ALTA);
    expect(r409.status).toBe(409);
    expect(r409.body).toMatchObject({
      code: 'PAGO_EXCEDE_UTILIDAD',
      details: { exceso_usd: 104.06 },
    });
    crear.mockRejectedValueOnce(
      new ServiceUnavailableException({
        message: 'no disponible',
        error: 'PAGOS_SOCIOS_NO_DISPONIBLE',
        details: { migracion: '20261001000001' },
      }),
    );
    const r503 = await request(http())
      .post('/v1/profit-sharing/pagos')
      .send(ALTA);
    expect(r503.status).toBe(503);
    expect(r503.body).toMatchObject({ code: 'PAGOS_SOCIOS_NO_DISPONIBLE' });
  });

  it('PATCH pagos/:id: parcial; null en monto ⇒ 400; null en notas/T.C. limpia; uuid inválido ⇒ 400', async () => {
    const ok = await request(http())
      .patch(`/v1/profit-sharing/pagos/${PAGO}`)
      .send({ notas: null, tc_usd_mxn: null, metodo: 'EFECTIVO' });
    expect(ok.status).toBe(200);
    expect(actualizar).toHaveBeenCalledWith(
      PAGO,
      expect.objectContaining({
        notas: null,
        tc_usd_mxn: null,
        metodo: 'EFECTIVO',
      }),
      expect.objectContaining({ userId: USER }),
    );
    for (const malo of [
      { monto: null },
      { moneda: null },
      { fecha_pago: null },
      { metodo: null },
      { aeronave_id: N4142R },
    ]) {
      expect(
        (
          await request(http())
            .patch(`/v1/profit-sharing/pagos/${PAGO}`)
            .send(malo)
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await request(http())
          .patch('/v1/profit-sharing/pagos/no-uuid')
          .send({ notas: 'x' })
      ).status,
    ).toBe(400);
    expect(actualizar).toHaveBeenCalledTimes(1);
  });

  it('DELETE pagos/:id: 200 con motivo recortado; sin motivo o corto ⇒ 400', async () => {
    const ok = await request(http())
      .delete(`/v1/profit-sharing/pagos/${PAGO}`)
      .send({ motivo: '  Capturado dos veces  ' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ deleted: true, fila: null });
    expect(eliminar).toHaveBeenCalledWith(
      PAGO,
      'Capturado dos veces',
      expect.objectContaining({ userId: USER }),
    );
    expect(
      (await request(http()).delete(`/v1/profit-sharing/pagos/${PAGO}`)).status,
    ).toBe(400);
    expect(
      (
        await request(http())
          .delete(`/v1/profit-sharing/pagos/${PAGO}`)
          .send({ motivo: 'ups' })
      ).status,
    ).toBe(400);
    rol = Rol.ANALISTA;
    expect(
      (
        await request(http())
          .delete(`/v1/profit-sharing/pagos/${PAGO}`)
          .send({ motivo: 'Capturado dos veces' })
      ).status,
    ).toBe(403);
    expect(eliminar).toHaveBeenCalledTimes(1);
  });

  it('POST pagos/:id/comprobante: multipart `file` ⇒ 200; sin archivo ⇒ 400 SIN_ARCHIVO; campo extra ⇒ 400', async () => {
    const ok = await request(http())
      .post(`/v1/profit-sharing/pagos/${PAGO}/comprobante`)
      .attach('file', Buffer.from('%PDF-1.4 hola'), {
        filename: 'spei.pdf',
        contentType: 'application/pdf',
      });
    expect(ok.status).toBe(200);
    expect(subirComprobante).toHaveBeenCalledWith(
      PAGO,
      expect.objectContaining({ nombre: 'spei.pdf', mime: 'application/pdf' }),
      expect.objectContaining({ userId: USER }),
    );
    const sin = await request(http())
      .post(`/v1/profit-sharing/pagos/${PAGO}/comprobante`)
      .field('x', '1');
    expect(sin.status).toBe(400);
    const vacio = await request(http())
      .post(`/v1/profit-sharing/pagos/${PAGO}/comprobante`)
      .send({});
    expect(vacio.status).toBe(400);
    expect(vacio.body).toMatchObject({ code: 'SIN_ARCHIVO' });
    rol = Rol.SOCIO;
    const r403 = await request(http())
      .post(`/v1/profit-sharing/pagos/${PAGO}/comprobante`)
      .attach('file', Buffer.from('x'), {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      });
    expect(r403.status).toBe(403);
    expect(subirComprobante).toHaveBeenCalledTimes(1);
  });
});
