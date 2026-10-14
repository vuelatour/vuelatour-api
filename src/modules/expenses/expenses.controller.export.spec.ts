// Los servicios reales arrastran BD, pyservices e IA: se stubbean; aquí se
// prueba el CABLEADO HTTP del Excel de gastos (13-oct-2026, invariante 71):
// el ROL decide si el libro trae el detalle del banco.
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

describe('GET /v1/expenses/export — detalle del banco por rol', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    listXlsx: jest.fn().mockResolvedValue(Buffer.from('xlsx')),
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

  const ruta = '/v1/expenses/export?desde=2026-09-01&hasta=2026-09-30';

  it('ADMIN y FACTURACION ⇒ detalleBanco true; COORDINADOR y ANALISTA ⇒ false (el libro de siempre)', async () => {
    for (const [r, detalle] of [
      [Rol.ADMIN, true],
      [Rol.FACTURACION, true],
      [Rol.COORDINADOR, false],
      [Rol.ANALISTA, false],
    ] as const) {
      rol = r;
      const res = await request(http()).get(ruta);
      expect(res.status).toBe(200);
      expect(svc.listXlsx).toHaveBeenLastCalledWith(
        expect.objectContaining({ desde: '2026-09-01', hasta: '2026-09-30' }),
        { detalleBanco: detalle },
      );
    }
  }, 20_000);

  it('PILOTO ⇒ 403 sin llamar al servicio', async () => {
    rol = Rol.PILOTO;
    expect((await request(http()).get(ruta)).status).toBe(403);
    expect(svc.listXlsx).not.toHaveBeenCalled();
  });

  it('cabeceras sin cambio: el mismo archivo gastos.xlsx', async () => {
    const res = await request(http()).get(ruta);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="gastos.xlsx"',
    );
    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });
});
