/**
 * Filas para la columna «Avión» del Excel de gastos (`gasto-avion.util`),
 * con la forma de `list()` (embeds `aeronave` y `repartos` de siempre).
 * Fuera del build (`*spec.ts`) y de jest (no termina en `.spec.ts`): patrón
 * `*.fixture-spec.ts` del repo. Lo comparten `gasto-avion.util.spec`,
 * `gasto-avion.paridad.spec` y `expenses.service.xlsx.spec`.
 *
 * `FILAS_REALES`: gastos REALES de prod (SELECT por MCP, 15-oct-2026; la
 * NÓMINA, 16-oct-2026), solo con los campos que lee la columna (sin notas).
 * Ese día el Excel cambiaba 296 de 1,144 celdas; las 848 restantes ya
 * decían la matrícula.
 */
import { CATEGORIA_GASTO_LABEL } from '../../common/categoria-gasto.util';

export type FilaGasto = Record<string, unknown>;

/** Aviones de la flota (ids reales). */
export const AV = {
  N4142R: '5a82eb4a-086c-4058-97bd-b2aacdc2e942',
  N621TX: 'e1a85e5b-9eaa-4367-9920-68d5d78883e8',
  N990GG: '8f37ec37-965a-42a8-bac4-9991d282f0a3',
  XA_VGV: '3d0546c3-941f-45cc-b8a9-e3ee77545e68',
  XB_PEV: 'a0114a3e-9919-41e8-b8e4-fa433d3f3737',
} as const;

/** Parte de un reparto como la manda el embed. */
export function parte(
  aeronaveId: string,
  monto: number | string,
  matricula: string | null,
): FilaGasto {
  return {
    aeronave_id: aeronaveId,
    monto,
    aeronave: matricula == null ? null : { matricula },
  };
}

interface CasoReal {
  /** Para qué está en la lista (id corto de prod). */
  nombre: string;
  fila: FilaGasto;
  /** Lo que decía el Excel hasta el 0.0.77. */
  antes: string;
  /** Lo que dice la tabla del panel (y desde hoy el Excel). */
  celda: string;
}

function real(
  id: string,
  categoria: string,
  monto: number,
  extra: FilaGasto = {},
): FilaGasto {
  return {
    id,
    categoria,
    monto,
    moneda: 'MXN',
    aeronave_id: null,
    aeronave: null,
    vuelo_id: null,
    vuelo: null,
    repartos: [],
    ...extra,
  };
}

