import { readFileSync } from 'fs';
import { join } from 'path';
import {
  necesitaTramosVivos,
  ubicacionBalanceDeGasto,
  type GastoParaUbicacion,
} from './ubicacion-balance-gasto.util';
import { CATEGORIAS_GASTO_EMPRESA } from './categoria-gasto.util';

/**
 * «¿En qué libro y en qué mes vive este gasto?» (13-oct-2026, invariante
 * 72): un caso por regla (R1–R8) con los casos REALES de prod del 13-oct, y
 * la ALARMA DE PARIDAD contra `aircraft-balance.service.ts`.
 */
const N41 = 'av-n4142r';
const VGV = 'av-xa-vgv';
const PEV = 'av-xb-pev';

const OCT = { desde: '2026-10-01', hasta: '2026-10-31' };
const SEP = { desde: '2026-09-01', hasta: '2026-09-30' };

function gasto(extra: Partial<GastoParaUbicacion> = {}): GastoParaUbicacion {
  return {
    id: 'g-1',
    categoria: 'OPERACIONES',
    fecha_gasto: '2026-09-28',
    monto: 1899.09,
    vuelo_id: 'v-430',
    aeronave_id: N41,
    escala_id: null,
    inventario_movimiento_id: null,
    escala: null,
    vuelo: {
      fecha_vuelo: '2026-10-10T21:30:00+00:00',
      aeronave_id: N41,
      es_externo: false,
    },
    ...extra,
  };
}

const sinVuelo = (extra: Partial<GastoParaUbicacion> = {}) =>
  gasto({ vuelo_id: null, vuelo: null, fecha_gasto: '2026-09-15', ...extra });

describe('R1/R2 — fuera de los libros con vínculo', () => {
  it('PERSONAL_DUENO y las DOS categorías del pago al vendedor ⇒ null', () => {
    for (const categoria of [
      'PERSONAL_DUENO',
      'COMISION_VENDEDOR',
      'COMISION_VENDEDOR_AVION',
    ]) {
      expect(ubicacionBalanceDeGasto(gasto({ categoria }))).toBeNull();
    }
  });
});

