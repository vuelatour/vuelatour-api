// Cableado HTTP REAL de componentes y archivos de ingeniería (17-nov-2026,
// API 0.0.140, invariante 135): ValidationPipe de main.ts +
// AllExceptionsFilter + versionado URI + RolesGuard. Los servicios se
// stubbean (sus reglas tienen sus propios specs).
jest.mock('./engineering.service', () => ({ EngineeringService: class {} }));
jest.mock('./componentes.service', () => ({ ComponentesService: class {} }));
jest.mock('./adjuntos-ingenieria.service', () => ({
  AdjuntosIngenieriaService: class {},
}));

import {
  ConflictException,
  Logger,
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
import { AdjuntosIngenieriaService } from './adjuntos-ingenieria.service';
import { ComponentesService } from './componentes.service';
import {
  EngineeringController,
  ROLES_INGENIERIA_CON_MECANICO,
} from './engineering.controller';
import { EngineeringService } from './engineering.service';

const USER = 'cccccccc-0000-4000-8000-0000000000a1';
const AVION = 'aaaaaaaa-0000-4000-8000-000000000001';
const COMP = 'bbbbbbbb-0000-4000-8000-000000000011';
const ADJ = 'dddddddd-0000-4000-8000-000000000021';
const MANT = 'eeeeeeee-0000-4000-8000-000000000031';
type Servidor = Parameters<typeof request>[0];

const OFICINA = [Rol.ADMIN, Rol.COORDINADOR];
const CON_MECANICO = [Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO];
const SIN_ACCESO = [Rol.PILOTO, Rol.SOCIO, Rol.ANALISTA, Rol.FACTURACION];

describe('EngineeringController — @Roles de componentes y archivos (invariante 135)', () => {
  const proto = EngineeringController.prototype as unknown as Record<
    string,
    object
  >;

  it('el default del controlador sigue siendo ADMIN + COORDINADOR', () => {
    expect(Reflect.getMetadata(ROLES_KEY, EngineeringController)).toEqual(
      OFICINA,
    );
    expect([...ROLES_INGENIERIA_CON_MECANICO]).toEqual(CON_MECANICO);
  });

  it.each([
    'listComponents',
    'createComponent',
    'updateComponent',
    'replaceComponent',
    'retireComponent',
    'listAdjuntos',
    'adjuntoUrl',
  ])('%s: oficina + MECANICO', (metodo) => {
    expect(Reflect.getMetadata(ROLES_KEY, proto[metodo])).toEqual(CON_MECANICO);
  });

  it.each(['deleteComponent', 'createAdjunto', 'deleteAdjunto'])(
    '%s: sin @Roles propio ⇒ hereda el default (solo oficina)',
    (metodo) => {
      expect(Reflect.getMetadata(ROLES_KEY, proto[metodo])).toBeUndefined();
    },
  );
});

describe('EngineeringController por HTTP — componentes y archivos', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const componentes = {
    listar: jest.fn(),
    crear: jest.fn(),
    editar: jest.fn(),
    reemplazar: jest.fn(),
    retirar: jest.fn(),
    eliminar: jest.fn(),
  };
  const adjuntos = {
    listarDeAeronave: jest.fn(),
    registrar: jest.fn(),
    url: jest.fn(),
    eliminar: jest.fn(),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EngineeringController],
      providers: [
        { provide: EngineeringService, useValue: {} },
        { provide: ComponentesService, useValue: componentes },
        { provide: AdjuntosIngenieriaService, useValue: adjuntos },
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
        userId: USER,
        rol,
        nombre: 'Itzi',
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
    for (const f of [
      ...Object.values(componentes),
      ...Object.values(adjuntos),
    ]) {
      f.mockReset().mockResolvedValue({ ok: true });
    }
  });

  /** Estado HTTP de una petición con cada rol de la lista. */
  async function estados(
    roles: Rol[],
    pedir: () => request.Test,
  ): Promise<number[]> {
    const out: number[] = [];
    for (const r of roles) {
      rol = r;
      out.push((await pedir()).status);
    }
    return out;
  }

  describe('componentes', () => {
    it('GET aircraft/:id/components: oficina, MECANICO y DIRECCION (200); los demás 403', async () => {
      const pedir = () =>
        request(http()).get(`/v1/engineering/aircraft/${AVION}/components`);
      expect(await estados([...CON_MECANICO, Rol.DIRECCION], pedir)).toEqual([
        200, 200, 200, 200,
      ]);
      expect(componentes.listar).toHaveBeenLastCalledWith(AVION);
      expect(await estados(SIN_ACCESO, pedir)).toEqual([403, 403, 403, 403]);
    });

    it('GET con un id que no es uuid ⇒ 400 sin llamar al servicio', async () => {
      const res = await request(http()).get(
        '/v1/engineering/aircraft/no-es-uuid/components',
      );
      expect(res.status).toBe(400);
      expect(componentes.listar).not.toHaveBeenCalled();
    });

    it('POST aircraft/:id/components: 201 con el userId; el nombre llega RECORTADO', async () => {
      const res = await request(http())
        .post(`/v1/engineering/aircraft/${AVION}/components`)
        .send({
          nombre: '  Llanta principal izquierda  ',
          categoria: 'Tren de aterrizaje',
          fecha_instalacion: '2026-11-01',
          horas_aeronave_instalacion: 5590.5,
          limite_horas: 500,
          limite_meses: 24,
          aviso_dias: 45,
        });
      expect(res.status).toBe(201);
      expect(componentes.crear).toHaveBeenCalledWith(
        AVION,
        {
          nombre: 'Llanta principal izquierda',
          categoria: 'Tren de aterrizaje',
          fecha_instalacion: '2026-11-01',
          horas_aeronave_instalacion: 5590.5,
          limite_horas: 500,
          limite_meses: 24,
          aviso_dias: 45,
        },
        USER,
      );
      // El mecánico también captura; el piloto no.
      const pedir = () =>
        request(http())
          .post(`/v1/engineering/aircraft/${AVION}/components`)
          .send({ nombre: 'Extintor' });
      expect(await estados([Rol.MECANICO, Rol.PILOTO], pedir)).toEqual([
        201, 403,
      ]);
    });

    it('POST: cuerpo ESTRICTO ⇒ 400 sin llamar al servicio', async () => {
      for (const body of [
        {},
        { nombre: 'a' }, // 1 letra
        { nombre: '   a   ' }, // 1 letra tras recortar
        { nombre: 'x'.repeat(121) },
        { nombre: 'Llanta', limite_horas: 0 },
        { nombre: 'Llanta', limite_horas: -5 },
        { nombre: 'Llanta', limite_meses: 0 },
        { nombre: 'Llanta', limite_meses: 601 },
        { nombre: 'Llanta', limite_meses: 1.5 },
        { nombre: 'Llanta', horas_previas: -1 },
        { nombre: 'Llanta', horas_aeronave_instalacion: 1.234 },
        { nombre: 'Llanta', aviso_dias: -1 },
        { nombre: 'Llanta', fecha_instalacion: '17/11/2026' },
        { nombre: 'Llanta', fecha_vencimiento: '2026-11-17T10:00:00Z' },
        { nombre: 'Llanta', estado: 'RETIRADO' }, // no es del DTO
        { nombre: 'Llanta', aeronave_id: AVION }, // no es del DTO
      ]) {
        const res = await request(http())
          .post(`/v1/engineering/aircraft/${AVION}/components`)
          .send(body);
        expect([JSON.stringify(body), res.status]).toEqual([
          JSON.stringify(body),
          400,
        ]);
      }
      expect(componentes.crear).not.toHaveBeenCalled();
    });

    it('PATCH components/:cid: un null EXPLÍCITO llega como null (limpia el opcional)', async () => {
      const res = await request(http())
        .patch(`/v1/engineering/components/${COMP}`)
        .send({
          categoria: null,
          limite_horas: null,
          limite_meses: null,
          fecha_vencimiento: null,
          horas_aeronave_instalacion: null,
          notas: null,
          aviso_horas: 5,
        });
      expect(res.status).toBe(200);
      expect(componentes.editar).toHaveBeenCalledWith(
        COMP,
        {
          categoria: null,
          limite_horas: null,
          limite_meses: null,
          fecha_vencimiento: null,
          horas_aeronave_instalacion: null,
          notas: null,
          aviso_horas: 5,
        },
        USER,
      );
    });

    it('PATCH: lo que NO admite null (nombre, horas previas, avisos) ⇒ 400; tampoco cambia el estado', async () => {
      for (const body of [
        { nombre: null },
        { horas_previas: null },
        { aviso_horas: null },
        { aviso_dias: null },
        { estado: 'RETIRADO' },
        { limite_horas: 0 },
      ]) {
        const res = await request(http())
          .patch(`/v1/engineering/components/${COMP}`)
          .send(body);
        expect([JSON.stringify(body), res.status]).toEqual([
          JSON.stringify(body),
          400,
        ]);
      }
      expect(componentes.editar).not.toHaveBeenCalled();
    });

    it('POST components/:cid/reemplazar: 200 (no 201) con `nuevo` validado; el mecánico puede', async () => {
      rol = Rol.MECANICO;
      const res = await request(http())
        .post(`/v1/engineering/components/${COMP}/reemplazar`)
        .send({
          fecha: '2026-11-17',
          horas_aeronave: 5599.4,
          motivo: ' Desgaste ',
          nuevo: {
            numero_serie: ' SN-NUEVO ',
            limite_horas: 600,
            limite_meses: null,
          },
        });
      expect(res.status).toBe(200);
      expect(componentes.reemplazar).toHaveBeenCalledWith(
        COMP,
        {
          fecha: '2026-11-17',
          horas_aeronave: 5599.4,
          motivo: 'Desgaste',
          nuevo: {
            numero_serie: 'SN-NUEVO',
            limite_horas: 600,
            limite_meses: null,
          },
        },
        USER,
      );
    });

    // PRECISIÓN DEL CONTRATO (panel, 17-nov-2026): en `nuevo`, los límites
    // viajan SIEMPRE, como número o como null explícito. El DTO tiene que
    // dejar pasar el null TAL CUAL y no inventar los campos que no viajan: el
    // servicio distingue `=== null` (no heredar) de `=== undefined` (heredar).
    it('reemplazar — en `nuevo`, el null EXPLÍCITO llega como null y lo AUSENTE no llega', async () => {
      const ruta = `/v1/engineering/components/${COMP}/reemplazar`;
      type Dto = { nuevo?: Record<string, unknown> | null };
      const ultimoDto = (): Dto => {
        const llamadas = componentes.reemplazar.mock.calls as unknown[][];
        return llamadas[llamadas.length - 1][1] as Dto;
      };

      // Todo en null explícito.
      const todoNull = {
        limite_horas: null,
        limite_meses: null,
        numero_parte: null,
        numero_serie: null,
        fabricante: null,
        notas: null,
        fecha_vencimiento: null,
      };
      let res = await request(http())
        .post(ruta)
        .send({ fecha: '2026-11-17', nuevo: todoNull });
      expect(res.status).toBe(200);
      for (const campo of Object.keys(todoNull)) {
        expect([campo, ultimoDto().nuevo?.[campo]]).toEqual([campo, null]);
      }

      // Un límite con número y el otro en null.
      res = await request(http())
        .post(ruta)
        .send({
          fecha: '2026-11-17',
          nuevo: { limite_horas: 300, limite_meses: null },
        });
      expect(res.status).toBe(200);
      expect(ultimoDto().nuevo?.limite_horas).toBe(300);
      expect(ultimoDto().nuevo?.limite_meses).toBeNull();

      // Lo que NO viaja llega undefined (el servicio lo hereda).
      res = await request(http())
        .post(ruta)
        .send({ fecha: '2026-11-17', nuevo: { limite_horas: 300 } });
      expect(res.status).toBe(200);
      expect(ultimoDto().nuevo?.limite_horas).toBe(300);
      expect(ultimoDto().nuevo?.limite_meses).toBeUndefined();
      expect(ultimoDto().nuevo?.numero_serie).toBeUndefined();

      // Sin `nuevo`, y con `nuevo: null`.
      res = await request(http()).post(ruta).send({ fecha: '2026-11-17' });
      expect(res.status).toBe(200);
      expect(ultimoDto().nuevo).toBeUndefined();
      res = await request(http())
        .post(ruta)
        .send({ fecha: '2026-11-17', nuevo: null });
      expect(res.status).toBe(200);
      expect(ultimoDto().nuevo ?? null).toBeNull();
    });

    it('reemplazar / retirar: sin fecha, con fecha mal formada o con llaves de más ⇒ 400', async () => {
      for (const ruta of ['reemplazar', 'retirar']) {
        for (const body of [
          {},
          { fecha: '17/11/2026' },
          { fecha: '2026-11-17', horas_aeronave: -1 },
          { fecha: '2026-11-17', motivo: 'x'.repeat(301) },
          { fecha: '2026-11-17', otra: 1 },
        ]) {
          const res = await request(http())
            .post(`/v1/engineering/components/${COMP}/${ruta}`)
            .send(body);
          expect([ruta, JSON.stringify(body), res.status]).toEqual([
            ruta,
            JSON.stringify(body),
            400,
          ]);
        }
      }
      // Dentro de `nuevo` tampoco pasan llaves de más ni límites en cero.
      for (const nuevo of [{ nombre: 'Otro nombre' }, { limite_horas: 0 }]) {
        const res = await request(http())
          .post(`/v1/engineering/components/${COMP}/reemplazar`)
          .send({ fecha: '2026-11-17', nuevo });
        expect(res.status).toBe(400);
      }
      // `nuevo` solo existe al reemplazar.
      const res = await request(http())
        .post(`/v1/engineering/components/${COMP}/retirar`)
        .send({ fecha: '2026-11-17', nuevo: {} });
      expect(res.status).toBe(400);
      expect(componentes.reemplazar).not.toHaveBeenCalled();
      expect(componentes.retirar).not.toHaveBeenCalled();
    });

    it('POST components/:cid/retirar: 200 con el userId', async () => {
      const res = await request(http())
        .post(`/v1/engineering/components/${COMP}/retirar`)
        .send({ fecha: '2026-11-17' });
      expect(res.status).toBe(200);
      expect(componentes.retirar).toHaveBeenCalledWith(
        COMP,
        { fecha: '2026-11-17' },
        USER,
      );
    });

    it('DELETE components/:cid: SOLO oficina (y DIRECCION); el mecánico no elimina', async () => {
      const pedir = () =>
        request(http()).delete(`/v1/engineering/components/${COMP}`);
      expect(await estados([...OFICINA, Rol.DIRECCION], pedir)).toEqual([
        200, 200, 200,
      ]);
      expect(componentes.eliminar).toHaveBeenLastCalledWith(COMP, USER);
      componentes.eliminar.mockClear();
      expect(await estados([Rol.MECANICO, ...SIN_ACCESO], pedir)).toEqual([
        403, 403, 403, 403, 403,
      ]);
      expect(componentes.eliminar).not.toHaveBeenCalled();
    });

    it('un 409 del servicio sale con su `code` y sus `details` por el filtro', async () => {
      componentes.reemplazar.mockRejectedValue(
        new ConflictException({
          message: 'Ese componente ya estaba retirado.',
          error: 'COMPONENTE_YA_RETIRADO',
          details: { id: COMP },
        }),
      );
      const res = await request(http())
        .post(`/v1/engineering/components/${COMP}/reemplazar`)
        .send({ fecha: '2026-11-17' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'COMPONENTE_YA_RETIRADO',
        message: 'Ese componente ya estaba retirado.',
        details: { id: COMP },
      });
    });
  });

  describe('archivos', () => {
    const cuerpo = {
      destino: 'MANTENIMIENTO',
      destino_id: MANT,
      storage_path: 'oficina/1731866400000-ab12cd-sticker-100hrs.pdf',
      nombre: 'Sticker 100 hrs.pdf',
      mime: 'application/pdf',
      bytes: 245678,
      etiqueta: 'STICKER',
    };

    it('GET aircraft/:id/adjuntos: oficina y MECANICO (200); los demás 403', async () => {
      const pedir = () =>
        request(http()).get(`/v1/engineering/aircraft/${AVION}/adjuntos`);
      expect(await estados(CON_MECANICO, pedir)).toEqual([200, 200, 200]);
      expect(adjuntos.listarDeAeronave).toHaveBeenLastCalledWith(AVION);
      expect(await estados(SIN_ACCESO, pedir)).toEqual([403, 403, 403, 403]);
    });

    it('POST adjuntos: 201 con el userId; SOLO oficina (el mecánico no registra)', async () => {
      const pedir = () =>
        request(http()).post('/v1/engineering/adjuntos').send(cuerpo);
      expect(await estados([...OFICINA, Rol.DIRECCION], pedir)).toEqual([
        201, 201, 201,
      ]);
      expect(adjuntos.registrar).toHaveBeenLastCalledWith(cuerpo, USER);
      adjuntos.registrar.mockClear();
      expect(await estados([Rol.MECANICO, Rol.PILOTO], pedir)).toEqual([
        403, 403,
      ]);
      expect(adjuntos.registrar).not.toHaveBeenCalled();
    });

    it('POST adjuntos: cuerpo ESTRICTO ⇒ 400 sin llamar al servicio', async () => {
      for (const cambio of [
        { destino: 'VUELO' },
        { destino_id: 'no-es-uuid' },
        { storage_path: 'gastos/sticker.pdf' }, // otro prefijo
        { storage_path: 'oficina/../csd/llave.key' }, // sube de carpeta
        { storage_path: 'oficina/con espacio.pdf' },
        { storage_path: 'https://x.supabase.co/storage/v1/object/a.pdf' },
        { nombre: '   ' },
        { nombre: 'x'.repeat(201) },
        { mime: 'application/zip' },
        { mime: 'image/heic' },
        { bytes: 0 },
        { bytes: 10 * 1024 * 1024 + 1 },
        { bytes: 1.5 },
        { etiqueta: 'RECIBO' },
        { nota: 'x'.repeat(301) },
        { aeronave_id: AVION }, // lo decide el API, no el cliente
      ]) {
        const res = await request(http())
          .post('/v1/engineering/adjuntos')
          .send({ ...cuerpo, ...cambio });
        expect([JSON.stringify(cambio), res.status]).toEqual([
          JSON.stringify(cambio),
          400,
        ]);
      }
      expect(adjuntos.registrar).not.toHaveBeenCalled();
    });

    it('POST adjuntos: el tope del bucket (10 MB justos) sí pasa', async () => {
      const res = await request(http())
        .post('/v1/engineering/adjuntos')
        .send({ ...cuerpo, bytes: 10 * 1024 * 1024, etiqueta: undefined });
      expect(res.status).toBe(201);
    });

    it('GET adjuntos/:aid/url: `descargar=true` fuerza la descarga; cualquier otra cosa, solo ver', async () => {
      rol = Rol.MECANICO;
      for (const [query, esperado] of [
        ['?descargar=true', true],
        ['', false],
        ['?descargar=false', false],
        ['?descargar=1', false],
      ] as const) {
        const res = await request(http()).get(
          `/v1/engineering/adjuntos/${ADJ}/url${query}`,
        );
        expect(res.status).toBe(200);
        expect(adjuntos.url).toHaveBeenLastCalledWith(ADJ, esperado);
      }
      rol = Rol.PILOTO;
      expect(
        (await request(http()).get(`/v1/engineering/adjuntos/${ADJ}/url`))
          .status,
      ).toBe(403);
    });

    it('DELETE adjuntos/:aid: SOLO oficina, con el userId', async () => {
      const pedir = () =>
        request(http()).delete(`/v1/engineering/adjuntos/${ADJ}`);
      expect(await estados(OFICINA, pedir)).toEqual([200, 200]);
      expect(adjuntos.eliminar).toHaveBeenLastCalledWith(ADJ, USER);
      adjuntos.eliminar.mockClear();
      expect(await estados([Rol.MECANICO, Rol.PILOTO], pedir)).toEqual([
        403, 403,
      ]);
      expect(adjuntos.eliminar).not.toHaveBeenCalled();
    });

    it('503 MIGRACION_PENDIENTE del servicio llega con su `code` (el panel decide por código)', async () => {
      // El filtro registra todo 5xx: aquí es esperado, fuera de la salida.
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      adjuntos.registrar.mockRejectedValue(
        new ServiceUnavailableException({
          message:
            'Los archivos de mantenimiento todavía no están disponibles.',
          error: 'MIGRACION_PENDIENTE',
          details: { migracion: '20261117000001' },
        }),
      );
      const res = await request(http())
        .post('/v1/engineering/adjuntos')
        .send(cuerpo);
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        code: 'MIGRACION_PENDIENTE',
        details: { migracion: '20261117000001' },
      });
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });
  });
});
