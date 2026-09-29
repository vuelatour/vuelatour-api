import { BadRequestException, HttpException } from '@nestjs/common';
import { Rol } from '../../common/types/auth.types';
import {
  CLAVE_PRECIERRE_SEGUIMIENTO,
  MIGRACION_VUELO_SEGUIMIENTO,
  ROLES_SEGUIMIENTO_ESCRITURA,
  ROLES_SEGUIMIENTO_LECTURA,
  SEGUIMIENTO_DETALLE_MAX,
  aNota,
  contarPendientes,
  detallePendientesCotizacion,
  idsUsuariosDeNotas,
  normalizarResolucion,
  normalizarTexto,
  ordenarNotas,
  parcheSeguimiento,
  resumenPrecierreSeguimiento,
  rolVeSeguimiento,
  textoPrecierreSeguimiento,
  type SeguimientoRow,
} from './vuelo-seguimiento.util';

/**
 * SEGUIMIENTO DE LA COTIZACIÓN (29-sep-2026): reglas puras — orden de la
 * lista, contadores, banner del cotizador, sellos de PATCH y aviso del
 * pre-cierre. Caso del cliente (#358): «los pax pidieron un transporte el
 * cual no está incluido en la cotización pero se necesita cobrar».
 */

const V358 = 'aaaaaaaa-0000-4000-8000-000000000358';
const ITZI = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const MARY = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const nombres = new Map([
  [ITZI, 'Itzi'],
  [MARY, 'Mary Cruz'],
]);

function fila(p: Partial<SeguimientoRow> & { id: string }): SeguimientoRow {
  return {
    vuelo_id: V358,
    texto: 'Transporte terrestre para los pax',
    afecta_cotizacion: true,
    estado: 'PENDIENTE',
    created_at: '2026-09-29T20:00:00+00:00',
    created_by: ITZI,
    updated_at: '2026-09-29T20:00:00+00:00',
    resuelta_at: null,
    resuelta_por: null,
    resolucion: null,
    deleted_at: null,
    ...p,
  };
}

function codigo(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpException) {
      return (e.getResponse() as { error?: string }).error;
    }
    throw e;
  }
  return undefined;
}

describe('vuelo-seguimiento.util — constantes del contrato', () => {
  it('migración, clave del pre-cierre y roles', () => {
    expect(MIGRACION_VUELO_SEGUIMIENTO).toBe('20260929000002');
    expect(CLAVE_PRECIERRE_SEGUIMIENTO).toBe(
      'seguimiento_cotizacion_pendiente',
    );
    expect([...ROLES_SEGUIMIENTO_LECTURA]).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
      Rol.SOCIO,
      Rol.ANALISTA,
    ]);
    expect([...ROLES_SEGUIMIENTO_ESCRITURA]).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
    ]);
  });

  it('rolVeSeguimiento: la tripulación y el visitante no reciben contadores', () => {
    for (const r of ROLES_SEGUIMIENTO_LECTURA) {
      expect(rolVeSeguimiento(r)).toBe(true);
    }
    expect(rolVeSeguimiento(Rol.PILOTO)).toBe(false);
    expect(rolVeSeguimiento(Rol.MECANICO)).toBe(false);
    expect(rolVeSeguimiento(Rol.VISITANTE)).toBe(false);
    expect(rolVeSeguimiento(undefined)).toBe(false);
  });
});

