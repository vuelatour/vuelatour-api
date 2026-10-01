// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));

import { ProfitSharingService } from './profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * REPARTO A SOCIOS — **la categoría de EMPRESA manda sobre el vuelo**
 * (regla del cliente, 11-sep-2026; MISMA regla y MISMA fuente única
 * `categoriaEsDeEmpresa` que el Balance por avión y el Libro Dinero).
 *
 * Antes, 'OTRO' vivía en el set DIRECTO: un comisariato capturado CON vuelo
 * restaba a la utilidad del socio mientras el Balance ya lo mandaba a la
 * hoja "otros gastos" del Balance general. Dos libros del mismo cierre, dos
 * números — exactamente lo que no puede pasar.
 *
 * Lo que NO cambia: los PARCIALES de un reparto manual sí son del avión de
 * cada parte, y el pool de FIJO se sigue prorrateando entre la flota (doc
 * 4.8): ese prorrateo no nace del vuelo/avión sellado del gasto.
 */
type Fila = Record<string, unknown>;

const AV = 'av-1';
const OTRO_AVION = 'av-2';
const VUELO = 'v-1';

function armar() {
  const supabase = {
    service: { from: () => ({}) },
  } as unknown as SupabaseService;
  const nada = {} as never;
  return new ProfitSharingService(supabase, nada, nada, nada);
}

type Privado = {
  computeAvion: (
    a: { id: string; matricula: string; modelo: string },
    ctx: Record<string, unknown>,
  ) => {
    gastos: { directos_usd: number; indirectos_usd: number };
    detalle: {
      gastos_por_categoria: Array<{
        categoria: string;
        grupo: string;
        usd: number;
      }>;
    };
  };
};

const gastoBase = {
  escala_id: null,
  aeronave_id: AV,
  vuelo_id: null,
  moneda: 'USD',
  tc_gasto: null,
  propina: null,
  valor_ia_extraido: null,
  fecha_gasto: '2026-09-10',
};

/** computeAvion con el mundo mínimo: solo los gastos importan aquí. */
function computar(gastos: Fila[]) {
  const service = armar();
  return (service as unknown as Privado).computeAvion(
    { id: AV, matricula: 'XB-TST', modelo: 'C206' },
    {
      vuelos: [],
      cobrosPorVuelo: new Map(),
      horasPorAvion: new Map(),
      participacionPorVuelo: new Map(),
      escalaPorId: new Map(),
      escalasPorVuelo: new Map(),
      // El vuelo #501 vuela en ESTE avión: sin la regla nueva, un gasto de
      // empresa ligado a él se resolvería a `AV` y restaría aquí.
      vueloAvion: new Map([[VUELO, AV]]),
      matriculas: new Map([
        [AV, 'XB-TST'],
        [OTRO_AVION, 'XA-OTR'],
      ]),
      clientes: new Map(),
      gastos,
      socios: [],
      reservas: [],
      nombres: new Map(),
      otrosPorAvion: 0,
      periodo: { desde: '2026-09-01', hasta: '2026-09-30' },
      tcOficialVuelo: new Map(),
      tcOficialGasto: new Map(),
    },
  );
}

/** Fila del detalle por clave de categoría ("OTRO", "OTRO (repartido)"…). */
function fila(
  r: ReturnType<Privado['computeAvion']>,
  clave: string,
): { grupo: string; usd: number } | undefined {
  return r.detalle.gastos_por_categoria.find((x) => x.categoria === clave);
}

