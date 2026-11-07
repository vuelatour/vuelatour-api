/**
 * NÓMINA Y GASTOS PERSONALES SOLO DE DIRECCIÓN (6-nov-2026, invariante 122).
 * Administración (ADMIN) no lista ni exporta las categorías NOMINA y
 * PERSONAL_DUENO (sus módulos no los ve); el resto de categorías y el resto
 * de roles siguen como antes. HTTP real: ValidationPipe, filtro y RolesGuard.
 */
// Los servicios se simulan: importarlos arrastra dependencias ESM (jose).
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
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import {
  CODIGO_CATEGORIA_SOLO_DIRECCION,
  MENSAJE_CATEGORIA_SOLO_DIRECCION,
} from '../../common/roles.util';
import { Rol } from '../../common/types/auth.types';
import { CombustibleMasivoService } from './combustible-masivo.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

type Servidor = Parameters<typeof request>[0];
type Cuerpo = { code?: string; message?: string };

describe('ExpensesController — categorías solo de Dirección', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    list: jest.fn(),
    listXlsx: jest.fn(),
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
      (req as unknown as { user: unknown }).user = { userId: 'u-1', rol };
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
    svc.list.mockReset();
    svc.listXlsx.mockReset();
    svc.list.mockResolvedValue({ data: [], count: 0, limit: 50, offset: 0 });
    svc.listXlsx.mockResolvedValue(Buffer.from('xlsx'));
  });

  it('Administración: NOMINA y PERSONAL_DUENO ⇒ 403 CATEGORIA_SOLO_DIRECCION sin tocar el servicio', async () => {
    for (const cat of ['NOMINA', 'PERSONAL_DUENO']) {
      const lista = await request(http()).get(`/v1/expenses?categoria=${cat}`);
      expect(lista.status).toBe(403);
      expect((lista.body as Cuerpo).code).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
      expect((lista.body as Cuerpo).message).toBe(
        MENSAJE_CATEGORIA_SOLO_DIRECCION,
      );
      const excel = await request(http()).get(
        `/v1/expenses/export?categoria=${cat}`,
      );
      expect(excel.status).toBe(403);
      expect((excel.body as Cuerpo).code).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
    }
    expect(svc.list).not.toHaveBeenCalled();
    expect(svc.listXlsx).not.toHaveBeenCalled();
  });

  it('Administración: las demás categorías y la lista sin categoría siguen abiertas', async () => {
    expect(
      (await request(http()).get('/v1/expenses?categoria=GAS')).status,
    ).toBe(200);
    expect((await request(http()).get('/v1/expenses')).status).toBe(200);
    expect(
      (await request(http()).get('/v1/expenses/export?categoria=GAS')).status,
    ).toBe(200);
    expect(svc.list).toHaveBeenCalledTimes(2);
    expect(svc.listXlsx).toHaveBeenCalledTimes(1);
  });

  it('Dirección, COORDINADOR y FACTURACION siguen leyendo la nómina', async () => {
    for (const r of [Rol.DIRECCION, Rol.COORDINADOR, Rol.FACTURACION]) {
      rol = r;
      const res = await request(http()).get('/v1/expenses?categoria=NOMINA');
      expect(res.status).toBe(200);
    }
    expect(svc.list).toHaveBeenCalledTimes(3);
  });

  it('el reparto de la NÓMINA (reparto-iguales) es de Dirección, COORDINADOR y FACTURACION; el masivo no cambia', () => {
    const roles = (metodo: string) =>
      Reflect.getMetadata(
        ROLES_KEY,
        Object.getOwnPropertyDescriptor(ExpensesController.prototype, metodo)!
          .value as object,
      ) as Rol[];
    expect(roles('repartoIguales')).toEqual([
      Rol.DIRECCION,
      Rol.COORDINADOR,
      Rol.FACTURACION,
    ]);
    expect(roles('repartoMasivo')).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
    ]);
  });
});