describe('ordenarNotas', () => {
  it('PENDIENTE primero y, dentro de cada estado, la más reciente arriba', () => {
    const filas = [
      fila({
        id: 'r-vieja',
        estado: 'RESUELTA',
        created_at: '2026-09-01T10:00:00Z',
        resuelta_at: '2026-09-02T10:00:00Z',
      }),
      fila({ id: 'p-vieja', created_at: '2026-09-10T10:00:00Z' }),
      fila({
        id: 'r-nueva',
        estado: 'RESUELTA',
        created_at: '2026-09-28T10:00:00Z',
        resuelta_at: '2026-09-28T11:00:00Z',
      }),
      fila({ id: 'p-nueva', created_at: '2026-09-29T10:00:00Z' }),
    ];
    expect(ordenarNotas(filas).map((f) => f.id)).toEqual([
      'p-nueva',
      'p-vieja',
      'r-nueva',
      'r-vieja',
    ]);
    // No muta la entrada.
    expect(filas[0].id).toBe('r-vieja');
  });

  it('empate de fecha: orden estable por id (desc)', () => {
    const t = '2026-09-29T10:00:00Z';
    const r = ordenarNotas([
      fila({ id: 'a', created_at: t }),
      fila({ id: 'c', created_at: t }),
      fila({ id: 'b', created_at: t }),
    ]);
    expect(r.map((f) => f.id)).toEqual(['c', 'b', 'a']);
  });

  it('las offsets distintas se comparan como instantes, no como texto', () => {
    const r = ordenarNotas([
      fila({ id: 'utc', created_at: '2026-09-29T20:00:00+00:00' }), // 15:00 Cancún
      fila({ id: 'cancun', created_at: '2026-09-29T16:00:00-05:00' }), // 21:00 UTC
    ]);
    expect(r.map((f) => f.id)).toEqual(['cancun', 'utc']);
  });
});

describe('contarPendientes', () => {
  it('cuenta PENDIENTE vivas; las que afectan la cotización aparte', () => {
    expect(
      contarPendientes([
        fila({ id: '1' }),
        fila({ id: '2', afecta_cotizacion: false }),
        fila({
          id: '3',
          estado: 'RESUELTA',
          resuelta_at: '2026-09-29T21:00:00Z',
        }),
        fila({ id: '4', deleted_at: '2026-09-29T22:00:00Z' }),
      ]),
    ).toEqual({
      seguimiento_pendientes: 2,
      seguimiento_cotizacion_pendientes: 1,
    });
  });

  it('sin notas ⇒ 0 y 0', () => {
    expect(contarPendientes([])).toEqual({
      seguimiento_pendientes: 0,
      seguimiento_cotizacion_pendientes: 0,
    });
  });
});

describe('detallePendientesCotizacion (banner del cotizador)', () => {
  it('solo PENDIENTE que afectan la cotización, más reciente primero, con nombre', () => {
    const r = detallePendientesCotizacion(
      [
        fila({
          id: 'vieja',
          created_at: '2026-09-28T10:00:00Z',
          created_by: MARY,
        }),
        fila({
          id: 'nueva',
          created_at: '2026-09-29T10:00:00Z',
          texto: 'Hielo y bebidas extra',
        }),
        fila({ id: 'no-cot', afecta_cotizacion: false }),
        fila({
          id: 'resuelta',
          estado: 'RESUELTA',
          resuelta_at: '2026-09-29T11:00:00Z',
        }),
        fila({ id: 'borrada', deleted_at: '2026-09-29T12:00:00Z' }),
        fila({
          id: 'sin-autor',
          created_at: '2026-09-27T10:00:00Z',
          created_by: null,
        }),
      ],
      nombres,
    );
    expect(r).toEqual([
      {
        id: 'nueva',
        texto: 'Hielo y bebidas extra',
        created_at: '2026-09-29T10:00:00Z',
        creado_por_nombre: 'Itzi',
      },
      {
        id: 'vieja',
        texto: 'Transporte terrestre para los pax',
        created_at: '2026-09-28T10:00:00Z',
        creado_por_nombre: 'Mary Cruz',
      },
      {
        id: 'sin-autor',
        texto: 'Transporte terrestre para los pax',
        created_at: '2026-09-27T10:00:00Z',
        creado_por_nombre: null,
      },
    ]);
  });

  it('máximo 20 renglones (los más recientes)', () => {
    const filas = Array.from({ length: 25 }, (_, i) =>
      fila({
        id: `n${String(i).padStart(2, '0')}`,
        created_at: new Date(Date.UTC(2026, 8, 1 + i)).toISOString(),
      }),
    );
    const r = detallePendientesCotizacion(filas, nombres);
    expect(SEGUIMIENTO_DETALLE_MAX).toBe(20);
    expect(r).toHaveLength(20);
    expect(r[0].id).toBe('n24');
    expect(r[19].id).toBe('n05');
  });
});