describe('R6 — con vuelo: el libro del mes del VUELO', () => {
  it('OPERACIONES de #430: octubre (fecha del vuelo, no del gasto), eje vuelo, reporte_horas en los dos', () => {
    expect(ubicacionBalanceDeGasto(gasto())).toEqual({
      periodo: OCT,
      eje: 'vuelo',
      aviones: [N41],
      general: true,
      hoja_avion: 'reporte_horas',
      hoja_general: 'reporte_horas',
    });
  });

  it('las 22:30 del 30-sep en Cancún son SEPTIEMBRE', () => {
    expect(
      ubicacionBalanceDeGasto(
        gasto({
          vuelo: {
            fecha_vuelo: '2026-10-01T03:30:00Z',
            aeronave_id: N41,
            es_externo: false,
          },
        }),
      )?.periodo,
    ).toEqual(SEP);
  });

  it('la escala del otro avión gana sobre el sellado; una escala sin avión hereda el del vuelo', () => {
    expect(
      ubicacionBalanceDeGasto(
        gasto({ escala_id: 'e-2', escala: { aeronave_id: VGV } }),
      )?.aviones,
    ).toEqual([VGV]);
    expect(
      ubicacionBalanceDeGasto(
        gasto({
          escala_id: 'e-2',
          aeronave_id: PEV,
          escala: { aeronave_id: null },
        }),
      )?.aviones,
    ).toEqual([N41]);
  });

  it('TUAS y COMISARIATO con vuelo ⇒ la fila del vuelo', () => {
    for (const categoria of ['TUAS', 'COMISARIATO', 'REFACCION']) {
      expect(ubicacionBalanceDeGasto(gasto({ categoria }))).toMatchObject({
        eje: 'vuelo',
        hoja_avion: 'reporte_horas',
        hoja_general: 'reporte_horas',
      });
    }
  });

  it('PERMISO con vuelo ⇒ «permisos» y NO en el general', () => {
    expect(ubicacionBalanceDeGasto(gasto({ categoria: 'PERMISO' }))).toEqual({
      periodo: OCT,
      eje: 'vuelo',
      aviones: [N41],
      general: false,
      hoja_avion: 'permisos',
      hoja_general: null,
    });
  });

  it('INDIRECTO con vuelo ⇒ «Gastos Indirectos»; con inventario ⇒ refacciones / inventario', () => {
    expect(
      ubicacionBalanceDeGasto(gasto({ categoria: 'INDIRECTO' })),
    ).toMatchObject({
      aviones: [N41],
      general: false,
      hoja_avion: 'gastos_indirectos',
      hoja_general: null,
    });
    expect(
      ubicacionBalanceDeGasto(
        gasto({ categoria: 'INDIRECTO', inventario_movimiento_id: 'mi-1' }),
      ),
    ).toMatchObject({
      general: true,
      hoja_avion: 'refacciones',
      hoja_general: 'inventario',
    });
  });

  it('vuelo sin fecha o sin embed ⇒ null', () => {
    expect(
      ubicacionBalanceDeGasto(
        gasto({ vuelo: { fecha_vuelo: null, aeronave_id: N41 } }),
      ),
    ).toBeNull();
    expect(ubicacionBalanceDeGasto(gasto({ vuelo: null }))).toBeNull();
  });

  it('caso #255: sellado a N4142R sin tramo en un vuelo de XA-VGV', () => {
    const g255 = gasto({
      aeronave_id: N41,
      vuelo: {
        fecha_vuelo: '2026-09-12T15:00:00Z',
        aeronave_id: VGV,
        es_externo: false,
      },
    });
    expect(necesitaTramosVivos(g255)).toBe(true);
    expect(
      ubicacionBalanceDeGasto({ ...g255, aviones_con_tramo_vivo: [VGV] }),
    ).toBeNull();
    expect(
      ubicacionBalanceDeGasto({ ...g255, aviones_con_tramo_vivo: [VGV, N41] })
        ?.aviones,
    ).toEqual([N41]);
    // Sin el dato (lectura fallida) no se verifica.
    expect(ubicacionBalanceDeGasto(g255)?.aviones).toEqual([N41]);
    // Con su tramo o con el avión del vuelo, no hace falta verificar.
    expect(necesitaTramosVivos({ ...g255, escala_id: 'e-1' })).toBe(false);
    expect(necesitaTramosVivos(gasto())).toBe(false);
  });

  it('vuelo AÚN sin avión: el sellado solo vive en el libro por un tramo vivo', () => {
    const g = gasto({
      aeronave_id: PEV,
      vuelo: {
        fecha_vuelo: '2026-10-10T15:00:00Z',
        aeronave_id: null,
        es_externo: false,
      },
    });
    expect(necesitaTramosVivos(g)).toBe(true);
    expect(
      ubicacionBalanceDeGasto({ ...g, aviones_con_tramo_vivo: [] }),
    ).toBeNull();
    expect(
      ubicacionBalanceDeGasto({ ...g, aviones_con_tramo_vivo: [PEV] })?.aviones,
    ).toEqual([PEV]);
  });

  it('embeds como arreglo', () => {
    expect(
      ubicacionBalanceDeGasto(
        gasto({
          escala_id: 'e-2',
          escala: [{ aeronave_id: VGV }],
          vuelo: [
            {
              fecha_vuelo: '2026-10-10T21:30:00+00:00',
              aeronave_id: N41,
              es_externo: false,
            },
          ],
        }),
      ),
    ).toMatchObject({ periodo: OCT, aviones: [VGV] });
  });
});

describe('R6 — EXTERNOS sin avión (solo dentro del general)', () => {
  const externo = {
    fecha_vuelo: '2026-10-05T18:00:00Z',
    aeronave_id: null,
    es_externo: true,
  };

  it('OPERACIONES, aunque esté sellado a un avión de flota ⇒ reporte horas FLOTA', () => {
    expect(
      ubicacionBalanceDeGasto(
        gasto({ aeronave_id: PEV, vuelo: externo, fecha_gasto: '2026-09-29' }),
      ),
    ).toEqual({
      periodo: OCT,
      eje: 'vuelo',
      aviones: [],
      general: true,
      hoja_avion: null,
      hoja_general: 'reporte_horas',
    });
  });

  it('PERMISO e INDIRECTO de un externo ⇒ null (el general no los pinta)', () => {
    for (const categoria of ['PERMISO', 'INDIRECTO']) {
      expect(
        ubicacionBalanceDeGasto(gasto({ categoria, vuelo: externo })),
      ).toBeNull();
    }
  });
});

