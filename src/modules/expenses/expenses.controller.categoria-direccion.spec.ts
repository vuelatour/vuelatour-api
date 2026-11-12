/**
 * NÓMINA Y GASTOS PERSONALES SOLO DE DIRECCIÓN (6-nov-2026, invariante 122).
 * Administración (ADMIN) no lista ni exporta las categorías NOMINA y
 * PERSONAL_DUENO (sus módulos no los ve); el resto de categorías y el resto
 * de roles siguen como antes. HTTP real: ValidationPipe, filtro y RolesGuard.
 *
 * ACCESO POR PERSONA (12-nov-2026, invariantes 132 y 133): cada categoría
 * se le abre a quien de Administración tenga el acceso que da Dirección en
 * Configuración PARA ESA categoría (listas `acceso_nomina` y
 * `acceso_gastos_personales`). Son independientes: el acceso a Nómina no
 * abre los gastos personales ni al revés.
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
  MENSAJE_GASTOS_PERSONALES_SIN_ACCESO,
  MENSAJE_NOMINA_SIN_ACCESO,
} from '../../common/roles.util';
import { Rol } from '../../common/types/auth.types';
import { CombustibleMasivoService } from './combustible-masivo.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

type Servidor = Parameters<typeof request>[0];
type Cuerpo = { code?: string; message?: string };

const MARY = 'e0b26729-1f02-4dc0-9c1a-e7192e638478';
const G1 = '0f5e6659-2c39-40d0-89d5-3fbd8d98537d';
const N41 = '5a82eb4a-086c-4058-97bd-b2aacdc2e942';

const MENSAJES: Record<string, string> = {
  // A quien le falta el acceso se le dice a quién pedírselo y dónde.
  NOMINA: MENSAJE_NOMINA_SIN_ACCESO,
  PERSONAL_DUENO: MENSAJE_GASTOS_PERSONALES_SIN_ACCESO,
};

describe('ExpensesController — categorías solo de Dirección', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  /** Categorías cuyo acceso por persona tiene quien pide (por defecto, ninguna). */
  let accesos: string[] = [];
  const svc = {
    list: jest.fn(),
    listXlsx: jest.fn(),
    putRepartoIguales: jest.fn(),
    /**
     * ¿Dirección le dio el acceso por persona de ESA categoría? (listas
     * `acceso_nomina` y `acceso_gastos_personales`).
     */
    tieneAccesoACategoria: jest.fn(),
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
      (req as unknown as { user: unknown }).user = { userId: MARY, rol };
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
    // Por defecto NADIE de Administración tiene accesos (como el 0.0.136).
    accesos = [];
    svc.list.mockReset();
    svc.listXlsx.mockReset();
    svc.putRepartoIguales.mockReset();
    svc.tieneAccesoACategoria.mockReset();
    svc.list.mockResolvedValue({ data: [], count: 0, limit: 50, offset: 0 });
    svc.listXlsx.mockResolvedValue(Buffer.from('xlsx'));
    svc.putRepartoIguales.mockResolvedValue({ aplicados: 0, errores: 0 });
    svc.tieneAccesoACategoria.mockImplementation(
      (_userId: string, categoria: string) =>
        Promise.resolve(accesos.includes(categoria)),
    );
  });

  /** Lista y Excel de una categoría: los dos deben responder lo mismo. */
  async function pedir(categoria: string) {
    const lista = await request(http()).get(
      `/v1/expenses?categoria=${categoria}`,
    );
    const excel = await request(http()).get(
      `/v1/expenses/export?categoria=${categoria}`,
    );
    return { lista, excel };
  }

  it('Administración SIN accesos: NOMINA y PERSONAL_DUENO ⇒ 403 CATEGORIA_SOLO_DIRECCION sin tocar el servicio; cada una dice a quién pedirle SU acceso', async () => {
    for (const cat of ['NOMINA', 'PERSONAL_DUENO']) {
      const { lista, excel } = await pedir(cat);
      for (const r of [lista, excel]) {
        expect(r.status).toBe(403);
        expect((r.body as Cuerpo).code).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
        expect((r.body as Cuerpo).message).toBe(MENSAJES[cat]);
      }
    }
    expect(svc.list).not.toHaveBeenCalled();
    expect(svc.listXlsx).not.toHaveBeenCalled();
    expect(MENSAJE_NOMINA_SIN_ACCESO).toContain('Acceso a Nómina');
    expect(MENSAJE_GASTOS_PERSONALES_SIN_ACCESO).toContain(
      'Acceso a Gastos personales',
    );
  });

  it('Administración CON el acceso a Nómina (invariante 132): lista y exporta la NÓMINA; los gastos personales siguen vedados (es otra lista)', async () => {
    accesos = ['NOMINA'];
    const nomina = await pedir('NOMINA');
    expect(nomina.lista.status).toBe(200);
    expect(nomina.excel.status).toBe(200);
    expect(svc.list).toHaveBeenCalledTimes(1);
    expect(svc.listXlsx).toHaveBeenCalledTimes(1);
    // Se preguntó con QUIEN pide (permiso por persona) y por ESA categoría.
    expect(svc.tieneAccesoACategoria).toHaveBeenCalledTimes(2);
    expect(svc.tieneAccesoACategoria).toHaveBeenLastCalledWith(MARY, 'NOMINA');

    svc.tieneAccesoACategoria.mockClear();
    const personales = await pedir('PERSONAL_DUENO');
    for (const r of [personales.lista, personales.excel]) {
      expect(r.status).toBe(403);
      expect((r.body as Cuerpo).message).toBe(
        MENSAJE_GASTOS_PERSONALES_SIN_ACCESO,
      );
    }
    // Por los gastos personales se pregunta con SU categoría: la respuesta
    // de la lista de Nómina no sirve para ellos.
    expect(svc.tieneAccesoACategoria).toHaveBeenCalledTimes(2);
    expect(svc.tieneAccesoACategoria).toHaveBeenLastCalledWith(
      MARY,
      'PERSONAL_DUENO',
    );
    expect(svc.list).toHaveBeenCalledTimes(1);
    expect(svc.listXlsx).toHaveBeenCalledTimes(1);
  });

  it('Administración CON el acceso a Gastos personales (invariante 133): lista y exporta los gastos personales; la NÓMINA sigue vedada', async () => {
    accesos = ['PERSONAL_DUENO'];
    const personales = await pedir('PERSONAL_DUENO');
    expect(personales.lista.status).toBe(200);
    expect(personales.excel.status).toBe(200);
    expect(svc.list).toHaveBeenCalledTimes(1);
    expect(svc.listXlsx).toHaveBeenCalledTimes(1);
    expect(svc.tieneAccesoACategoria).toHaveBeenLastCalledWith(
      MARY,
      'PERSONAL_DUENO',
    );

    const nomina = await pedir('NOMINA');
    for (const r of [nomina.lista, nomina.excel]) {
      expect(r.status).toBe(403);
      expect((r.body as Cuerpo).code).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
      expect((r.body as Cuerpo).message).toBe(MENSAJE_NOMINA_SIN_ACCESO);
    }
    expect(svc.list).toHaveBeenCalledTimes(1);
    expect(svc.listXlsx).toHaveBeenCalledTimes(1);
  });

  it('Administración con los DOS accesos: las dos categorías', async () => {
    accesos = ['NOMINA', 'PERSONAL_DUENO'];
    for (const cat of ['NOMINA', 'PERSONAL_DUENO']) {
      const { lista, excel } = await pedir(cat);
      expect(lista.status).toBe(200);
      expect(excel.status).toBe(200);
    }
    expect(svc.list).toHaveBeenCalledTimes(2);
    expect(svc.listXlsx).toHaveBeenCalledTimes(2);
  });

  it('Administración: las demás categorías y la lista sin categoría siguen abiertas (sin consultar ningún acceso)', async () => {
    expect(
      (await request(http()).get('/v1/expenses?categoria=GAS')).status,
    ).toBe(200);
    expect((await request(http()).get('/v1/expenses')).status).toBe(200);
    expect(
      (await request(http()).get('/v1/expenses/export?categoria=GAS')).status,
    ).toBe(200);
    expect(svc.list).toHaveBeenCalledTimes(2);
    expect(svc.listXlsx).toHaveBeenCalledTimes(1);
    expect(svc.tieneAccesoACategoria).not.toHaveBeenCalled();
  });

  it('Dirección, COORDINADOR y FACTURACION siguen leyendo la nómina por su rol; Dirección y COORDINADOR, los gastos personales (sin consultar ningún acceso)', async () => {
    for (const r of [Rol.DIRECCION, Rol.COORDINADOR, Rol.FACTURACION]) {
      rol = r;
      const res = await request(http()).get('/v1/expenses?categoria=NOMINA');
      expect(res.status).toBe(200);
    }
    for (const r of [Rol.DIRECCION, Rol.COORDINADOR]) {
      rol = r;
      const res = await request(http()).get(
        '/v1/expenses?categoria=PERSONAL_DUENO',
      );
      expect(res.status).toBe(200);
    }
    expect(svc.list).toHaveBeenCalledTimes(5);
    expect(svc.tieneAccesoACategoria).not.toHaveBeenCalled();
  });

  it('reparto-iguales (el reparto de la NÓMINA): Administración solo con el acceso a NÓMINA; sin él (aunque tenga el de gastos personales) ⇒ 403 CATEGORIA_SOLO_DIRECCION sin tocar el servicio', async () => {
    const cuerpo = { gasto_ids: [G1], aeronave_ids: [N41] };
    const sin = await request(http())
      .post('/v1/expenses/reparto-iguales')
      .send(cuerpo);
    expect(sin.status).toBe(403);
    expect((sin.body as Cuerpo).code).toBe(CODIGO_CATEGORIA_SOLO_DIRECCION);
    expect((sin.body as Cuerpo).message).toBe(MENSAJE_NOMINA_SIN_ACCESO);
    expect(svc.putRepartoIguales).not.toHaveBeenCalled();

    accesos = ['PERSONAL_DUENO'];
    const soloPersonales = await request(http())
      .post('/v1/expenses/reparto-iguales')
      .send(cuerpo);
    expect(soloPersonales.status).toBe(403);
    expect((soloPersonales.body as Cuerpo).message).toBe(
      MENSAJE_NOMINA_SIN_ACCESO,
    );
    expect(svc.putRepartoIguales).not.toHaveBeenCalled();

    accesos = ['NOMINA'];
    const con = await request(http())
      .post('/v1/expenses/reparto-iguales')
      .send(cuerpo);
    expect(con.status).toBe(200);
    expect(svc.putRepartoIguales).toHaveBeenCalledWith(cuerpo, MARY);
    expect(svc.tieneAccesoACategoria).toHaveBeenLastCalledWith(MARY, 'NOMINA');
  });

  it('@Roles de reparto-iguales: Dirección, Administración (solo con el acceso, arriba), COORDINADOR y FACTURACION; el masivo no cambia', () => {
    const roles = (metodo: string) =>
      Reflect.getMetadata(
        ROLES_KEY,
        Object.getOwnPropertyDescriptor(ExpensesController.prototype, metodo)!
          .value as object,
      ) as Rol[];
    expect(roles('repartoIguales')).toEqual([
      Rol.DIRECCION,
      Rol.ADMIN,
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