describe('Reparto a socios — la categoría de EMPRESA manda sobre el vuelo (11-sep-2026)', () => {
  it('un OTRO CON vuelo NO resta al avión (antes era gasto DIRECTO)', () => {
    const r = computar([
      {
        ...gastoBase,
        id: 'g-otro',
        categoria: 'OTRO',
        monto: 1000,
        vuelo_id: VUELO,
      },
      // Control: una categoría del vuelo sí resta, con el mismo vuelo.
      {
        ...gastoBase,
        id: 'g-op',
        categoria: 'OPERACIONES',
        monto: 300,
        vuelo_id: VUELO,
      },
    ]);
    expect(r.gastos.directos_usd).toBe(300);
    expect(fila(r, 'OPERACIONES')).toMatchObject({ grupo: 'DIRECTO' });
    // Sigue LISTADO (transparencia: el dinero no desaparece del detalle),
    // pero en el grupo EXCLUIDO — no suma a ningún agregado del avión.
    expect(fila(r, 'OTRO')).toMatchObject({ grupo: 'EXCLUIDO', usd: 1000 });
  });

  it('NOMINA/GASOLINA/FIJO/VISITA con avión sellado tampoco restan', () => {
    const r = computar(
      ['NOMINA', 'GASOLINA', 'FIJO', 'VISITA'].map((categoria, i) => ({
        ...gastoBase,
        id: `g-${i}`,
        categoria,
        monto: 500,
      })),
    );
    expect(r.gastos.directos_usd).toBe(0);
    expect(r.gastos.indirectos_usd).toBe(0);
    for (const c of ['NOMINA', 'GASOLINA', 'FIJO', 'VISITA']) {
      expect(fila(r, c)).toMatchObject({ grupo: 'EXCLUIDO' });
    }
  });

  it('las PARTES de un reparto manual SÍ van al avión (el reparto gana)', () => {
    const r = computar([
      {
        ...gastoBase,
        id: 'g-otro',
        categoria: 'OTRO',
        monto: 600,
        es_reparto_parcial: true,
      },
    ]);
    // Parcial de una categoría de empresa = "otros gastos" del avión (mismo
    // grupo que INDIRECTO/NOMINA/GASOLINA repartidos).
    expect(r.gastos.indirectos_usd).toBe(600);
    expect(fila(r, 'OTRO (repartido)')).toMatchObject({ grupo: 'INDIRECTO' });
  });

  it('el TUA embebido de un gasto de EMPRESA no se descuenta (no hay de dónde)', () => {
    // Factura de aeródromo capturada como OTRO: entra ENTERA a la hoja
    // "otros gastos" del general, así que restarle aquí su TUA embebido
    // sería una deducción fantasma (y doble conteo entre libros).
    const r = computar([
      {
        ...gastoBase,
        id: 'g-otro-tua',
        categoria: 'OTRO',
        monto: 1000,
        vuelo_id: VUELO,
        valor_ia_extraido: {
          conceptos: [
            { concepto: 'Tarifa TUA', monto: 600 },
            { concepto: 'Operaciones', monto: 400 },
          ],
        },
      },
    ]);
    expect(fila(r, 'OTRO')).toMatchObject({ grupo: 'EXCLUIDO', usd: 1000 });
    expect(fila(r, 'TUA embebido (excluido)')).toBeUndefined();
  });

  it('control: la MISMA factura como OPERACIONES sí descuenta su TUA embebido', () => {
    const r = computar([
      {
        ...gastoBase,
        id: 'g-op-tua',
        categoria: 'OPERACIONES',
        monto: 1000,
        vuelo_id: VUELO,
        valor_ia_extraido: {
          conceptos: [
            { concepto: 'Tarifa TUA', monto: 600 },
            { concepto: 'Operaciones', monto: 400 },
          ],
        },
      },
    ]);
    expect(r.gastos.directos_usd).toBe(400);
    expect(fila(r, 'TUA embebido (excluido)')).toMatchObject({ usd: 600 });
  });
});

/**
 * PAGO AL VENDEDOR (COMISION_VENDEDOR, 28-sep-2026, invariante 31): jamás es
 * costo del avión — grupo EXCLUIDO explícito, con una clave de detalle que
 * EMPIEZA con el código (espejo de `TUAS (egreso VuelaTour — Otros
 * movimientos)`) para que la etiqueta derivada conserve el sufijo.
 */