describe('R3 — GAS (hoja «combustible»)', () => {
  it('sellado o por escala ⇒ ese avión, eje gasto, en los dos libros', () => {
    expect(
      ubicacionBalanceDeGasto(
        gasto({ categoria: 'GAS', vuelo_id: null, vuelo: null }),
      ),
    ).toEqual({
      periodo: SEP,
      eje: 'gasto',
      aviones: [N41],
      general: true,
      hoja_avion: 'combustible',
      hoja_general: 'combustible',
    });
    expect(
      ubicacionBalanceDeGasto(
        gasto({
          categoria: 'GAS',
          escala_id: 'e-2',
          escala: { aeronave_id: VGV },
        }),
      ),
    ).toMatchObject({ eje: 'gasto', aviones: [VGV], periodo: SEP });
  });

  it('externo sin avión ⇒ el mes del VUELO aunque la carga sea de otro mes', () => {
    expect(
      ubicacionBalanceDeGasto(
        gasto({
          categoria: 'GAS',
          aeronave_id: null,
          fecha_gasto: '2026-09-30',
          vuelo: {
            fecha_vuelo: '2026-10-02T15:00:00Z',
            aeronave_id: null,
            es_externo: true,
          },
        }),
      ),
    ).toEqual({
      periodo: OCT,
      eje: 'vuelo',
      aviones: [],
      general: true,
      hoja_avion: null,
      hoja_general: 'combustible',
    });
  });

  it('sellado en un externo ⇒ ese avión con eje gasto; sin nada ⇒ null', () => {
    expect(
      ubicacionBalanceDeGasto(
        gasto({
          categoria: 'GAS',
          aeronave_id: PEV,
          vuelo: {
            fecha_vuelo: '2026-10-02T15:00:00Z',
            aeronave_id: null,
            es_externo: true,
          },
        }),
      ),
    ).toMatchObject({ eje: 'gasto', aviones: [PEV], periodo: SEP });
    expect(
      ubicacionBalanceDeGasto(
        sinVuelo({ categoria: 'GAS', aeronave_id: null }),
      ),
    ).toBeNull();
  });
});

describe('R5 — LA CATEGORÍA DE EMPRESA MANDA', () => {
  it('OTRO, NOMINA, GASOLINA, FIJO y VISITA con vuelo y avión ⇒ «otros gastos» del general, eje gasto', () => {
    for (const categoria of ['OTRO', 'NOMINA', 'GASOLINA', 'FIJO', 'VISITA']) {
      expect(ubicacionBalanceDeGasto(gasto({ categoria }))).toEqual({
        periodo: SEP,
        eje: 'gasto',
        aviones: [],
        general: true,
        hoja_avion: null,
        hoja_general: 'otros_gastos',
      });
    }
  });

  it('CATEGORIAS_GASTO_EMPRESA congelada', () => {
    expect([...CATEGORIAS_GASTO_EMPRESA].sort()).toEqual([
      'FIJO',
      'GASOLINA',
      'NOMINA',
      'OTRO',
      'VISITA',
    ]);
  });
});

