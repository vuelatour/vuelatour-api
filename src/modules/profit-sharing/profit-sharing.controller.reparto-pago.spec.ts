// Cableado HTTP REAL de la CUENTA CORRIENTE DEL SOCIO (v2, 2-oct-2026):
// ValidationPipe de main.ts (whitelist + forbidNonWhitelisted + conversión
// implícita) + AllExceptionsFilter + versionado URI + RolesGuard. Los
// servicios se stubbean (el real arrastra pyservices / tipo de cambio /
// conciliación).
jest.mock('./profit-sharing.service', () => ({
  ProfitSharingService: class {},
}));
jest.mock('./dinero-report.service', () => ({
  DineroReportService: class {},
}));
jest.mock('./reparto-pago.service', () => ({
  RepartoPagoService: class {},
}));
jest.mock('./reparto-cuenta.service', () => ({
  RepartoCuentaService: class {},
}));

import {
  ConflictException,
  ForbiddenException,
  GoneException,
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
import { RepartoCuentaService } from './reparto-cuenta.service';
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

/** El caso del audio: 70,000 MXN a 18.5 en efectivo, sin mes (a cuenta). */
const ALTA = {
  socio_id: MAURICIO,
  monto: 70000,
  moneda: 'MXN',
  tc_usd_mxn: 18.5,
  fecha_pago: '2026-10-01',
  metodo: 'EFECTIVO',
};

describe('ProfitSharingController — cuenta del socio: @Roles en CADA ruta', () => {
  const proto = ProfitSharingController.prototype as unknown as Record<
    string,
    object
  >;
  it.each([
    ['resumenCuentasSocios', ROLES_PAGOS_SOCIOS_LECTURA],
    ['estadoCuentaSocio', ROLES_PAGOS_SOCIOS_LECTURA],
    ['configurarCuentaSocio', ROLES_PAGOS_SOCIOS_ESCRITURA],
    ['listarPagosSocios', ROLES_PAGOS_SOCIOS_LECTURA],
    ['crearPagoSocio', ROLES_PAGOS_SOCIOS_ESCRITURA],
    ['actualizarPagoSocio', ROLES_PAGOS_SOCIOS_ESCRITURA],
    ['eliminarPagoSocio', ROLES_PAGOS_SOCIOS_ESCRITURA],
    ['subirComprobantePagoSocio', ROLES_PAGOS_SOCIOS_ESCRITURA],
  ])('%s', (metodo, roles) => {
    expect(Reflect.getMetadata(ROLES_KEY, proto[metodo])).toEqual([...roles]);
  });
});

describe('ProfitSharingController — cuenta del socio por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const resumen = jest.fn();
  const estadoDeCuenta = jest.fn();
  const configurarCuenta = jest.fn();
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
          provide: RepartoCuentaService,
          useValue: { resumen, estadoDeCuenta, configurarCuenta },
        },
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
      resumen,
      estadoDeCuenta,
      configurarCuenta,
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
    resumen.mockResolvedValue({ disponible: true, socios: [], totales: null });
    estadoDeCuenta.mockResolvedValue({ disponible: true, movimientos: [] });
    configurarCuenta.mockResolvedValue({ socio: { id: MAURICIO } });
    listar.mockResolvedValue({ disponible: true, pagos: [] });
    crear.mockResolvedValue({ pago: { id: PAGO }, cuenta: {} });
    actualizar.mockResolvedValue({ pago: { id: PAGO }, cuenta: {} });
    eliminar.mockResolvedValue({ deleted: true, cuenta: {} });
    subirComprobante.mockResolvedValue({ pago: { id: PAGO } });
  });

  it('GET socios: ADMIN, ANALISTA, FACTURACION y SOCIO leen (el service recibe al actor); los demás ⇒ 403; no cae en el reparto', async () => {
    for (const r of [Rol.ADMIN, Rol.ANALISTA, Rol.FACTURACION, Rol.SOCIO]) {
      rol = r;
      expect(
        (await request(http()).get('/v1/profit-sharing/socios')).status,
      ).toBe(200);
    }
    expect(resumen).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: USER, rol: Rol.SOCIO }),
    );
    for (const r of [
      Rol.COORDINADOR,
      Rol.PILOTO,
      Rol.MECANICO,
      Rol.VISITANTE,
    ]) {
      rol = r;
      expect(
        (await request(http()).get('/v1/profit-sharing/socios')).status,
      ).toBe(403);
    }
    expect(resumen).toHaveBeenCalledTimes(4);
    expect(compute).not.toHaveBeenCalled();
  });

  it('GET socios/:socioId/estado-cuenta: meses AAAA-MM al service; uuid o mes inválido ⇒ 400; el 403 del SOCIO ajeno llega con code', async () => {
    const ok = await request(http()).get(
      `/v1/profit-sharing/socios/${MAURICIO}/estado-cuenta?desde=2026-09&hasta=2026-10`,
    );
    expect(ok.status).toBe(200);
    expect(estadoDeCuenta).toHaveBeenCalledWith(
      MAURICIO,
      { desde: '2026-09', hasta: '2026-10' },
      expect.objectContaining({ userId: USER, rol: Rol.ADMIN }),
    );
    for (const url of [
      '/v1/profit-sharing/socios/no-uuid/estado-cuenta',
      `/v1/profit-sharing/socios/${MAURICIO}/estado-cuenta?desde=2026-9`,
      `/v1/profit-sharing/socios/${MAURICIO}/estado-cuenta?hasta=2026-10-01`,
      `/v1/profit-sharing/socios/${MAURICIO}/estado-cuenta?mes=2026-10`,
    ]) {
      expect([url, (await request(http()).get(url)).status]).toEqual([
        url,
        400,
      ]);
    }
    expect(estadoDeCuenta).toHaveBeenCalledTimes(1);
    rol = Rol.SOCIO;
    estadoDeCuenta.mockRejectedValueOnce(
      new ForbiddenException({
        message: 'Solo puedes consultar tu propia cuenta.',
        error: 'SOCIO_SOLO_SU_CUENTA',
      }),
    );
    const r403 = await request(http()).get(
      `/v1/profit-sharing/socios/${N4142R}/estado-cuenta`,
    );
    expect(r403.status).toBe(403);
    expect(r403.body).toMatchObject({ code: 'SOCIO_SOLO_SU_CUENTA' });
    rol = Rol.COORDINADOR;
    expect(
      (
        await request(http()).get(
          `/v1/profit-sharing/socios/${MAURICIO}/estado-cuenta`,
        )
      ).status,
    ).toBe(403);
  });

  it('PUT socios/:socioId/cuenta: ADMIN/FACTURACION; DTO (mes AAAA-MM, saldo con ≤ 2 decimales y negativo válido, notas recortadas); otros roles 403', async () => {
    const ok = await request(http())
      .put(`/v1/profit-sharing/socios/${MAURICIO}/cuenta`)
      .send({
        cuenta_desde: '2026-08',
        saldo_inicial_usd: -1500.25,
        notas: '  Ya adelantado ',
      });
    expect(ok.status).toBe(200);
    expect(configurarCuenta).toHaveBeenCalledWith(
      MAURICIO,
      {
        cuenta_desde: '2026-08',
        saldo_inicial_usd: -1500.25,
        notas: 'Ya adelantado',
      },
      expect.objectContaining({ userId: USER }),
    );
    for (const malo of [
      { cuenta_desde: '2026-08-01', saldo_inicial_usd: 0 },
      { cuenta_desde: '2026-08', saldo_inicial_usd: 1.005 },
      { cuenta_desde: '2026-08' },
      { cuenta_desde: '2026-08', saldo_inicial_usd: 0, notas: 'n'.repeat(501) },
      { cuenta_desde: '2026-08', saldo_inicial_usd: 0, socio_id: MAURICIO },
    ]) {
      const res = await request(http())
        .put(`/v1/profit-sharing/socios/${MAURICIO}/cuenta`)
        .send(malo);
      expect([JSON.stringify(malo), res.status]).toEqual([
        JSON.stringify(malo),
        400,
      ]);
    }
    for (const r of [Rol.ANALISTA, Rol.SOCIO, Rol.COORDINADOR]) {
      rol = r;
      expect(
        (
          await request(http())
            .put(`/v1/profit-sharing/socios/${MAURICIO}/cuenta`)
            .send({ cuenta_desde: '2026-09', saldo_inicial_usd: 0 })
        ).status,
      ).toBe(403);
    }
    rol = Rol.FACTURACION;
    expect(
      (
        await request(http())
          .put(`/v1/profit-sharing/socios/${MAURICIO}/cuenta`)
          .send({ cuenta_desde: '2026-09', saldo_inicial_usd: 0 })
      ).status,
    ).toBe(200);
    expect(configurarCuenta).toHaveBeenCalledTimes(2);
  });

  it('GET pagos: rango de fechas y socio al service; ?mes= (y ?mes=&aeronave_id= del panel 0.0.49) llega al service y su 410 sale con code; COORDINADOR ⇒ 403', async () => {
    const ok = await request(http()).get(
      `/v1/profit-sharing/pagos?desde=2026-09-01&hasta=2026-10-31&socio_id=${MAURICIO}`,
    );
    expect(ok.status).toBe(200);
    expect(listar).toHaveBeenCalledWith(
      { desde: '2026-09-01', hasta: '2026-10-31', socio_id: MAURICIO },
      expect.objectContaining({ userId: USER }),
    );
    listar.mockRejectedValueOnce(
      new GoneException({
        message: 'El listado de pagos por mes se retiró…',
        error: 'PAGOS_POR_MES_RETIRADO',
      }),
    );
    const r410 = await request(http()).get(
      '/v1/profit-sharing/pagos?mes=2026-09',
    );
    expect(r410.status).toBe(410);
    expect(r410.body).toMatchObject({ code: 'PAGOS_POR_MES_RETIRADO' });
    // El panel 0.0.49 filtrado por avión manda los DOS: no debe chocar con
    // `forbidNonWhitelisted` (400 genérico) sino llegar al 410 del service.
    listar.mockRejectedValueOnce(
      new GoneException({
        message: 'El listado de pagos por mes se retiró…',
        error: 'PAGOS_POR_MES_RETIRADO',
      }),
    );
    const r410Avion = await request(http()).get(
      `/v1/profit-sharing/pagos?mes=2026-09&aeronave_id=${MAURICIO}`,
    );
    expect(r410Avion.status).toBe(410);
    expect(r410Avion.body).toMatchObject({ code: 'PAGOS_POR_MES_RETIRADO' });
    expect(listar).toHaveBeenLastCalledWith(
      { mes: '2026-09', aeronave_id: MAURICIO },
      expect.objectContaining({ userId: USER }),
    );
    for (const q of ['?desde=01/09/2026', '?socio_id=x', '?otra=1']) {
      expect(
        (await request(http()).get(`/v1/profit-sharing/pagos${q}`)).status,
      ).toBe(400);
    }
    rol = Rol.COORDINADOR;
    expect((await request(http()).get('/v1/profit-sharing/pagos')).status).toBe(
      403,
    );
  });

  it('GET pre-cierre: el controller pasa el ROL al service; COORDINADOR sigue entrando', async () => {
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

  it('POST pagos: 201 con el DTO limpio («corresponde a» opcional); replay idempotente ⇒ 200', async () => {
    const res = await request(http())
      .post('/v1/profit-sharing/pagos')
      .send({
        ...ALTA,
        recibido_por: '  El socio en persona  ',
        aceptar_exceso: true,
        client_request_id: KEY,
      });
    expect(res.status).toBe(201);
    expect(crear).toHaveBeenCalledWith(
      expect.objectContaining({
        ...ALTA,
        recibido_por: 'El socio en persona',
        aceptar_exceso: true,
        client_request_id: KEY,
      }),
      expect.objectContaining({ userId: USER }),
    );
    const conMes = await request(http())
      .post('/v1/profit-sharing/pagos')
      .send({ ...ALTA, mes: '2026-09', aeronave_id: N4142R });
    expect(conMes.status).toBe(201);
    crear.mockResolvedValueOnce({
      pago: { id: PAGO },
      cuenta: {},
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

  it('POST pagos: forma inválida ⇒ 400 (sin socio, campo extra, monto con 3 decimales, método, moneda, fecha, mes)', async () => {
    const { socio_id: _sinSocio, ...sinSocio } = ALTA;
    void _sinSocio;
    for (const malo of [
      sinSocio,
      { ...ALTA, socio_id: 'x' },
      { ...ALTA, aeronave_id: 'x' },
      { ...ALTA, monto: 10.005 },
      { ...ALTA, monto: 0 },
      { ...ALTA, moneda: 'EUR' },
      { ...ALTA, metodo: 'DEPOSITO' },
      { ...ALTA, fecha_pago: '01/10/2026' },
      { ...ALTA, mes: '2026-09-01' },
      { ...ALTA, referencia: 'r'.repeat(121) },
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

  it('el 409 del ADELANTO y el 503 sin migración llegan con code y details por el filtro', async () => {
    crear.mockRejectedValueOnce(
      new ConflictException({
        message:
          'Esta entrega de $3,783.78 USD supera lo que hay por entregar…',
        error: 'PAGO_EXCEDE_SALDO',
        details: {
          por_entregar_usd: 1395.94,
          monto_usd: 3783.78,
          exceso_usd: 2387.84,
          saldo_despues_usd: -2387.84,
        },
      }),
    );
    const r409 = await request(http())
      .post('/v1/profit-sharing/pagos')
      .send(ALTA);
    expect(r409.status).toBe(409);
    expect(r409.body).toMatchObject({
      code: 'PAGO_EXCEDE_SALDO',
      details: { exceso_usd: 2387.84 },
    });
    crear.mockRejectedValueOnce(
      new ServiceUnavailableException({
        message: 'no disponible',
        error: 'CUENTA_SOCIO_NO_DISPONIBLE',
        details: { migracion: '20261002000001' },
      }),
    );
    const r503 = await request(http())
      .post('/v1/profit-sharing/pagos')
      .send(ALTA);
    expect(r503.status).toBe(503);
    expect(r503.body).toMatchObject({ code: 'CUENTA_SOCIO_NO_DISPONIBLE' });
  });

  it('PATCH pagos/:id: parcial; null en monto ⇒ 400; null en notas/T.C./mes/avión limpia; uuid inválido ⇒ 400; socio no se cambia', async () => {
    const ok = await request(http())
      .patch(`/v1/profit-sharing/pagos/${PAGO}`)
      .send({
        notas: null,
        tc_usd_mxn: null,
        metodo: 'EFECTIVO',
        mes: null,
        aeronave_id: null,
      });
    expect(ok.status).toBe(200);
    expect(actualizar).toHaveBeenCalledWith(
      PAGO,
      expect.objectContaining({
        notas: null,
        tc_usd_mxn: null,
        metodo: 'EFECTIVO',
        mes: null,
        aeronave_id: null,
      }),
      expect.objectContaining({ userId: USER }),
    );
    for (const malo of [
      { monto: null },
      { moneda: null },
      { fecha_pago: null },
      { metodo: null },
      { socio_id: MAURICIO },
      { mes: '2026-9' },
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

  it('DELETE pagos/:id: 200 con motivo recortado; sin motivo o corto ⇒ 400; ANALISTA ⇒ 403', async () => {
    const ok = await request(http())
      .delete(`/v1/profit-sharing/pagos/${PAGO}`)
      .send({ motivo: '  Capturado dos veces  ' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ deleted: true, cuenta: {} });
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

  it('POST pagos/:id/comprobante: multipart `file` ⇒ 200; sin archivo ⇒ 400 SIN_ARCHIVO; campo extra ⇒ 400; SOCIO ⇒ 403', async () => {
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