export const FILAS_REALES: readonly CasoReal[] = [
  {
    nombre: 'e23b5587 STARLINK 1-sep, INDIRECTO repartido 3 × $1,577.92',
    fila: real('e23b5587-9b16-496f-bc36-bf158eae4ad9', 'INDIRECTO', 4733.76, {
      repartos: [
        parte(AV.N4142R, 1577.92, 'N4142R'),
        parte(AV.N621TX, 1577.92, 'N621TX'),
        parte(AV.N990GG, 1577.92, 'N990GG'),
      ],
    }),
    antes: 'Repartido (3)',
    celda: 'Repartido: N4142R, N621TX, N990GG',
  },
  {
    nombre: '4380fd59 OTRO $890 entre los 5 aviones',
    fila: real('4380fd59-6d79-4551-9cdc-7d487b9c58c5', 'OTRO', 890, {
      repartos: [
        parte(AV.N4142R, 178, 'N4142R'),
        parte(AV.N621TX, 178, 'N621TX'),
        parte(AV.N990GG, 178, 'N990GG'),
        parte(AV.XA_VGV, 178, 'XA-VGV'),
        parte(AV.XB_PEV, 178, 'XB-PEV'),
      ],
    }),
    antes: 'Repartido (5)',
    celda: 'Repartido: N4142R, N621TX, N990GG, XA-VGV, XB-PEV',
  },
  {
    nombre: 'af52d6f4 INDIRECTO repartido COMPLETO a un solo avión',
    fila: real('af52d6f4-d6fd-42a2-96f8-b674e5313cf8', 'INDIRECTO', 1161.52, {
      repartos: [parte(AV.N621TX, 1161.52, 'N621TX')],
    }),
    antes: 'Repartido (1)',
    celda: 'Repartido: N621TX',
  },
  {
    nombre: '37471011 INDIRECTO 50/50 (gestoría)',
    fila: real('37471011-d654-41eb-a608-53a17311161c', 'INDIRECTO', 16240, {
      repartos: [
        parte(AV.XA_VGV, 8120, 'XA-VGV'),
        parte(AV.XB_PEV, 8120, 'XB-PEV'),
      ],
    }),
    antes: 'Repartido (2)',
    celda: 'Repartido: XA-VGV, XB-PEV',
  },
  {
    nombre: 'fa07d1bb OTRO con vuelo #436 y XB-PEV sellado',
    fila: real('fa07d1bb-e990-4004-b7fd-9c8d8dd9e509', 'OTRO', 67, {
      aeronave_id: AV.XB_PEV,
      aeronave: { matricula: 'XB-PEV' },
      vuelo_id: '25c66388-e66f-42f9-9ab9-5c8cc426c6c2',
      vuelo: { folio: 436 },
    }),
    antes: 'XB-PEV',
    celda: 'VuelaTour (ref. XB-PEV)',
  },
  {
    nombre: '9626cb9e «Comisión del vendedor (VuelaTour)» del #332 (N621TX)',
    fila: real(
      '9626cb9e-dae4-4354-bf76-b092e919115a',
      'COMISION_VENDEDOR',
      1305,
      {
        aeronave_id: AV.N621TX,
        aeronave: { matricula: 'N621TX' },
        vuelo_id: '6f1825e3-0c54-45f1-bb66-d8f27a71fb7e',
        vuelo: { folio: 332 },
      },
    ),
    antes: 'N621TX',
    celda: 'VuelaTour (ref. N621TX)',
  },
  {
    nombre:
      '83642790 INDIRECTO con XB-PEV (crédito del motor): SÍ es del avión',
    fila: real('83642790-60db-40af-a570-6cd4661f5202', 'INDIRECTO', 21691.44, {
      aeronave_id: AV.XB_PEV,
      aeronave: { matricula: 'XB-PEV' },
    }),
    antes: 'XB-PEV',
    celda: 'XB-PEV',
  },
  {
    nombre: 'aab45e4a INDIRECTO $100 con N621TX',
    fila: real('aab45e4a-6dbd-4343-ba66-4631279dd2ef', 'INDIRECTO', 100, {
      aeronave_id: AV.N621TX,
      aeronave: { matricula: 'N621TX' },
    }),
    antes: 'N621TX',
    celda: 'N621TX',
  },
  {
    nombre: '16b13a3c OTRO sin avión (CFE de la oficina)',
    fila: real('16b13a3c-a936-41ad-aa2f-2632bd1f2b6a', 'OTRO', 2763),
    antes: '(pendiente)',
    celda: 'VuelaTour',
  },
  {
    nombre: '43a21812 gasto personal del dueño',
    fila: real('43a21812-a972-4983-bb6b-d8d4f13d09c1', 'PERSONAL_DUENO', 1681),
    antes: '(pendiente)',
    celda: 'Personal',
  },
  {
    // 16-oct-2026 (invariante 91): NÓMINA sin reparto — no entra a ningún
    // balance hasta repartirla en el módulo Nómina.
    nombre: 'e0e069f3 NÓMINA $27,500 del 15-oct sin repartir',
    fila: real('e0e069f3-5def-499e-b87c-c95160fc6b66', 'NOMINA', 27500),
    antes: '(pendiente)',
    celda: 'Sin repartir',
  },
  {
    nombre: '0f5e6659 SERVICIOS sin avión: pendiente de verdad',
    fila: real('0f5e6659-2c39-40d0-89d5-3fbd8d98537d', 'SERVICIOS', 3800),
    antes: '(pendiente)',
    celda: 'Falta avión',
  },
];

// ------------------------- matriz de combinaciones -------------------------