describe('R7 — sin vuelo: el libro del mes del GASTO', () => {
  it('PERMISO: con avión ⇒ «permisos» sin general; sin nada ⇒ «otros gastos»', () => {
    expect(ubicacionBalanceDeGasto(sinVuelo({ categoria: 'PERMISO' }))).toEqual(
      {
        periodo: SEP,
        eje: 'gasto',
        aviones: [N41],
        general: false,
        hoja_avion: 'permisos',
        hoja_general: null,
      },
    );
    expect(
      ubicacionBalanceDeGasto(
        sinVuelo({ categoria: 'PERMISO', aeronave_id: null }),
      ),
    ).toMatchObject({ aviones: [], hoja_general: 'otros_gastos' });
  });

  it('INDIRECTO y REFACCION: con avión ⇒ «Gastos Indirectos» (inventario ⇒ refacciones); sin nada ⇒ «otros gastos»', () => {
    expect(
      ubicacionBalanceDeGasto(sinVuelo({ categoria: 'INDIRECTO' })),
    ).toMatchObject({
      eje: 'gasto',
      aviones: [N41],
      general: false,
      hoja_avion: 'gastos_indirectos',
    });
    expect(
      ubicacionBalanceDeGasto(
        sinVuelo({ categoria: 'REFACCION', inventario_movimiento_id: 'mi-9' }),
      ),
    ).toMatchObject({
      aviones: [N41],
      hoja_avion: 'refacciones',
      hoja_general: 'inventario',
    });
    expect(
      ubicacionBalanceDeGasto(
        sinVuelo({ categoria: 'INDIRECTO', aeronave_id: null }),
      ),
    ).toMatchObject({
      aviones: [],
      general: true,
      hoja_general: 'otros_gastos',
    });
  });

  it('TUAS sin vuelo ⇒ null (solo «otros movimientos»); sin fecha_gasto ⇒ null', () => {
    expect(ubicacionBalanceDeGasto(sinVuelo({ categoria: 'TUAS' }))).toBeNull();
    expect(ubicacionBalanceDeGasto(sinVuelo({ fecha_gasto: null }))).toBeNull();
  });
});

describe('R4 — REPARTO MANUAL (casos reales)', () => {
  it('INDIRECTO «gestoria cramex sep» $16,240 al 100 % entre 2 aviones ⇒ los dos aviones, sin general', () => {
    expect(
      ubicacionBalanceDeGasto(
        sinVuelo({
          id: '37471011',
          categoria: 'INDIRECTO',
          monto: 16240,
          aeronave_id: null,
          fecha_gasto: '2026-10-07',
        }),
        [
          { aeronave_id: VGV, monto: 8120 },
          { aeronave_id: PEV, monto: 8120 },
        ],
      ),
    ).toEqual({
      periodo: OCT,
      eje: 'gasto',
      aviones: [VGV, PEV],
      general: false,
      hoja_avion: 'gastos_indirectos',
      hoja_general: null,
    });
  });

  it('OTRO $4,733.76 50/50 ⇒ «repartidos a aviones»; con remanente ⇒ «otros gastos»', () => {
    const otro = gasto({
      categoria: 'OTRO',
      monto: 4733.76,
      fecha_gasto: '2026-08-23',
    });
    expect(
      ubicacionBalanceDeGasto(otro, [
        { aeronave_id: N41, monto: 2366.88 },
        { aeronave_id: VGV, monto: 2366.88 },
      ]),
    ).toMatchObject({
      eje: 'gasto',
      periodo: { desde: '2026-08-01', hasta: '2026-08-31' },
      aviones: [N41, VGV],
      general: true,
      hoja_avion: 'gastos_indirectos',
      hoja_general: 'repartidos',
    });
    expect(
      ubicacionBalanceDeGasto(otro, [{ aeronave_id: N41, monto: 2000 }]),
    ).toMatchObject({ hoja_general: 'otros_gastos', aviones: [N41] });
  });

  it('INDIRECTO sellado con remanente ⇒ sin general; sin avión con remanente ⇒ «otros gastos»', () => {
    expect(
      ubicacionBalanceDeGasto(
        sinVuelo({ categoria: 'INDIRECTO', monto: 1000, aeronave_id: N41 }),
        [{ aeronave_id: VGV, monto: 400 }],
      ),
    ).toMatchObject({ aviones: [VGV], general: false, hoja_general: null });
    expect(
      ubicacionBalanceDeGasto(
        sinVuelo({ categoria: 'INDIRECTO', monto: 1000, aeronave_id: null }),
        [{ aeronave_id: VGV, monto: 400 }],
      ),
    ).toMatchObject({
      aviones: [VGV],
      general: true,
      hoja_general: 'otros_gastos',
    });
  });

  it('NOMINA con remanente ⇒ «otros gastos» y la hoja del avión «Gastos Indirectos»', () => {
    expect(
      ubicacionBalanceDeGasto(
        sinVuelo({ categoria: 'NOMINA', monto: 3000, aeronave_id: null }),
        [{ aeronave_id: N41, monto: 1000 }],
      ),
    ).toMatchObject({
      aviones: [N41],
      hoja_avion: 'gastos_indirectos',
      hoja_general: 'otros_gastos',
    });
  });

  it('el reparto de un gasto CON vuelo y categoría que no es de empresa se IGNORA', () => {
    expect(
      ubicacionBalanceDeGasto(gasto({ categoria: 'INDIRECTO' }), [
        { aeronave_id: VGV, monto: 100 },
      ]),
    ).toMatchObject({
      eje: 'vuelo',
      aviones: [N41],
      hoja_avion: 'gastos_indirectos',
    });
  });
});

