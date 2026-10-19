// Los servicios reales arrastran BD, pyservices e IA: se stubbean; aquí se
// prueba el CABLEADO HTTP de los gastos «por pagar» (19-oct-2026, API 0.0.95,
// invariante 93): `por_pagar` booleano CRUDO en alta y PATCH, `?por_pagar=`
// en la lista y la excepción de ventana del dueño SOLO con el PATCH mínimo.
jest.mock('./expenses.service', () => ({ ExpensesService: class {} }));
jest.mock('./combustible-masivo.service', () => ({
  CombustibleMasivoService: class {},
}));

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { CombustibleMasivoService } from './combustible-masivo.service';

type Servidor = Parameters<typeof request>[0];
/** Argumentos de cada llamada a un mock (sin `any`). */
const llamadas = (m: jest.Mock): unknown[][] => m.mock.calls as unknown[][];
type CuerpoError = { code: string; message: string | string[] };

const GASTO = '0f5e6659-2c39-40d0-89d5-3fbd8d98537d';

const alta = (extra: Record<string, unknown> = {}) => ({
  categoria: 'OTRO',
  monto: 350,
  moneda: 'MXN',
  fecha_gasto: '2026-10-24',
  medio_pago: 'EFECTIVO',
  ...extra,
});

describe('Gastos «por pagar» — cableado HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    create: jest.fn(),
    update: jest.fn(),
    list: jest.fn(),
    assertOwnEnVentana: jest.fn(),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;

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
        authId: 'auth-1',
        nombre: 'Luis Piloto',
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
    svc.create.mockResolvedValue({ id: GASTO });
    svc.update.mockResolvedValue({ id: GASTO });
    svc.list.mockResolvedValue({ data: [], count: 0, limit: 50, offset: 0 });
    svc.assertOwnEnVentana.mockResolvedValue(undefined);
  });

  describe('POST /v1/expenses', () => {
    it('`por_pagar: true` llega como booleano', async () => {
      const res = await request(http())
        .post('/v1/expenses')
        .send(alta({ por_pagar: true }));
      expect(res.status).toBe(201);
      const dto = llamadas(svc.create)[0][0] as { por_pagar?: unknown };
      expect(dto.por_pagar).toBe(true);
    });

    it('el TEXTO «false» ⇒ 400 (enableImplicitConversion lo volvería true)', async () => {
      for (const v of ['false', 'true', 0, 1]) {
        const res = await request(http())
          .post('/v1/expenses')
          .send(alta({ por_pagar: v }));
        expect(res.status).toBe(400);
        expect(JSON.stringify((res.body as CuerpoError).message)).toContain(
          'por_pagar debe ser true o false',
        );
      }
      expect(svc.create).not.toHaveBeenCalled();
    });

    it('`null` = ausente (pasa la validación)', async () => {
      const res = await request(http())
        .post('/v1/expenses')
        .send(alta({ por_pagar: null }));
      expect(res.status).toBe(201);
      const dto = llamadas(svc.create)[0][0] as { por_pagar?: unknown };
      expect(dto.por_pagar ?? null).toBeNull();
    });

    it('PILOTO también lo manda (no es campo de oficina)', async () => {
      rol = Rol.PILOTO;
      const res = await request(http())
        .post('/v1/expenses')
        .send(alta({ por_pagar: true }));
      expect(res.status).toBe(201);
      expect(
        (llamadas(svc.create)[0][0] as { por_pagar?: unknown }).por_pagar,
      ).toBe(true);
      expect(llamadas(svc.create)[0][2]).toBe(Rol.PILOTO);
    });
  });

  describe('PATCH /v1/expenses/:id', () => {
    const patch = (cuerpo: Record<string, unknown>) =>
      request(http()).patch(`/v1/expenses/${GASTO}`).send(cuerpo);

    it('el TEXTO «false» ⇒ 400 sin llegar al servicio', async () => {
      rol = Rol.PILOTO;
      const res = await patch({ por_pagar: 'false' });
      expect(res.status).toBe(400);
      expect(svc.assertOwnEnVentana).not.toHaveBeenCalled();
      expect(svc.update).not.toHaveBeenCalled();
    });

    it('dueño de campo: el PATCH MÍNIMO de marcar pagado pide la excepción de ventana', async () => {
      rol = Rol.PILOTO;
      expect((await patch({ por_pagar: false })).status).toBe(200);
      // `porPagar` (revisión P7): el candado de reposición distingue un
      // PATCH que marca pagado (mínimo o no) de uno que lo deja por pagar.
      expect(svc.assertOwnEnVentana).toHaveBeenLastCalledWith(
        GASTO,
        'u-1',
        undefined,
        { marcarPagado: true, fechaPago: null, porPagar: false },
      );
      const sello = '2026-10-19T10:00:00-05:00';
      expect(
        (
          await patch({
            por_pagar: false,
            fecha_gasto: '2026-10-18',
            if_updated_at: '2026-10-05T15:00:00.000Z',
            capturado_en: sello,
          })
        ).status,
      ).toBe(200);
      expect(svc.assertOwnEnVentana).toHaveBeenLastCalledWith(
        GASTO,
        'u-1',
        sello,
        { marcarPagado: true, fechaPago: '2026-10-18', porPagar: false },
      );
      expect(
        (llamadas(svc.update)[1][1] as { por_pagar?: unknown }).por_pagar,
      ).toBe(false);
    });

    it('marcar pagado con OTRAS llaves: sin la excepción pero con `porPagar: false` para el candado de reposición', async () => {
      rol = Rol.PILOTO;
      expect((await patch({ por_pagar: false, notas: 'pagado' })).status).toBe(
        200,
      );
      expect(svc.assertOwnEnVentana).toHaveBeenLastCalledWith(
        GASTO,
        'u-1',
        undefined,
        { marcarPagado: false, fechaPago: null, porPagar: false },
      );
      expect((await patch({ notas: 'solo notas' })).status).toBe(200);
      expect(svc.assertOwnEnVentana).toHaveBeenLastCalledWith(
        GASTO,
        'u-1',
        undefined,
        { marcarPagado: false, fechaPago: null, porPagar: null },
      );
    });

    it('VISITANTE: el PATCH MÍNIMO no lleva `categoria` (no reescribe la de la oficina); otra corrección sí fija VISITA', async () => {
      rol = Rol.VISITANTE;
      expect((await patch({ por_pagar: false })).status).toBe(200);
      const minimo = llamadas(svc.update)[0][1] as Record<string, unknown>;
      expect(minimo.categoria).toBeUndefined();
      expect(minimo.por_pagar).toBe(false);
      expect((await patch({ por_pagar: false, notas: 'x' })).status).toBe(200);
      expect(
        (llamadas(svc.update)[1][1] as { categoria?: unknown }).categoria,
      ).toBe('VISITA');
    });

    it('cualquier otra llave ⇒ SIN la excepción (la ventana de siempre)', async () => {
      rol = Rol.PILOTO;
      for (const cuerpo of [
        { por_pagar: false, notas: 'pagado' },
        { por_pagar: false, monto: 400 },
        { notas: 'solo notas' },
        { por_pagar: true },
      ]) {
        expect((await patch(cuerpo)).status).toBe(200);
        expect(svc.assertOwnEnVentana).toHaveBeenLastCalledWith(
          GASTO,
          'u-1',
          undefined,
          expect.objectContaining({ marcarPagado: false }),
        );
      }
    });

    it('oficina no pasa por la ventana', async () => {
      rol = Rol.ADMIN;
      expect((await patch({ por_pagar: false })).status).toBe(200);
      expect(svc.assertOwnEnVentana).not.toHaveBeenCalled();
      expect(svc.update).toHaveBeenCalledWith(
        GASTO,
        expect.objectContaining({ por_pagar: false }),
        'u-1',
        Rol.ADMIN,
      );
    });
  });

  describe('GET /v1/expenses?por_pagar=', () => {
    it.each([
      ['1', true],
      ['true', true],
      ['0', false],
      ['false', false],
    ])('?por_pagar=%s ⇒ %s', async (v, esperado) => {
      const res = await request(http()).get(`/v1/expenses?por_pagar=${v}`);
      expect(res.status).toBe(200);
      expect(
        (llamadas(svc.list)[0][0] as { por_pagar?: unknown }).por_pagar,
      ).toBe(esperado);
    });

    it('otro texto ⇒ 400', async () => {
      const res = await request(http()).get('/v1/expenses?por_pagar=si');
      expect(res.status).toBe(400);
      expect(svc.list).not.toHaveBeenCalled();
    });

    it('el PILOTO también filtra (sobre SUS capturas)', async () => {
      rol = Rol.PILOTO;
      const res = await request(http()).get('/v1/expenses?por_pagar=1');
      expect(res.status).toBe(200);
      expect(llamadas(svc.list)[0][0]).toMatchObject({
        por_pagar: true,
        usuario_captura_id: 'u-1',
      });
    });
  });
});