describe('aNota (forma del contrato)', () => {
  it('PENDIENTE: creado_por con nombre y resuelta_por null', () => {
    expect(aNota(fila({ id: 'x' }), nombres)).toEqual({
      id: 'x',
      vuelo_id: V358,
      texto: 'Transporte terrestre para los pax',
      afecta_cotizacion: true,
      estado: 'PENDIENTE',
      created_at: '2026-09-29T20:00:00+00:00',
      updated_at: '2026-09-29T20:00:00+00:00',
      creado_por: { id: ITZI, nombre: 'Itzi' },
      resuelta_at: null,
      resuelta_por: null,
      resolucion: null,
    });
  });

  it('RESUELTA: quién, cuándo y cómo', () => {
    const n = aNota(
      fila({
        id: 'x',
        estado: 'RESUELTA',
        resuelta_at: '2026-09-30T15:00:00Z',
        resuelta_por: MARY,
        resolucion: 'Se agregó como extra (v3)',
      }),
      nombres,
    );
    expect(n.estado).toBe('RESUELTA');
    expect(n.resuelta_at).toBe('2026-09-30T15:00:00Z');
    expect(n.resuelta_por).toEqual({ id: MARY, nombre: 'Mary Cruz' });
    expect(n.resolucion).toBe('Se agregó como extra (v3)');
  });

  it('usuario borrado o sin nombre: objeto con nulls, JAMÁS un uuid como nombre', () => {
    const otro = 'aaaaaaaa-0000-4000-8000-0000000000ff';
    expect(
      aNota(fila({ id: 'x', created_by: null }), nombres).creado_por,
    ).toEqual({ id: null, nombre: null });
    expect(
      aNota(fila({ id: 'x', created_by: otro }), nombres).creado_por,
    ).toEqual({ id: otro, nombre: null });
    const res = aNota(
      fila({
        id: 'x',
        estado: 'RESUELTA',
        resuelta_at: '2026-09-30T15:00:00Z',
        resuelta_por: null,
      }),
      nombres,
    );
    expect(res.resuelta_por).toEqual({ id: null, nombre: null });
  });

  it('idsUsuariosDeNotas: distintos y sin nulls', () => {
    expect(
      idsUsuariosDeNotas([
        fila({ id: '1' }),
        fila({ id: '2', created_by: MARY, resuelta_por: ITZI }),
        fila({ id: '3', created_by: null }),
      ]).sort(),
    ).toEqual([ITZI, MARY].sort());
  });
});

describe('normalizarTexto / normalizarResolucion', () => {
  it('recorta; vacío o en blanco ⇒ 400; > 1000 ⇒ 400', () => {
    expect(normalizarTexto('  Transporte  ')).toBe('Transporte');
    expect(codigo(() => normalizarTexto(''))).toBe('SEGUIMIENTO_TEXTO_VACIO');
    expect(codigo(() => normalizarTexto('   \n '))).toBe(
      'SEGUIMIENTO_TEXTO_VACIO',
    );
    expect(codigo(() => normalizarTexto(undefined))).toBe(
      'SEGUIMIENTO_TEXTO_VACIO',
    );
    expect(normalizarTexto('x'.repeat(1000))).toHaveLength(1000);
    expect(codigo(() => normalizarTexto('x'.repeat(1001)))).toBe(
      'SEGUIMIENTO_TEXTO_LARGO',
    );
  });

  it('resolución: "" / null ⇒ null; > 500 ⇒ 400', () => {
    expect(normalizarResolucion(null)).toBeNull();
    expect(normalizarResolucion('   ')).toBeNull();
    expect(normalizarResolucion(' Cobrado aparte ')).toBe('Cobrado aparte');
    expect(normalizarResolucion('r'.repeat(500))).toHaveLength(500);
    expect(codigo(() => normalizarResolucion('r'.repeat(501)))).toBe(
      'SEGUIMIENTO_RESOLUCION_LARGA',
    );
  });
});

