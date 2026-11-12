// Cableado HTTP de «Acceso a Nómina» (invariante 132) y «Acceso a Gastos
// personales» (invariante 133), 12-nov-2026: rutas literales ANTES de
// ':clave', roles (Administración lee; SOLO Dirección cambia), DTO por el
// ValidationPipe real de main.ts y los códigos del service a través del
// filtro global. El service se stubbea (sus candados se prueban en
// `configuracion.acceso-nomina.spec` y
// `configuracion.acceso-gastos-personales.spec`). Las dos rutas comparten
// contrato: los MISMOS casos corren contra cada una, y además se comprueba
// que cada ruta llama a SU método (nunca al de la otra lista).
jest.mock('./configuracion.service', () => ({
  ConfiguracionService: class {},
}));
jest.mock('../ia-uso/ia-uso.service', () => ({ IaUsoService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import {
  BadRequestException,
  ConflictException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { ConfiguracionController } from './configuracion.controller';
import { ConfiguracionService } from './configuracion.service';
import { IaUsoService } from '../ia-uso/ia-uso.service';
import { PyservicesService } from '../pyservices/pyservices.service';

type Servidor = Parameters<typeof request>[0];
const ALE = 'c691cc8b-3034-4f04-a383-d0b25c1971ec';
const MARY = 'e0b26729-1f02-4dc0-9c1a-e7192e638478';
const SELLO = '2026-11-12T15:00:00.123+00:00';

type MetodoGet = 'accesoNomina' | 'accesoGastosPersonales';
type MetodoPut = 'setAccesoNomina' | 'setAccesoGastosPersonales';

interface Lista {
  nombre: string;
  /** Segmento de la ruta bajo `/v1/config/`. */
  segmento: string;
  get: MetodoGet;
  put: MetodoPut;
  /** Los métodos de la OTRA lista: esta ruta jamás debe llamarlos. */
  otroGet: MetodoGet;
  otroPut: MetodoPut;
  codigoCambio: string;
}

const LISTAS: Lista[] = [
  {
    nombre: 'Nómina',
    segmento: 'acceso-nomina',
    get: 'accesoNomina',
    put: 'setAccesoNomina',
    otroGet: 'accesoGastosPersonales',
    otroPut: 'setAccesoGastosPersonales',
    codigoCambio: 'ACCESO_NOMINA_CAMBIO',
  },
  {
    nombre: 'Gastos personales',
    segmento: 'acceso-gastos-personales',
    get: 'accesoGastosPersonales',
    put: 'setAccesoGastosPersonales',
    otroGet: 'accesoNomina',
    otroPut: 'setAccesoNomina',
    codigoCambio: 'ACCESO_GASTOS_PERSONALES_CAMBIO',
  },
];

const proto = ConfiguracionController.prototype as unknown as Record<
  string,
  object
>;

describe.each(LISTAS)(
  'ConfiguracionController — acceso a $nombre por persona',
  (lista) => {
    const RUTA = `/v1/config/${lista.segmento}`;

    it('rutas literales declaradas ANTES de `:clave` (convención del repo)', () => {
      const metodos = Object.getOwnPropertyNames(proto).filter(
        (m) => m !== 'constructor',
      );
      const rutas = metodos.map((m) =>
        String(Reflect.getMetadata(PATH_METADATA, proto[m])),
      );
      const i = rutas.indexOf(lista.segmento);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(rutas.lastIndexOf(lista.segmento)).toBeLessThan(
        rutas.indexOf(':clave'),
      );
      expect(rutas.filter((r) => r === lista.segmento)).toHaveLength(2);
    });

    describe('por HTTP', () => {
      let app: INestApplication;
      let rol: Rol = Rol.DIRECCION;
      let userId = ALE;
      const respuesta = {
        usuario_ids: [MARY],
        usuarios: [{ id: MARY, nombre: 'Mary Cruz' }],
        candidatos: [{ id: MARY, nombre: 'Mary Cruz', rol: 'ADMIN' }],
        por_rol: [{ id: ALE, nombre: 'Alejandro Canales', rol: 'DIRECCION' }],
        puede_modificar: true,
        version: SELLO,
        actualizado_at: SELLO,
        actualizado_por_nombre: 'Alejandro Canales',
      };
      const svc = {
        accesoNomina: jest.fn().mockResolvedValue(respuesta),
        setAccesoNomina: jest.fn().mockResolvedValue(respuesta),
        accesoGastosPersonales: jest.fn().mockResolvedValue(respuesta),
        setAccesoGastosPersonales: jest.fn().mockResolvedValue(respuesta),
        update: jest.fn(),
      };
      const http = (): Servidor => app.getHttpServer() as Servidor;

      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          controllers: [ConfiguracionController],
          providers: [
            { provide: ConfiguracionService, useValue: svc },
            { provide: IaUsoService, useValue: {} },
            { provide: PyservicesService, useValue: {} },
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
            userId,
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
        rol = Rol.DIRECCION;
        userId = ALE;
        jest.clearAllMocks();
      });

      afterEach(() => {
        // Cada ruta habla con SU lista: jamás con la de la otra tarjeta, ni
        // con el PATCH genérico de `:clave`.
        expect(svc[lista.otroGet]).not.toHaveBeenCalled();
        expect(svc[lista.otroPut]).not.toHaveBeenCalled();
        expect(svc.update).not.toHaveBeenCalled();
      });

      it('GET llega al service con quién consulta y su rol (no a `:clave`)', async () => {
        const r = await request(http()).get(RUTA);
        expect(r.status).toBe(200);
        expect(r.body).toEqual(respuesta);
        expect(svc[lista.get]).toHaveBeenCalledWith({
          userId: ALE,
          rol: Rol.DIRECCION,
        });
        rol = Rol.ADMIN;
        userId = MARY;
        expect((await request(http()).get(RUTA)).status).toBe(200);
        expect(svc[lista.get]).toHaveBeenLastCalledWith({
          userId: MARY,
          rol: Rol.ADMIN,
        });
      });

      it('la LEEN Dirección y Administración; los demás roles ⇒ 403', async () => {
        for (const r of [
          Rol.COORDINADOR,
          Rol.FACTURACION,
          Rol.ANALISTA,
          Rol.PILOTO,
          Rol.MECANICO,
          Rol.SOCIO,
          Rol.VISITANTE,
        ]) {
          rol = r;
          expect((await request(http()).get(RUTA)).status).toBe(403);
        }
        expect(svc[lista.get]).not.toHaveBeenCalled();
      });

      it('PUT: SOLO Dirección llega al service, con los ids, quién cambia y el sello de la pantalla', async () => {
        const ok = await request(http())
          .put(RUTA)
          .send({ usuario_ids: [MARY], version: SELLO });
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual(respuesta);
        expect(svc[lista.put]).toHaveBeenCalledWith(
          [MARY],
          { userId: ALE, rol: Rol.DIRECCION },
          SELLO,
        );
        // `version: null` = la pantalla vio que nunca se había guardado.
        await request(http())
          .put(RUTA)
          .send({ usuario_ids: [], version: null });
        expect(svc[lista.put]).toHaveBeenLastCalledWith(
          [],
          { userId: ALE, rol: Rol.DIRECCION },
          null,
        );
        // Sin `version`: sin comprobación de pantalla (undefined).
        await request(http())
          .put(RUTA)
          .send({ usuario_ids: [MARY] });
        expect(svc[lista.put]).toHaveBeenLastCalledWith(
          [MARY],
          { userId: ALE, rol: Rol.DIRECCION },
          undefined,
        );
      });

      it('Administración (aunque esté en la lista) y los demás roles NO llegan al PUT: 403 por rol', async () => {
        for (const r of [
          Rol.ADMIN,
          Rol.COORDINADOR,
          Rol.FACTURACION,
          Rol.ANALISTA,
          Rol.PILOTO,
          Rol.SOCIO,
        ]) {
          rol = r;
          userId = MARY;
          const res = await request(http())
            .put(RUTA)
            .send({ usuario_ids: [MARY], version: SELLO });
          expect(res.status).toBe(403);
        }
        expect(svc[lista.put]).not.toHaveBeenCalled();
      });

      it('los códigos del service viajan: 400 USUARIOS_INVALIDOS y el 409 del guardado desde una pantalla vieja', async () => {
        svc[lista.put].mockRejectedValueOnce(
          new BadRequestException({
            message: `Solo se le puede dar acceso a ${lista.nombre} a…`,
            error: 'USUARIOS_INVALIDOS',
            details: { ids: [ALE] },
          }),
        );
        const invalido = await request(http())
          .put(RUTA)
          .send({ usuario_ids: [ALE], version: SELLO });
        expect(invalido.status).toBe(400);
        expect((invalido.body as { code?: string }).code).toBe(
          'USUARIOS_INVALIDOS',
        );
        svc[lista.put].mockRejectedValueOnce(
          new ConflictException({
            message: `Alguien más cambió quién entra a ${lista.nombre}…`,
            error: lista.codigoCambio,
          }),
        );
        const viejo = await request(http())
          .put(RUTA)
          .send({ usuario_ids: [MARY], version: SELLO });
        expect(viejo.status).toBe(409);
        expect((viejo.body as { code?: string }).code).toBe(lista.codigoCambio);
      });

      it('DTO: id que no es uuid, sin arreglo, sello que no es texto o campo extra ⇒ 400 sin llegar al service', async () => {
        for (const body of [
          { usuario_ids: ['Mary'] },
          { usuario_ids: MARY },
          { usuario_ids: [MARY], version: 42 },
          { usuario_ids: [MARY], version: 'x'.repeat(65) },
          { usuario_ids: [MARY], extra: true },
          { usuario_ids: Array.from({ length: 51 }, () => MARY) },
          {},
        ]) {
          expect((await request(http()).put(RUTA).send(body)).status).toBe(400);
        }
        expect(svc[lista.put]).not.toHaveBeenCalled();
      });
    });
  },
);