describe('ALARMA DE PARIDAD con aircraft-balance.service.ts', () => {
  // El espejo imita consultas y reglas del libro: si alguien las cambia,
  // este spec obliga a revisar `ubicacion-balance-gasto.util.ts`. Se compara
  // SIN espacios para que el formato no dispare la alarma.
  const fuente = readFileSync(
    join(__dirname, '..', 'modules', 'aircraft', 'aircraft-balance.service.ts'),
    'utf8',
  ).replace(/\s+/g, '');
  const tiene = (patron: string) =>
    expect(fuente).toContain(patron.replace(/\s+/g, ''));
  const enOrden = (...patrones: string[]) => {
    let desde = 0;
    for (const p of patrones) {
      const i = fuente.indexOf(p.replace(/\s+/g, ''), desde);
      expect(i).toBeGreaterThanOrEqual(0);
      desde = i;
    }
  };

  it('vuelos del mes por fecha_vuelo (día Cancún) y EXTERNOS sin avión', () => {
    tiene(".gte('fecha_vuelo', `${desde}T00:00:00-05:00`)");
    tiene("vuelosQuery.eq('es_externo', true).is('aeronave_id', null)");
    tiene(".eq('aeronave_id', aircraftId).is('cancelada_at', null)");
  });

  it('gastos de los vuelos, sin vuelo del avión y GAS (flota por fecha_gasto; externos sin filtro de fecha)', () => {
    enOrden(".in('vuelo_id', vueloIds)", ".order('fecha_gasto'");
    enOrden(
      ".eq('aeronave_id', aircraftId)",
      ".is('vuelo_id', null)",
      ".gte('fecha_gasto', desde)",
    );
    enOrden(".eq('categoria', 'GAS')", ".gte('fecha_gasto', desde)");
    enOrden(
      ".in('vuelo_id', vueloIds)",
      ".is('aeronave_id', null)",
      ".eq('categoria', 'GAS')",
      '.order(',
    );
  });

  it('la fila del vuelo salta PERMISO/INDIRECTO/GAS y las categorías fuera del avión', () => {
    tiene(
      "g.categoria === 'PERMISO' || g.categoria === 'INDIRECTO' || g.categoria === 'GAS'",
    );
    tiene('if (CAT_FUERA_DEL_AVION.has(g.categoria)) continue;');
    tiene('(g) => avionDelGastoV(g) === aircraftId');
  });

  it('hojas del avión: permisos e INDIRECTO de los vuelos del avión, refacciones por inventario', () => {
    tiene("...gastosVueloDelAvion.filter((g) => g.categoria === 'INDIRECTO')");
    tiene("...gastosVueloDelAvion.filter((g) => g.categoria === 'PERMISO')");
    tiene(
      'filasIndirectosTodas.filter( (g) => g.inventario_movimiento_id != null, )',
    );
  });

  it('«otros gastos» del general: categorías de EMPRESA + sueltos sin vuelo ni avión (sin PERSONAL_DUENO ni GAS); reparto por la fecha del padre', () => {
    tiene(".in('categoria', [...CAT_EMPRESA])");
    enOrden(
      ".is('vuelo_id', null)",
      ".is('aeronave_id', null)",
      ".neq('categoria', 'PERSONAL_DUENO')",
      ".neq('categoria', 'GAS')",
    );
    tiene(".gte('gasto.fecha_gasto', desde)");
  });

  it('los conjuntos compartidos vienen de hojas-balance.util (sin copias locales)', () => {
    tiene("from '../../common/hojas-balance.util'");
    tiene('parcialEntraAlAvion(');
    expect(fuente).not.toContain("newSet(['INDIRECTO','NOMINA'])");
    expect(fuente).not.toContain("newSet(['GAS','PERMISO','TUAS'])");
  });
});