describe('parcheSeguimiento (sellos de PATCH)', () => {
  const AHORA = '2026-09-30T15:00:00.000Z';

  it('Marcar resuelta desde PENDIENTE sella quién y cuándo (+ resolución opcional)', () => {
    expect(
      parcheSeguimiento(
        { estado: 'PENDIENTE' },
        { estado: 'RESUELTA' },
        MARY,
        AHORA,
      ),
    ).toEqual({
      estado: 'RESUELTA',
      resuelta_at: AHORA,
      resuelta_por: MARY,
      resolucion: null,
    });
    expect(
      parcheSeguimiento(
        { estado: 'PENDIENTE' },
        { estado: 'RESUELTA', resolucion: '  Se agregó como extra  ' },
        MARY,
        AHORA,
      ),
    ).toEqual({
      estado: 'RESUELTA',
      resuelta_at: AHORA,
      resuelta_por: MARY,
      resolucion: 'Se agregó como extra',
    });
  });

  it('Marcar resuelta sobre una ya resuelta NO re-sella (idempotente: parche vacío)', () => {
    expect(
      parcheSeguimiento(
        { estado: 'RESUELTA' },
        { estado: 'RESUELTA' },
        ITZI,
        AHORA,
      ),
    ).toEqual({});
  });

  it('en una resuelta se puede corregir la resolución sin re-sellar', () => {
    expect(
      parcheSeguimiento(
        { estado: 'RESUELTA' },
        { resolucion: 'Cobrado en efectivo' },
        ITZI,
        AHORA,
      ),
    ).toEqual({ resolucion: 'Cobrado en efectivo' });
    expect(
      parcheSeguimiento(
        { estado: 'RESUELTA' },
        { estado: 'RESUELTA', resolucion: '' },
        ITZI,
        AHORA,
      ),
    ).toEqual({ resolucion: null });
  });

  it('Reabrir limpia sello y resolución; reabrir una pendiente es no-op', () => {
    expect(
      parcheSeguimiento(
        { estado: 'RESUELTA' },
        { estado: 'PENDIENTE' },
        ITZI,
        AHORA,
      ),
    ).toEqual({
      estado: 'PENDIENTE',
      resuelta_at: null,
      resuelta_por: null,
      resolucion: null,
    });
    expect(
      parcheSeguimiento(
        { estado: 'PENDIENTE' },
        { estado: 'PENDIENTE' },
        ITZI,
        AHORA,
      ),
    ).toEqual({});
  });

  it('resolución sobre una PENDIENTE (o al reabrir) ⇒ 400', () => {
    expect(
      codigo(() =>
        parcheSeguimiento(
          { estado: 'PENDIENTE' },
          { resolucion: 'x' },
          ITZI,
          AHORA,
        ),
      ),
    ).toBe('SEGUIMIENTO_RESOLUCION_SIN_RESOLVER');
    expect(
      codigo(() =>
        parcheSeguimiento(
          { estado: 'RESUELTA' },
          { estado: 'PENDIENTE', resolucion: 'x' },
          ITZI,
          AHORA,
        ),
      ),
    ).toBe('SEGUIMIENTO_RESOLUCION_SIN_RESOLVER');
    // "" / null sobre una pendiente no es un error: no hay nada que escribir.
    expect(
      parcheSeguimiento(
        { estado: 'PENDIENTE' },
        { resolucion: null },
        ITZI,
        AHORA,
      ),
    ).toEqual({});
  });

  it('afecta_cotizacion que NO es booleano ⇒ 400 (null jamás se guarda como false)', () => {
    expect(() =>
      parcheSeguimiento(
        { estado: 'PENDIENTE' },
        { afecta_cotizacion: null as unknown as boolean },
        'u',
        '2026-09-29T21:00:00.000Z',
      ),
    ).toThrow(BadRequestException);
  });

  it('texto y afecta_cotizacion se editan en cualquier estado', () => {
    expect(
      parcheSeguimiento(
        { estado: 'RESUELTA' },
        { texto: '  Transporte CUN–Tulum  ', afecta_cotizacion: false },
        ITZI,
        AHORA,
      ),
    ).toEqual({ texto: 'Transporte CUN–Tulum', afecta_cotizacion: false });
    expect(
      codigo(() =>
        parcheSeguimiento(
          { estado: 'PENDIENTE' },
          { texto: '  ' },
          ITZI,
          AHORA,
        ),
      ),
    ).toBe('SEGUIMIENTO_TEXTO_VACIO');
  });

  it('cuerpo sin ningún campo ⇒ 400', () => {
    expect(() =>
      parcheSeguimiento({ estado: 'PENDIENTE' }, {}, ITZI, AHORA),
    ).toThrow(BadRequestException);
    expect(
      codigo(() => parcheSeguimiento({ estado: 'PENDIENTE' }, {}, ITZI, AHORA)),
    ).toBe('SEGUIMIENTO_SIN_CAMBIOS');
  });
});