/** Las 22 categorías del enum + códigos raros (legado, prefijos, vacíos). */
export const CATEGORIAS_MATRIZ: ReadonlyArray<string | null | undefined> = [
  ...Object.keys(CATEGORIA_GASTO_LABEL),
  'otro',
  'COMISION_VENDEDOR_AVIONX',
  'COMISION',
  '',
  null,
  undefined,
];

const AVIONES_MATRIZ: readonly FilaGasto[] = [
  { aeronave_id: null, aeronave: null },
  { aeronave_id: AV.N4142R, aeronave: { matricula: 'N4142R' } },
  // Sin fila en el join / matrícula null: no ocurre en prod (FK y NOT NULL).
  { aeronave_id: AV.XB_PEV, aeronave: null },
  { aeronave_id: AV.N621TX, aeronave: { matricula: null } },
  // Embed sin id: manda `aeronave_id` (como en la tabla).
  { aeronave_id: null, aeronave: { matricula: 'XA-VGV' } },
  { aeronave_id: '', aeronave: null },
];

const VUELOS_MATRIZ: readonly FilaGasto[] = [
  { vuelo_id: null, vuelo: null },
  { vuelo_id: 'v-437', vuelo: { folio: 437 } },
];

const REPARTOS_MATRIZ: readonly FilaGasto[] = [
  { monto: 1000 }, // la llave `repartos` no viene
  { monto: 1000, repartos: null },
  { monto: '1000.00', repartos: [] },
  {
    monto: 4733.76,
    repartos: [
      parte(AV.N4142R, 1577.92, 'N4142R'),
      parte(AV.N621TX, '1577.92', 'N621TX'),
      parte(AV.N990GG, 1577.92, 'N990GG'),
    ],
  },
  // Remanente de $400: lo absorbe VuelaTour.
  {
    monto: '1000.00',
    repartos: [
      parte(AV.N4142R, '300.00', 'N4142R'),
      parte(AV.N621TX, 300, 'N621TX'),
    ],
  },
  // 3 × 33.33 de $100: remanente EXACTO de un centavo; partes sin matrícula.
  {
    monto: '100.00',
    repartos: [
      parte(AV.N4142R, '33.33', null),
      parte(AV.N621TX, '33.33', null),
      { aeronave_id: AV.N990GG, monto: '33.33' },
    ],
  },
  // Partes que suman MÁS que el monto (ticket + propina): sin remanente.
  { monto: 1000, repartos: [parte(AV.XA_VGV, '1050.00', 'XA-VGV')] },
  {
    monto: 890,
    repartos: [
      parte(AV.N4142R, 178, 'N4142R'),
      parte(AV.N621TX, 178, 'N621TX'),
      parte(AV.N990GG, 178, 'N990GG'),
      parte(AV.XA_VGV, 178, 'XA-VGV'),
      parte(AV.XB_PEV, 178, 'XB-PEV'),
    ],
  },
  { monto: 1161.52, repartos: [parte(AV.N621TX, 1161.52, 'N621TX')] },
  { monto: 100, repartos: [parte(AV.XB_PEV, 99.99, 'XB-PEV')] },
];

/**
 * Producto cartesiano categoría × avión × vuelo × reparto (28 × 6 × 2 × 10
 * = 3,360 filas). Incluye combinaciones que la BD no permite (reparto en una
 * categoría que no se reparte): la columna debe decir lo mismo que la tabla
 * con CUALQUIER fila que le llegue.
 */
export function matrizAvionGasto(): FilaGasto[] {
  const out: FilaGasto[] = [];
  let i = 0;
  for (const categoria of CATEGORIAS_MATRIZ) {
    for (const avion of AVIONES_MATRIZ) {
      for (const vuelo of VUELOS_MATRIZ) {
        for (const reparto of REPARTOS_MATRIZ) {
          i += 1;
          out.push({
            id: `g-${i}`,
            ...(categoria === undefined ? {} : { categoria }),
            moneda: 'MXN',
            ...avion,
            ...vuelo,
            ...reparto,
          });
        }
      }
    }
  }
  return out;
}
