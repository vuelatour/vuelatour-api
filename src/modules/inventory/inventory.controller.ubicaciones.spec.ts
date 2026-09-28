// Cableado HTTP de ELIMINAR y REORDENAR ubicaciones (28-sep-2026, API
// 0.0.38): rutas literales ANTES de `ubicaciones/:id`, roles
// (ADMIN/MECANICO), DTO por el ValidationPipe real de main.ts y los códigos
// del service a través del filtro global. El service se stubbea (las reglas
// se prueban en inventory.service.ubicacion.spec y en el util).
jest.mock('./inventory.service', () => ({ InventoryService: class {} }));
jest.mock('./compras.service', () => ({ ComprasService: class {} }));
jest.mock('./inventario-masivo.service', () => ({
  InventarioMasivoService: class {},
}));

import {
  ConflictException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { ComprasService } from './compras.service';
import { InventarioMasivoService } from './inventario-masivo.service';

type Servidor = Parameters<typeof request>[0];
const VIEJA = 'f44cf63f-1698-413f-bdb0-6fdea076df5c';
const NUEVA = '9bd6de35-e063-4774-bc33-1f7dd2161bc5';
const USUARIO = 'c691cc8b-3034-4f04-a383-d0b25c1971ec';

const proto = InventoryController.prototype as unknown as Record<
  string,
  object
>;

describe('InventoryController — eliminar y reordenar ubicaciones', () => {
  it('PUT ubicaciones/orden se declara ANTES de ubicaciones/:id (convención del repo)', () => {
    const metodos = Object.getOwnPropertyNames(proto).filter(
      (m) => m !== 'constructor',
    );
    const rutas = metodos.map((m) => ({
      path: String(Reflect.getMetadata(PATH_METADATA, proto[m])),
      metodo: Reflect.getMetadata(METHOD_METADATA, proto[m]) as RequestMethod,
    }));
    const orden = rutas.findIndex(
      (r) => r.path === 'ubicaciones/orden' && r.metodo === RequestMethod.PUT,
    );
    const porId = rutas.findIndex((r) => r.path === 'ubicaciones/:id');
    const borrar = rutas.findIndex(
      (r) => r.path === 'ubicaciones/:id' && r.metodo === RequestMethod.DELETE,
    );
    expect(orden).toBeGreaterThanOrEqual(0);
    expect(borrar).toBeGreaterThanOrEqual(0);
    expect(orden).toBeLessThan(porId);
  });

  describe('por HTTP', () => {
    let app: INestApplication;
    let rol: Rol = Rol.ADMIN;
    const svc = {
      deleteUbicacion: jest.fn(),
      reordenarUbicaciones: jest.fn(),
      updateUbicacion: jest.fn(),
    };
    const http = (): Servidor => app.getHttpServer() as Servidor;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [InventoryController],
        providers: [
          { provide: InventoryService, useValue: svc },
          { provide: ComprasService, useValue: {} },
          { provide: InventarioMasivoService, useValue: {} },
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
          userId: USUARIO,
          nombre: 'Oficina',
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
      svc.deleteUbicacion.mockResolvedValue({
        deleted: true,
        id: VIEJA,
        nombre: 'Oficina vieja',
      });
      svc.reordenarUbicaciones.mockResolvedValue([]);
    });

    it('DELETE llega al service con el id; ADMIN y MECANICO sí, el resto 403', async () => {
      for (const r of [Rol.ADMIN, Rol.MECANICO]) {
        rol = r;
        const res = await request(http()).delete(
          `/v1/inventory/ubicaciones/${VIEJA}`,
        );
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          deleted: true,
          id: VIEJA,
          nombre: 'Oficina vieja',
        });
      }
      expect(svc.deleteUbicacion).toHaveBeenCalledWith(VIEJA);
      for (const r of [
        Rol.COORDINADOR,
        Rol.FACTURACION,
        Rol.ANALISTA,
        Rol.SOCIO,
        Rol.PILOTO,
        Rol.VISITANTE,
      ]) {
        rol = r;
        const res = await request(http()).delete(
          `/v1/inventory/ubicaciones/${VIEJA}`,
        );
        expect(res.status).toBe(403);
      }
    });

    it('DELETE con un id que no es uuid ⇒ 400 (no llega al service)', async () => {
      const res = await request(http()).delete(
        '/v1/inventory/ubicaciones/no-es-uuid',
      );
      expect(res.status).toBe(400);
      expect(svc.deleteUbicacion).not.toHaveBeenCalled();
    });

    it('el 409 UBICACION_EN_USO del service viaja con code y details (el panel decide por el code)', async () => {
      svc.deleteUbicacion.mockRejectedValueOnce(
        new ConflictException({
          message:
            '«Oficina nueva» tiene 1 producto: muévelo con «Mover a…» y vuelve a intentar.',
          error: 'UBICACION_EN_USO',
          details: { productos: 1, productos_activos: 1 },
        }),
      );
      const res = await request(http()).delete(
        `/v1/inventory/ubicaciones/${NUEVA}`,
      );
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'UBICACION_EN_USO',
        message:
          '«Oficina nueva» tiene 1 producto: muévelo con «Mover a…» y vuelve a intentar.',
        details: { productos: 1, productos_activos: 1 },
      });
    });

    it('PUT orden va a reordenar (no a PATCH :id) con los ids y quién ordena', async () => {
      const res = await request(http())
        .put('/v1/inventory/ubicaciones/orden')
        .send({ ids: [NUEVA, VIEJA] });
      expect(res.status).toBe(200);
      expect(svc.reordenarUbicaciones).toHaveBeenCalledWith(
        [NUEVA, VIEJA],
        USUARIO,
      );
      expect(svc.updateUbicacion).not.toHaveBeenCalled();
      rol = Rol.MECANICO;
      expect(
        (
          await request(http())
            .put('/v1/inventory/ubicaciones/orden')
            .send({ ids: [VIEJA] })
        ).status,
      ).toBe(200);
      rol = Rol.COORDINADOR;
      expect(
        (
          await request(http())
            .put('/v1/inventory/ubicaciones/orden')
            .send({ ids: [VIEJA] })
        ).status,
      ).toBe(403);
    });

    it('PUT orden: vacío, repetido, no-uuid o campo extra ⇒ 400 sin llegar al service', async () => {
      for (const body of [
        { ids: [] },
        { ids: [VIEJA, VIEJA] },
        { ids: ['x'] },
        { ids: [VIEJA], extra: 1 },
        {},
      ]) {
        const res = await request(http())
          .put('/v1/inventory/ubicaciones/orden')
          .send(body);
        expect(res.status).toBe(400);
      }
      expect(svc.reordenarUbicaciones).not.toHaveBeenCalled();
    });
  });
});