describe('pre-cierre: resumenPrecierreSeguimiento', () => {
  const v = (id: string, folio: number, estado = 'COMPLETADO') => ({
    id,
    folio,
    estado,
    fecha_vuelo: '2026-09-29T14:00:00+00:00',
  });

  it('agrupa por vuelo, cuenta notas y ordena por folio', () => {
    const r = resumenPrecierreSeguimiento([
      { vuelo_id: 'v358', vuelo: v('v358', 358) },
      { vuelo_id: 'v301', vuelo: [v('v301', 301, 'CANCELADO')] }, // embed como arreglo
      { vuelo_id: 'v358', vuelo: v('v358', 358) },
    ]);
    expect(r.count).toBe(2);
    expect(r.notas).toBe(3);
    expect(r.vuelos).toEqual([
      {
        id: 'v301',
        folio: 301,
        estado: 'CANCELADO',
        fecha_vuelo: '2026-09-29T14:00:00+00:00',
        notas: 1,
      },
      {
        id: 'v358',
        folio: 358,
        estado: 'COMPLETADO',
        fecha_vuelo: '2026-09-29T14:00:00+00:00',
        notas: 2,
      },
    ]);
    expect(r.detalle).toBe(
      '2 vuelo(s) con ajustes pendientes de reflejar en la cotización: #301, #358. Agrégalos a la cotización y márcalos como resueltos en el detalle del vuelo → «Seguimiento de la cotización».',
    );
  });

  it('sin filas ⇒ 0 y texto neutro', () => {
    const r = resumenPrecierreSeguimiento([]);
    expect(r).toEqual({
      count: 0,
      notas: 0,
      detalle:
        'Ningún vuelo del periodo tiene ajustes pendientes de reflejar en la cotización.',
      vuelos: [],
    });
  });

  it('un vuelo sin folio legible cuenta igual (folio 0)', () => {
    const r = resumenPrecierreSeguimiento([{ vuelo_id: 'vx', vuelo: null }]);
    expect(r.count).toBe(1);
    expect(r.vuelos[0]).toEqual({
      id: 'vx',
      folio: 0,
      estado: null,
      fecha_vuelo: null,
      notas: 1,
    });
  });

  it('más de 15 folios: el texto enumera 15 y «y N más»', () => {
    const folios = Array.from({ length: 18 }, (_, i) => 300 + i);
    expect(textoPrecierreSeguimiento(folios)).toBe(
      `18 vuelo(s) con ajustes pendientes de reflejar en la cotización: ${folios
        .slice(0, 15)
        .map((f) => `#${f}`)
        .join(
          ', ',
        )} y 3 más. Agrégalos a la cotización y márcalos como resueltos en el detalle del vuelo → «Seguimiento de la cotización».`,
    );
  });
});
