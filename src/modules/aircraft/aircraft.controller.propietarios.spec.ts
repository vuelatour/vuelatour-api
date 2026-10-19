// PROPIETARIOS DEL AVIÓN por HTTP (19-oct-2026, API 0.0.97, invariante 95):
// el cableado del controlador con el ValidationPipe REAL de main.ts.
//  - DELETE owners/:id ⇒ closeOwner(id, hasta | undefined, userId);
//    ?permanente=true ⇒ deleteOwner(id).
//  - PATCH owners/:id acepta socio_id, vigente_desde y vigente_hasta: null
//    (antes el DTO los rechazaba con 400 «should not exist» y el panel
//    nunca pudo editar un propietario).
//  - POST :id/owners acepta sustituye_a (uuids).
jest.mock('./aircraft.service', () => ({ AircraftService: class {} }));
jest.mock('./aircraft-balance.service', () => ({
  AircraftBalanceService: class {},
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
import { AircraftBalanceService } from './aircraft-balance.service';
import { AircraftController } from './aircraft.controller';
import { AircraftService } from './aircraft.service';

type Servidor = Parameters<typeof request>[0];
const AVION = 'eeeeeeee-0000-4000-8000-000000000001';
const OWNER = 'eeeeeeee-0000-4000-8000-000000000002';
const SOCIO = 'eeeeeeee-0000-4000-8000-000000000003';

describe('AircraftController — propietarios por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const aircraft = {
    closeOwner: jest.fn().mockResolvedValue({ id: OWNER }),
    deleteOwner: jest.fn().mockResolvedValue({ ok: true }),
    updateOwner: jest.fn().mockResolvedValue({ id: OWNER }),
    createOwner: jest.fn().mockResolvedValue({ id: 'nuevo', sustituidos: [] }),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AircraftController],
      providers: [
        { provide: AircraftService, useValue: aircraft },
        { provide: AircraftBalanceService, useValue: {} },
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

  describe('DELETE owners/:id', () => {
    it('sin query ⇒ cierra con hasta = undefined (el servicio pone hoy Cancún)', async () => {
      const r = await request(http()).delete(`/v1/aircraft/owners/${OWNER}`);
      expect(r.status).toBe(200);
      expect(aircraft.closeOwner).toHaveBeenCalledWith(OWNER, undefined, 'u-1');
      expect(aircraft.deleteOwner).not.toHaveBeenCalled();
    });

    it('?hasta=2026-08-17 ⇒ ese último día; ?hasta= vacío ⇒ undefined', async () => {
      await request(http()).delete(
        `/v1/aircraft/owners/${OWNER}?hasta=2026-08-17`,
      );
      expect(aircraft.closeOwner).toHaveBeenCalledWith(
        OWNER,
        '2026-08-17',
        'u-1',
      );
      await request(http()).delete(`/v1/aircraft/owners/${OWNER}?hasta=`);
      expect(aircraft.closeOwner).toHaveBeenLastCalledWith(
        OWNER,
        undefined,
        'u-1',
      );
    });

    it('?permanente=true ⇒ borra la fila (y no cierra); false ⇒ cierra', async () => {
      const r = await request(http()).delete(
        `/v1/aircraft/owners/${OWNER}?permanente=true`,
      );
      expect(r.status).toBe(200);
      expect(aircraft.deleteOwner).toHaveBeenCalledWith(OWNER);
      expect(aircraft.closeOwner).not.toHaveBeenCalled();
      await request(http()).delete(
        `/v1/aircraft/owners/${OWNER}?permanente=false&hasta=2026-08-17`,
      );
      expect(aircraft.closeOwner).toHaveBeenCalledWith(
        OWNER,
        '2026-08-17',
        'u-1',
      );
      expect(aircraft.deleteOwner).toHaveBeenCalledTimes(1);
    });

    it('solo ADMIN', async () => {
      rol = Rol.COORDINADOR;
      expect(
        (await request(http()).delete(`/v1/aircraft/owners/${OWNER}`)).status,
      ).toBe(403);
      expect(aircraft.closeOwner).not.toHaveBeenCalled();
    });
  });

  describe('PATCH owners/:id', () => {
    it('acepta socio_id y vigente_desde (el DTO viejo respondía 400 «should not exist»)', async () => {
      const r = await request(http())
        .patch(`/v1/aircraft/owners/${OWNER}`)
        .send({ socio_id: SOCIO, vigente_desde: '2026-08-18', porcentaje: 70 });
      expect(r.status).toBe(200);
      const dto = (aircraft.updateOwner.mock.calls as unknown[][])[0][1] as {
        socio_id: string;
        vigente_desde: Date;
        porcentaje: number;
      };
      expect(dto.socio_id).toBe(SOCIO);
      expect(dto.vigente_desde).toBeInstanceOf(Date);
      expect(dto.vigente_desde.toISOString().slice(0, 10)).toBe('2026-08-18');
      expect(dto.porcentaje).toBe(70);
    });

    it('vigente_hasta: null llega como null (reabrir), no como fecha inválida', async () => {
      const r = await request(http())
        .patch(`/v1/aircraft/owners/${OWNER}`)
        .send({ vigente_hasta: null });
      expect(r.status).toBe(200);
      const dto = (aircraft.updateOwner.mock.calls as unknown[][])[0][1] as {
        vigente_hasta: unknown;
      };
      expect(dto.vigente_hasta).toBeNull();
      expect('vigente_hasta' in dto).toBe(true);
    });

    it('una llave desconocida sigue siendo 400', async () => {
      const r = await request(http())
        .patch(`/v1/aircraft/owners/${OWNER}`)
        .send({ porcentaje: 10, otra: 1 });
      expect(r.status).toBe(400);
      expect(aircraft.updateOwner).not.toHaveBeenCalled();
    });
  });

  describe('POST :id/owners', () => {
    it('acepta sustituye_a con uuids y rechaza basura', async () => {
      const ok = await request(http())
        .post(`/v1/aircraft/${AVION}/owners`)
        .send({
          socio_id: SOCIO,
          porcentaje: 100,
          vigente_desde: '2026-08-18',
          sustituye_a: [OWNER],
        });
      expect(ok.status).toBe(201);
      const dto = (aircraft.createOwner.mock.calls as unknown[][])[0][1] as {
        sustituye_a: string[];
      };
      expect(dto.sustituye_a).toEqual([OWNER]);
      const mal = await request(http())
        .post(`/v1/aircraft/${AVION}/owners`)
        .send({
          socio_id: SOCIO,
          porcentaje: 100,
          vigente_desde: '2026-08-18',
          sustituye_a: ['no-es-uuid'],
        });
      expect(mal.status).toBe(400);
      expect(aircraft.createOwner).toHaveBeenCalledTimes(1);
    });
  });
});
