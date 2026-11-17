import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AdjuntosIngenieriaService,
  nombreDeDescarga,
  SEGUNDOS_URL_ADJUNTO,
  TOPE_ADJUNTOS_POR_DESTINO,
} from './adjuntos-ingenieria.service';
import type { CreateAdjuntoDto } from './dto/componentes.dto';
import {
  armarFalso,
  tieneOp,
  uuid,
  type Fila,
  type OpcionesFalso,
} from './ingenieria.fixture-spec';

/**
 * ARCHIVOS DE INGENIERÍA (17-nov-2026, API 0.0.140, invariante 135). Pedido
 * del cliente: «cada que se le da un mantenimiento el taller te entrega un
 * sticker […] que le tomen foto y lo suban, o el PDF […] poder descargarlas»
 * y «uno o varios documentos por componente».
 *
 * Qué se congela aquí:
 *  - registrar para los CUATRO destinos (mantenimiento, componente, motor,
 *    hélice) con el avión del destino y quién lo subió;
 *  - los rechazos: destino que no existe, archivo que no está en el bucket,
 *    archivo ya registrado (pre-lectura y carrera) y el tope de 20;
 *  - la URL firmada (ver / descargar con el nombre original);
 *  - la baja con sello (el archivo se conserva en el bucket);
 *  - la lista del avión: lo que HOY le pertenece (un motor trasladado se
 *    lleva sus archivos) y la llave del bucket NUNCA sale;
 *  - sin la migración: lecturas `disponible:false`, escrituras 503.
 */
const N990GG = uuid(1);
const XA_VGV = uuid(2);
const DIEGO = uuid(101);
const ITZI = uuid(102);
const MANT = uuid(201); // 100 HRS / ANUAL del N990GG
const MANT_VGV = uuid(202);
const COMP = uuid(301); // llanta del N990GG
const COMP_ELIMINADO = uuid(302);
const MOTOR_IZQ = uuid(401);
const MOTOR_DER = uuid(402);
const HELICE = uuid(501);
const T = 'adjunto_ingenieria';
const BUCKET = 'documentos-flota';

const AHORA = new Date('2026-11-17T18:00:00Z');

const BASE: Record<string, Fila[]> = {
  usuario: [
    { id: DIEGO, nombre: 'Diego Ramírez' },
    { id: ITZI, nombre: 'Itzi' },
  ],
  aeronave: [
    { id: N990GG, matricula: 'N990GG' },
    { id: XA_VGV, matricula: 'XA-VGV' },
  ],
  mantenimiento: [
    { id: MANT, aeronave_id: N990GG, descripcion: '100 HRS / ANUAL' },
    { id: MANT_VGV, aeronave_id: XA_VGV, descripcion: '50 hrs' },
  ],
  componente_aeronave: [
    { id: COMP, aeronave_id: N990GG, nombre: 'Llanta', eliminado_at: null },
    {
      id: COMP_ELIMINADO,
      aeronave_id: N990GG,
      nombre: 'Capturado mal',
      eliminado_at: '2026-11-01T00:00:00Z',
    },
  ],
  motor: [
    { id: MOTOR_IZQ, aeronave_id: N990GG, posicion: 'IZQUIERDO' },
    { id: MOTOR_DER, aeronave_id: N990GG, posicion: 'DERECHO' },
  ],
  helice: [{ id: HELICE, aeronave_id: N990GG, posicion: 'IZQUIERDA' }],
};

function adj(n: number, extra: Fila): Fila {
  return {
    id: uuid(n),
    aeronave_id: N990GG,
    mantenimiento_id: null,
    componente_id: null,
    motor_id: null,
    helice_id: null,
    storage_path: `oficina/archivo-${n}.pdf`,
    nombre: `archivo-${n}.pdf`,
    mime: 'application/pdf',
    bytes: 1000 + n,
    etiqueta: null,
    nota: null,
    subido_por: DIEGO,
    created_at: `2026-11-${String(10 + (n % 10)).padStart(2, '0')}T15:00:00.000Z`,
    eliminado_at: null,
    eliminado_por: null,
    ...extra,
  };
}

