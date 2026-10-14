// Los servicios reales arrastran BD, pyservices e IA: se stubbean; aquí se
// prueba el CABLEADO HTTP de `PATCH /v1/expenses/:id/fecha` (14-oct-2026,
// invariante 74): roles, DTO estricto, códigos del filtro y que el PATCH
// general sigue llegando a `update` sin opciones.
jest.mock('./expenses.service', () => ({ ExpensesService: class {} }));
jest.mock('./combustible-masivo.service', () => ({
  CombustibleMasivoService: class {},
}));

import {
  ConflictException,
  NotFoundException,
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
import { ROLES_CONCILIACION } from '../conciliacion/roles-conciliacion';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { CombustibleMasivoService } from './combustible-masivo.service';

type Servidor = Parameters<typeof request>[0];
/** Cuerpo de error del AllExceptionsFilter. */
type CuerpoError = { code: string; message: string | string[] };

const G = '08c0632c-5711-4f0d-affd-591d756dd9fc';
const RESPUESTA = {
  id: G,
  fecha_gasto: '2026-10-12',
  fecha_anterior: '2026-10-10',
  cambio: true,
  cambia_de_mes: false,
  fecha_hora_carga: null,
  updated_at: '2026-10-14T17:00:00.123456+00:00',
  aviso: null,
};

describe('PATCH /v1/expenses/:id/fecha — fecha del pago desde Conciliación', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    cambiarFechaGasto: jest.fn(),
    update: jest.fn(),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;
  const ruta = `/v1/expenses/${G}/fecha`;
  const CUERPO = { fecha_gasto: '2026-10-12', fecha_anterior: '2026-10-10' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ExpensesController],
      providers: [
        { provide: ExpensesService, useValue: svc },
        { provide: CombustibleMasivoService, useValue: {} },
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
    svc.cambiarFechaGasto.mockResolvedValue(RESPUESTA);
    svc.update.mockResolvedValue({ id: G });
  });

  it('ADMIN y FACTURACION ⇒ 200 con la respuesta del servicio, que recibe (id, dto, usuario, rol)', async () => {
    for (const r of [Rol.ADMIN, Rol.FACTURACION]) {
      rol = r;
      const res = await request(http()).patch(ruta).send(CUERPO);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(RESPUESTA);
      expect(svc.cambiarFechaGasto).toHaveBeenLastCalledWith(
        G,
        CUERPO,
        'u-1',
        r,
      );
    }
  }, 20_000);

  it('COORDINADOR, ANALISTA, SOCIO, PILOTO, MECANICO y VISITANTE ⇒ 403 sin llamar al servicio', async () => {
    for (const r of [
      Rol.COORDINADOR,
      Rol.ANALISTA,
      Rol.SOCIO,
      Rol.PILOTO,
      Rol.MECANICO,
      Rol.VISITANTE,
    ]) {
      rol = r;
      const res = await request(http()).patch(ruta).send(CUERPO);
      expect(res.status).toBe(403);
      expect((res.body as CuerpoError).code).toBe('FORBIDDEN');
    }
    expect(svc.cambiarFechaGasto).not.toHaveBeenCalled();
  }, 20_000);

  it('@Roles de la ruta = ROLES_CONCILIACION (la fuente única de quién concilia)', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      ExpensesController.prototype,
      'cambiarFecha',
    );
    expect(Reflect.getMetadata(ROLES_KEY, descriptor!.value as object)).toEqual(
      [...ROLES_CONCILIACION],
    );
  });

  it('DTO estricto ⇒ 400 BAD_REQUEST sin llamar al servicio (uuid, formato, falta fecha_anterior, llaves de más, booleano crudo)', async () => {
    const casos: Array<[string, Record<string, unknown>, string]> = [
      [
        '/v1/expenses/no-uuid/fecha',
        CUERPO,
        'Validation failed (uuid is expected)',
      ],
      [
        ruta,
        { ...CUERPO, fecha_gasto: '2026-10-1' },
        'fecha_gasto debe ser AAAA-MM-DD',
      ],
      [
        ruta,
        { ...CUERPO, fecha_gasto: '2026-10-12T05:00:00Z' },
        'fecha_gasto debe ser AAAA-MM-DD',
      ],
      [
        ruta,
        { fecha_gasto: '2026-10-12' },
        'fecha_anterior debe ser AAAA-MM-DD',
      ],
      [
        ruta,
        { ...CUERPO, verificado: true },
        'property verificado should not exist',
      ],
      [
        ruta,
        { ...CUERPO, permitir_fecha_antigua: true },
        'property permitir_fecha_antigua should not exist',
      ],
      [
        ruta,
        { ...CUERPO, if_updated_at: '2026-10-12T19:53:54.941Z' },
        'property if_updated_at should not exist',
      ],
      // Con enableImplicitConversion, 'false' sería Boolean('false') = true:
      // se valida el valor CRUDO del body.
      [
        ruta,
        { ...CUERPO, confirmar: 'false' },
        'confirmar debe ser true o false',
      ],
      [
        ruta,
        { ...CUERPO, confirmar: 'true' },
        'confirmar debe ser true o false',
      ],
    ];
    for (const [url, cuerpo, mensaje] of casos) {
      const res = await request(http()).patch(url).send(cuerpo);
      expect(res.status).toBe(400);
      const error = res.body as CuerpoError;
      expect(error.code).toBe('BAD_REQUEST');
      const mensajes = ([] as string[]).concat(error.message);
      expect(mensajes).toContain(mensaje);
    }
    expect(svc.cambiarFechaGasto).not.toHaveBeenCalled();
  }, 20_000);

  it('confirmar: true (y false) viaja al servicio tal cual', async () => {
    for (const confirmar of [true, false]) {
      const res = await request(http())
        .patch(ruta)
        .send({ ...CUERPO, confirmar });
      expect(res.status).toBe(200);
      expect(svc.cambiarFechaGasto).toHaveBeenLastCalledWith(
        G,
        { ...CUERPO, confirmar },
        'u-1',
        Rol.ADMIN,
      );
    }
  });

  it('los rechazos del servicio llegan con su code y details (lo que lee el panel)', async () => {
    svc.cambiarFechaGasto.mockRejectedValueOnce(
      new ConflictException({
        message: 'Pasa de septiembre 2026 a octubre 2026. …',
        error: 'FECHA_GASTO_CONFIRMAR',
        details: {
          cambia_de_mes: true,
          mes_antes: '2026-09',
          mes_despues: '2026-10',
          etiqueta_mes_despues: 'octubre 2026',
          meses_terminados: ['2026-09'],
        },
      }),
    );
    const res = await request(http()).patch(ruta).send(CUERPO);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'FECHA_GASTO_CONFIRMAR',
      message: 'Pasa de septiembre 2026 a octubre 2026. …',
      details: { cambia_de_mes: true, etiqueta_mes_despues: 'octubre 2026' },
    });
    svc.cambiarFechaGasto.mockRejectedValueOnce(
      new NotFoundException({
        message: 'Ese gasto ya no existe: recarga la página.',
        error: 'GASTO_NO_EXISTE',
      }),
    );
    const nf = await request(http()).patch(ruta).send(CUERPO);
    expect(nf.status).toBe(404);
    expect(nf.body).toMatchObject({
      code: 'GASTO_NO_EXISTE',
      message: 'Ese gasto ya no existe: recarga la página.',
    });
  });

  it('PATCH /v1/expenses/:id sigue llegando a update con 4 argumentos (sin opciones: auto-cruce de siempre)', async () => {
    const res = await request(http())
      .patch(`/v1/expenses/${G}`)
      .send({ fecha_gasto: '2026-10-12' });
    expect(res.status).toBe(200);
    expect(svc.cambiarFechaGasto).not.toHaveBeenCalled();
    expect(svc.update).toHaveBeenCalledTimes(1);
    expect(svc.update.mock.calls[0]).toEqual([
      G,
      { fecha_gasto: '2026-10-12' },
      'u-1',
      Rol.ADMIN,
    ]);
  });
});