describe('Reparto a socios — la comisión del vendedor NO es costo del avión (28-sep-2026)', () => {
  const op: Fila = {
    ...gastoBase,
    id: 'g-op',
    categoria: 'OPERACIONES',
    monto: 300,
    vuelo_id: VUELO,
  };
  const comisionVendedor: Fila = {
    ...gastoBase,
    id: 'g-cv',
    categoria: 'COMISION_VENDEDOR',
    monto: 116,
    vuelo_id: VUELO,
  };

  it('grupo EXCLUIDO con la clave «COMISION_VENDEDOR (egreso VuelaTour — Otros movimientos)» y su etiqueta', () => {
    const r = computar([op, comisionVendedor]);
    const f = r.detalle.gastos_por_categoria.find(
      (x) =>
        x.categoria ===
        'COMISION_VENDEDOR (egreso VuelaTour — Otros movimientos)',
    ) as { grupo: string; usd: number; etiqueta?: string } | undefined;
    expect(f).toMatchObject({ grupo: 'EXCLUIDO', usd: 116 });
    expect(f!.etiqueta).toBe(
      'Comisión del vendedor (egreso VuelaTour — Otros movimientos)',
    );
  });

  it('la utilidad del avión es IDÉNTICA al caso sin el gasto (solo cambia la fila informativa del detalle)', () => {
    const sin = computar([op]);
    const con = computar([op, comisionVendedor]);
    expect(con.gastos).toEqual(sin.gastos);
    const sinFilaInformativa = {
      ...con,
      detalle: {
        ...con.detalle,
        gastos_por_categoria: con.detalle.gastos_por_categoria.filter(
          (x) => !x.categoria.startsWith('COMISION_VENDEDOR'),
        ),
      },
    };
    expect(JSON.stringify(sinFilaInformativa)).toBe(JSON.stringify(sin));
  });
});

/**
 * EXTENSIÓN DE HORARIO EMBEBIDA (1-oct-2026, caso #192): se descuenta del
 * costo del avión IGUAL que el TUA embebido (fuente única
 * `trasladosEmbebidosDeGasto`) y sale en su fila informativa
 * «Extensión de horario (excluido)» — solo cuando hubo.
 */
describe('Reparto a socios — la extensión de horario NO es costo del avión (1-oct-2026)', () => {
  const op: Fila = {
    ...gastoBase,
    id: 'g-op',
    categoria: 'OPERACIONES',
    monto: 300,
    vuelo_id: VUELO,
  };
  const ext192: Fila = {
    ...gastoBase,
    id: 'g-ext-192',
    categoria: 'OPERACIONES',
    monto: 4549.06,
    vuelo_id: VUELO,
    valor_ia_extraido: {
      conceptos: [
        { concepto: 'AE-Extension y/o antelacion de horario', monto: 3921.6 },
        { concepto: 'IVA 16%', monto: 627.46 },
      ],
    },
  };

  it('#192: la factura de extensión no resta; su fila informativa la muestra', () => {
    const r = computar([op, ext192]);
    expect(r.gastos.directos_usd).toBe(300);
    expect(fila(r, 'Extensión de horario (excluido)')).toMatchObject({
      grupo: 'EXCLUIDO',
      usd: 4549.06,
    });
    expect(fila(r, 'TUA embebido (excluido)')).toBeUndefined();
  });

  it('#314 por notas (sin IA): tampoco resta', () => {
    const r = computar([
      op,
      {
        ...gastoBase,
        id: 'g-ext-314',
        categoria: 'OPERACIONES',
        monto: 500,
        vuelo_id: VUELO,
        notas: 'extensión de servicio inspector Baraona $500 efectivo',
      },
    ]);
    expect(r.gastos.directos_usd).toBe(300);
    expect(fila(r, 'Extensión de horario (excluido)')).toMatchObject({
      usd: 500,
    });
  });

  it('sin extensiones el detalle NO lleva la fila nueva (idéntico a antes)', () => {
    const r = computar([op]);
    expect(fila(r, 'Extensión de horario (excluido)')).toBeUndefined();
  });

  it('capturada como OTRO (empresa): EXCLUIDO entero, sin descuento fantasma', () => {
    const r = computar([op, { ...ext192, id: 'g-otro', categoria: 'OTRO' }]);
    expect(r.gastos.directos_usd).toBe(300);
    expect(fila(r, 'OTRO')).toMatchObject({ grupo: 'EXCLUIDO', usd: 4549.06 });
    expect(fila(r, 'Extensión de horario (excluido)')).toBeUndefined();
  });
});