function armar(
  adjuntos: Fila[] = [],
  opciones: Partial<OpcionesFalso> = {},
  tablas: Record<string, Fila[]> = {},
) {
  const falso = armarFalso({
    tablas: { ...BASE, [T]: adjuntos, ...tablas },
    objetos: adjuntos.map((a) => a.storage_path as string),
    ...opciones,
  });
  return { service: new AdjuntosIngenieriaService(falso.supabase), falso };
}

const STICKER = 'oficina/1731866400000-ab12cd-sticker-100hrs.pdf';

function dto(extra: Partial<CreateAdjuntoDto> = {}): CreateAdjuntoDto {
  return {
    destino: 'MANTENIMIENTO',
    destino_id: MANT,
    storage_path: STICKER,
    nombre: 'Sticker 100 hrs.pdf',
    mime: 'application/pdf',
    bytes: 245_678,
    etiqueta: 'STICKER',
    ...extra,
  };
}

describe('AdjuntosIngenieriaService (invariante 135)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(AHORA));
  afterEach(() => jest.useRealTimers());

  describe('registrar — POST adjuntos', () => {
    it.each([
      ['MANTENIMIENTO', MANT, 'mantenimiento_id'],
      ['COMPONENTE', COMP, 'componente_id'],
      ['MOTOR', MOTOR_IZQ, 'motor_id'],
      ['HELICE', HELICE, 'helice_id'],
    ] as const)(
      'destino %s: la fila lleva SOLO esa llave, el avión del destino y quién lo subió',
      async (destino, destinoId, columna) => {
        const { service, falso } = armar([], { objetos: [STICKER] });
        const res = await service.registrar(
          dto({ destino, destino_id: destinoId, nota: '  del taller Toledo ' }),
          ITZI,
        );
        const fila = falso.cuerpo(T, 'insert');
        expect(fila).toEqual({
          aeronave_id: N990GG,
          [columna]: destinoId,
          storage_path: STICKER,
          nombre: 'Sticker 100 hrs.pdf',
          mime: 'application/pdf',
          bytes: 245_678,
          etiqueta: 'STICKER',
          nota: 'del taller Toledo',
          subido_por: ITZI,
        });
        expect(res).toEqual({
          id: expect.any(String) as string,
          destino,
          destino_id: destinoId,
          aeronave_id: N990GG,
          nombre: 'Sticker 100 hrs.pdf',
          mime: 'application/pdf',
          bytes: 245_678,
          etiqueta: 'STICKER',
          nota: 'del taller Toledo',
          subido_por_nombre: 'Itzi',
          created_at: expect.any(String) as string,
        });
        // La llave del bucket NUNCA sale del API.
        expect(JSON.stringify(res)).not.toContain('oficina/');
        expect(res).not.toHaveProperty('storage_path');
      },
    );

    it('sin etiqueta ni nota ⇒ null (y una nota en blanco también)', async () => {
      const { service, falso } = armar([], { objetos: [STICKER] });
      const res = await service.registrar(
        dto({ etiqueta: undefined, nota: '   ' }),
        DIEGO,
      );
      expect(falso.cuerpo(T, 'insert')).toMatchObject({
        etiqueta: null,
        nota: null,
      });
      expect(res).toMatchObject({ etiqueta: null, nota: null });
    });

    it('antes de registrar VERIFICA que el objeto esté en el bucket (firmándolo)', async () => {
      const { service, falso } = armar([], { objetos: [STICKER] });
      await service.registrar(dto(), DIEGO);
      expect(falso.firmas).toEqual([
        { bucket: BUCKET, path: STICKER, segundos: 60, opciones: undefined },
      ]);
    });

    it.each([
      ['MANTENIMIENTO', uuid(299)],
      ['COMPONENTE', uuid(399)],
      ['COMPONENTE', COMP_ELIMINADO], // existe, pero está eliminado
      ['MOTOR', uuid(499)],
      ['HELICE', uuid(599)],
    ] as const)(
      'destino %s que no existe (%s) ⇒ 404 DESTINO_NO_ENCONTRADO sin tocar el bucket ni escribir',
      async (destino, destinoId) => {
        const { service, falso } = armar([], { objetos: [STICKER] });
        const err: unknown = await service
          .registrar(dto({ destino, destino_id: destinoId }), DIEGO)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NotFoundException);
        expect((err as NotFoundException).getResponse()).toMatchObject({
          error: 'DESTINO_NO_ENCONTRADO',
          details: { destino, destino_id: destinoId },
        });
        expect(falso.firmas).toHaveLength(0);
        expect(falso.conOp(T, 'insert')).toHaveLength(0);
      },
    );

    it('el archivo NO está en el bucket ⇒ 400 ARCHIVO_NO_ENCONTRADO y nada escrito', async () => {
      const { service, falso } = armar([]); // bucket vacío
      const err: unknown = await service
        .registrar(dto(), DIEGO)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        error: 'ARCHIVO_NO_ENCONTRADO',
      });
      expect(falso.conOp(T, 'insert')).toHaveLength(0);
    });

    it('Storage caído (no es «no existe») ⇒ 503 STORAGE_NO_DISPONIBLE, no un 400 falso', async () => {
      const { service, falso } = armar([], { objetos: [STICKER] });
      falso.fallarFirma({ message: 'fetch failed' });
      const err: unknown = await service
        .registrar(dto(), DIEGO)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
        error: 'STORAGE_NO_DISPONIBLE',
      });
      expect(falso.conOp(T, 'insert')).toHaveLength(0);
    });

    it('archivo YA registrado ⇒ 409 ARCHIVO_YA_REGISTRADO (aunque esté dado de baja)', async () => {
      for (const eliminado_at of [null, '2026-11-12T00:00:00Z']) {
        const { service, falso } = armar([
          adj(1, {
            mantenimiento_id: MANT,
            storage_path: STICKER,
            eliminado_at,
          }),
        ]);
        const err: unknown = await service
          .registrar(dto(), DIEGO)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toMatchObject({
          error: 'ARCHIVO_YA_REGISTRADO',
        });
        expect(falso.conOp(T, 'insert')).toHaveLength(0);
      }
    });

    it('CARRERA: dos registros del mismo archivo ⇒ el índice único (23505) también es 409', async () => {
      const { service, falso } = armar([], { objetos: [STICKER] });
      // Otro registro del mismo archivo entra justo antes del alta.
      falso.antesDeCadaConsulta((c) => {
        if (c.tabla === T && tieneOp(c.ops, 'insert')) {
          falso.antesDeCadaConsulta(null);
          falso
            .de(T)
            .push(adj(77, { mantenimiento_id: MANT, storage_path: STICKER }));
        }
      });
      const err: unknown = await service
        .registrar(dto(), DIEGO)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        error: 'ARCHIVO_YA_REGISTRADO',
      });
      expect(falso.de(T)).toHaveLength(1);
    });

    it(`tope: con ${TOPE_ADJUNTOS_POR_DESTINO} archivos ACTIVOS en el destino ⇒ 409 TOPE_ADJUNTOS`, async () => {
      const llenos = Array.from({ length: TOPE_ADJUNTOS_POR_DESTINO }, (_, i) =>
        adj(600 + i, { mantenimiento_id: MANT }),
      );
      const { service, falso } = armar(llenos, {
        objetos: [...llenos.map((a) => a.storage_path as string), STICKER],
      });
      const err: unknown = await service
        .registrar(dto(), DIEGO)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        error: 'TOPE_ADJUNTOS',
        details: { tope: TOPE_ADJUNTOS_POR_DESTINO },
      });
      expect(falso.conOp(T, 'insert')).toHaveLength(0);
    });

    it('los dados de baja y los de OTRO destino no cuentan para el tope', async () => {
      const casiLlenos = [
        ...Array.from({ length: TOPE_ADJUNTOS_POR_DESTINO - 1 }, (_, i) =>
          adj(600 + i, { mantenimiento_id: MANT }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          adj(700 + i, {
            mantenimiento_id: MANT,
            eliminado_at: '2026-11-12T00:00:00Z',
          }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          adj(800 + i, { componente_id: COMP }),
        ),
      ];
      const { service, falso } = armar(casiLlenos, {
        objetos: [...casiLlenos.map((a) => a.storage_path as string), STICKER],
      });
      await expect(service.registrar(dto(), DIEGO)).resolves.toMatchObject({
        destino: 'MANTENIMIENTO',
        destino_id: MANT,
      });
      expect(falso.conOp(T, 'insert')).toHaveLength(1);
    });
  });

  describe('url — GET adjuntos/:aid/url', () => {
    const FOTO = adj(1, {
      mantenimiento_id: MANT,
      nombre: 'Sticker & foto #1 (100 hrs).jpg',
      mime: 'image/jpeg',
    });

    it(`ver: URL firmada de ${SEGUNDOS_URL_ADJUNTO} s, sin forzar descarga`, async () => {
      const { service, falso } = armar([FOTO]);
      const res = await service.url(FOTO.id as string, false);
      expect(res).toEqual({
        url: `https://storage.test/${BUCKET}/${FOTO.storage_path as string}?token=t&exp=${SEGUNDOS_URL_ADJUNTO}`,
        expira_en_s: SEGUNDOS_URL_ADJUNTO,
        nombre: 'Sticker & foto #1 (100 hrs).jpg',
        mime: 'image/jpeg',
      });
      expect(falso.firmas).toEqual([
        {
          bucket: BUCKET,
          path: FOTO.storage_path,
          segundos: SEGUNDOS_URL_ADJUNTO,
          opciones: undefined,
        },
      ]);
    });

    it('descargar: fuerza la descarga con el nombre original SANEADO (un & o un # romperían la URL)', async () => {
      const { service, falso } = armar([FOTO]);
      const res = await service.url(FOTO.id as string, true);
      expect(falso.firmas[0].opciones).toEqual({
        download: 'Sticker _ foto _1 (100 hrs).jpg',
      });
      expect(res.url).toContain('&download=Sticker _ foto _1 (100 hrs).jpg');
      // El nombre que se MUESTRA sigue siendo el original.
      expect(res.nombre).toBe('Sticker & foto #1 (100 hrs).jpg');
    });

    it('no existe o está dado de baja ⇒ 404 ADJUNTO_NO_ENCONTRADO sin firmar nada', async () => {
      const { service, falso } = armar([
        adj(2, {
          mantenimiento_id: MANT,
          eliminado_at: '2026-11-12T00:00:00Z',
        }),
      ]);
      for (const id of [uuid(2), uuid(404)]) {
        const err: unknown = await service
          .url(id, false)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NotFoundException);
        expect((err as NotFoundException).getResponse()).toMatchObject({
          error: 'ADJUNTO_NO_ENCONTRADO',
        });
      }
      expect(falso.firmas).toHaveLength(0);
    });

    it('la firma falla ⇒ 503 FIRMA_NO_DISPONIBLE (se puede reintentar)', async () => {
      const { service, falso } = armar([FOTO]);
      falso.fallarFirma({ message: 'timeout' });
      const err: unknown = await service
        .url(FOTO.id as string, false)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
        error: 'FIRMA_NO_DISPONIBLE',
      });
    });
  });

  describe('eliminar — DELETE adjuntos/:aid', () => {
    it('baja con sello: la fila se conserva y el archivo SIGUE en el bucket', async () => {
      const A = adj(1, { mantenimiento_id: MANT });
      const { service, falso } = armar([A]);
      await expect(service.eliminar(A.id as string, ITZI)).resolves.toEqual({
        ok: true,
      });
      expect(falso.de(T)).toHaveLength(1);
      expect(falso.de(T)[0]).toMatchObject({
        eliminado_at: AHORA.toISOString(),
        eliminado_por: ITZI,
      });
      expect(falso.conOp(T, 'delete')).toHaveLength(0);
      expect(falso.borrados).toHaveLength(0);
      expect(falso.objetos.has(A.storage_path as string)).toBe(true);
      // Ya no sale en la lista ni se puede abrir.
      expect((await service.listarDeAeronave(N990GG)).adjuntos).toEqual([]);
      await expect(service.url(A.id as string, false)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('la segunda vez (o un id que no existe) ⇒ 404', async () => {
      const A = adj(1, { mantenimiento_id: MANT });
      const { service } = armar([A]);
      await service.eliminar(A.id as string, ITZI);
      await expect(
        service.eliminar(A.id as string, ITZI),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.eliminar(uuid(404), ITZI)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('listarDeAeronave — GET aircraft/:id/adjuntos', () => {
    const DEL_MANT = adj(1, {
      mantenimiento_id: MANT,
      etiqueta: 'STICKER',
      created_at: '2026-11-17T15:00:00.000Z',
    });
    const DEL_COMP = adj(2, {
      componente_id: COMP,
      etiqueta: 'FACTURA',
      subido_por: ITZI,
      created_at: '2026-11-16T15:00:00.000Z',
    });
    const DEL_MOTOR = adj(3, {
      motor_id: MOTOR_IZQ,
      created_at: '2026-11-15T15:00:00.000Z',
    });
    const DE_HELICE = adj(4, {
      helice_id: HELICE,
      created_at: '2026-11-14T15:00:00.000Z',
    });
    const DADO_DE_BAJA = adj(5, {
      mantenimiento_id: MANT,
      eliminado_at: '2026-11-12T00:00:00Z',
    });
    const DE_COMP_ELIMINADO = adj(6, { componente_id: COMP_ELIMINADO });
    const DE_OTRO_AVION = adj(7, {
      aeronave_id: XA_VGV,
      mantenimiento_id: MANT_VGV,
    });

    it('lo del avión, el más reciente primero; fuera lo dado de baja, lo de componentes eliminados y lo de otro avión', async () => {
      const { service } = armar([
        DE_HELICE,
        DADO_DE_BAJA,
        DEL_COMP,
        DE_OTRO_AVION,
        DEL_MOTOR,
        DE_COMP_ELIMINADO,
        DEL_MANT,
      ]);
      const res = await service.listarDeAeronave(N990GG);
      expect(res.disponible).toBe(true);
      expect(res.adjuntos.map((a) => [a.destino, a.destino_id])).toEqual([
        ['MANTENIMIENTO', MANT],
        ['COMPONENTE', COMP],
        ['MOTOR', MOTOR_IZQ],
        ['HELICE', HELICE],
      ]);
      expect(res.adjuntos[0]).toEqual({
        id: DEL_MANT.id,
        destino: 'MANTENIMIENTO',
        destino_id: MANT,
        aeronave_id: N990GG,
        nombre: 'archivo-1.pdf',
        mime: 'application/pdf',
        bytes: 1001,
        etiqueta: 'STICKER',
        nota: null,
        subido_por_nombre: 'Diego Ramírez',
        created_at: '2026-11-17T15:00:00.000Z',
      });
      expect(res.adjuntos[1].subido_por_nombre).toBe('Itzi');
      // La llave del bucket no viaja en NINGUNA fila.
      expect(JSON.stringify(res)).not.toContain('oficina/');
      // El otro avión ve solo lo suyo.
      const vgv = await service.listarDeAeronave(XA_VGV);
      expect(vgv.adjuntos.map((a) => a.id)).toEqual([DE_OTRO_AVION.id]);
    });

    it('un motor TRASLADADO se lleva sus archivos: salen en el avión donde está hoy, no donde se subieron', async () => {
      // El motor izquierdo se subió estando en el N990GG y hoy está en el XA-VGV.
      const { service } = armar(
        [DEL_MOTOR, DEL_MANT],
        {},
        {
          motor: [
            { id: MOTOR_IZQ, aeronave_id: XA_VGV, posicion: 'UNICO' },
            { id: MOTOR_DER, aeronave_id: N990GG, posicion: 'DERECHO' },
          ],
        },
      );
      const n990 = await service.listarDeAeronave(N990GG);
      expect(n990.adjuntos.map((a) => a.id)).toEqual([DEL_MANT.id]);
      const vgv = await service.listarDeAeronave(XA_VGV);
      expect(vgv.adjuntos.map((a) => [a.destino, a.destino_id])).toEqual([
        ['MOTOR', MOTOR_IZQ],
      ]);
    });

    it('una etiqueta que no es del catálogo sale null (no se inventa)', async () => {
      const { service } = armar([
        adj(1, { mantenimiento_id: MANT, etiqueta: 'LO_QUE_SEA' }),
      ]);
      const res = await service.listarDeAeronave(N990GG);
      expect(res.adjuntos[0].etiqueta).toBeNull();
    });

    it('avión sin archivos ⇒ disponible:true y lista vacía', async () => {
      const { service } = armar([]);
      await expect(service.listarDeAeronave(N990GG)).resolves.toEqual({
        disponible: true,
        adjuntos: [],
      });
    });

    it('un id que no es uuid no llega al filtro de PostgREST', async () => {
      const { service, falso } = armar([]);
      await expect(
        service.listarDeAeronave('x,motor_id.not.is.null'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(falso.conOp(T, 'or')).toHaveLength(0);
    });
  });

  describe('migración 20261117000001 sin aplicar', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());

    const AUSENTES = { ausentes: [T, 'componente_aeronave'] };

    it('listar ⇒ disponible:false y lista vacía', async () => {
      const { service } = armar([], AUSENTES);
      await expect(service.listarDeAeronave(N990GG)).resolves.toEqual({
        disponible: false,
        adjuntos: [],
      });
    });

    it('registrar y eliminar ⇒ 503 MIGRACION_PENDIENTE en es-MX; la URL ⇒ 404', async () => {
      const { service, falso } = armar([], AUSENTES);
      for (const intento of [
        () => service.registrar(dto(), DIEGO),
        () => service.eliminar(uuid(1), DIEGO),
      ]) {
        const err: unknown = await intento().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        const cuerpo = (err as ServiceUnavailableException).getResponse();
        expect(cuerpo).toMatchObject({
          error: 'MIGRACION_PENDIENTE',
          details: { migracion: '20261117000001' },
        });
        expect((cuerpo as { message: string }).message).toMatch(
          /todavía no están disponibles/,
        );
      }
      await expect(service.url(uuid(1), false)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(falso.firmas).toHaveLength(0);
    });
  });
});

describe('nombreDeDescarga', () => {
  it.each([
    ['Sticker 100 hrs.pdf', 'Sticker 100 hrs.pdf'],
    ['factura&llanta#2.pdf', 'factura_llanta_2.pdf'],
    ['a/b\\c:d*e?f"g<h>i|j.pdf', 'a_b_c_d_e_f_g_h_i_j.pdf'],
    ['  50%   de avance + nota;=.jpg ', '50_ de avance _ nota__.jpg'],
    ['Bitácora de motor (ñ).pdf', 'Bitácora de motor (ñ).pdf'],
    ['   ', 'archivo'],
  ])('%s ⇒ %s', (entrada, esperado) => {
    expect(nombreDeDescarga(entrada)).toBe(esperado);
  });
});
