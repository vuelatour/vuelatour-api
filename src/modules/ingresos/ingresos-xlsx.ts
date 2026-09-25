/**
 * Excel de INGRESOS (24-sep-2026) — payload PURO para el export genérico de
 * pyservices (`/pdf/tabla-xlsx` con `hojas`, sin endpoint nuevo). Todo llega
 * YA calculado (resumen, ingresos, cobros, anticipos); aquí solo se acomoda.
 *
 * Reglas: montos NOMINALES por moneda (jamás se suman MXN con USD: cada fila
 * dice su moneda y el Resumen va una fila por moneda), fechas dd/mm/aaaa y
 * lo SIN conciliar resaltado en naranja.
 */
import type { TablaXlsxPayload } from '../pyservices/pyservices.service';
import { CATEGORIA_INGRESO_DESTINO } from '../../common/categoria-ingreso.util';
import type {
  EntradaDinero,
  EstadoConciliacionEntrada,
  Ingreso,
  ResumenIngresos,
} from './ingresos.types';

/** 'YYYY-MM-DD' (o ISO) ⇒ 'dd/mm/aaaa' ('' si no es una fecha). */
export function ddmmaaaa(dia: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dia ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Etiqueta del estado de conciliación (misma que pinta el panel). */
export const ETIQUETA_CONCILIACION_EXCEL: Record<
  EstadoConciliacionEntrada,
  string
> = {
  CONCILIADO: 'Conciliado',
  SIN_CONCILIAR: 'Sin conciliar',
  NO_BANCARIO: 'No se concilia uno a uno',
  VIA_ANTICIPO: 'Conciliado vía anticipo',
};

const texto = (label: string) => ({ label, tipo: 'texto' as const });
const money = (label: string) => ({ label, tipo: 'money' as const });
const entero = (label: string) => ({ label, tipo: 'entero' as const });

export const COLUMNAS_RESUMEN: TablaXlsxPayload['columnas'] = [
  texto('Moneda'),
  money('Cobros de vuelos'),
  money('Reembolsos a clientes'),
  money('Cobros conciliados'),
  money('Cobros sin conciliar'),
  money('Cobros que no pasan por el banco'),
  money('De ellos, depósitos de vuelos por volar'),
  money('Aplicado de anticipos (no suma)'),
  money('Otros ingresos'),
  money('Anticipos recibidos'),
  money('Anticipos aplicados'),
  money('Anticipos por aplicar'),
  money('Aportaciones y préstamos'),
  money('Dinero que entró'),
  money('Neto de reembolsos'),
  entero('Abonos del banco por identificar'),
  money('Monto por identificar'),
];

export const COLUMNAS_INGRESOS: TablaXlsxPayload['columnas'] = [
  texto('ING'),
  texto('Fecha'),
  texto('Categoría'),
  texto('Destino'),
  texto('Concepto'),
  texto('Cliente / Pagador'),
  texto('Cuenta'),
  texto('Método'),
  texto('Moneda'),
  money('Monto'),
  money('Comisión'),
  money('Neto'),
  { label: 'T.C.', tipo: 'numero' },
  texto('Conciliación'),
  texto('Vuelo'),
  texto('Matrícula'),
  texto('Registró'),
  texto('Notas'),
];
const COL_MONTO_INGRESO = 9;

export const COLUMNAS_COBROS: TablaXlsxPayload['columnas'] = [
  texto('Fecha'),
  texto('Vuelo'),
  texto('Cliente'),
  texto('Método'),
  texto('Moneda'),
  money('Monto'),
  money('Comisión'),
  money('Neto'),
  texto('Conciliación'),
  texto('Anticipo'),
  texto('Registró'),
];
const COL_MONTO_COBRO = 5;

export const COLUMNAS_ANTICIPOS: TablaXlsxPayload['columnas'] = [
  texto('ING'),
  texto('Fecha'),
  texto('Cliente'),
  texto('Moneda'),
  money('Monto'),
  money('Aplicado'),
  money('Saldo'),
  texto('Vuelos'),
];

/** Una fila del Excel por ingreso (mismo orden de columnas). */
export function filaExcelIngreso(i: Ingreso): (string | number | null)[] {
  return [
    i.etiqueta,
    ddmmaaaa(i.fecha),
    i.categoria_etiqueta,
    CATEGORIA_INGRESO_DESTINO[i.categoria] ?? '',
    i.descripcion,
    i.cliente_nombre ?? i.pagador ?? '',
    i.cuenta ? `${i.cuenta.alias} · ${i.cuenta.banco}` : 'Efectivo / caja',
    i.metodo_etiqueta,
    i.moneda,
    i.monto,
    i.comision_monto,
    i.neto,
    i.tc_usd_mxn,
    ETIQUETA_CONCILIACION_EXCEL[i.conciliacion.estado],
    i.vuelo_folio != null ? `#${i.vuelo_folio}` : '',
    i.matricula ?? '',
    i.registrado_por_nombre ?? '',
    i.notas ?? '',
  ];
}

/** Una fila por cobro de vuelo (reembolsos en negativo, como en el vuelo). */
export function filaExcelCobro(e: EntradaDinero): (string | number | null)[] {
  return [
    ddmmaaaa(e.dia),
    e.etiqueta,
    e.cliente_nombre ?? '',
    e.metodo_etiqueta,
    e.moneda,
    e.monto,
    e.comision,
    e.neto,
    ETIQUETA_CONCILIACION_EXCEL[e.conciliacion.estado],
    e.anticipo_etiqueta ?? '',
    e.registrado_por_nombre ?? '',
  ];
}

export interface EntradaExcelIngresos {
  desde: string;
  hasta: string;
  resumen: ResumenIngresos;
  ingresos: Ingreso[];
  cobros: EntradaDinero[];
  anticipos: Ingreso[];
  /** anticipo_id ⇒ folios de los vuelos a los que se aplicó. */
  vuelosPorAnticipo: ReadonlyMap<string, number[]>;
}

/** Payload de pyservices (4 hojas). */
export function payloadExcelIngresos(
  p: EntradaExcelIngresos,
): TablaXlsxPayload {
  const periodo = `${ddmmaaaa(p.desde)} a ${ddmmaaaa(p.hasta)}`;
  const resumenFilas = p.resumen.por_moneda.map((m) => [
    m.moneda,
    m.cobros_vuelo.recibido,
    m.cobros_vuelo.reembolsos,
    m.cobros_vuelo.conciliado,
    m.cobros_vuelo.sin_conciliar,
    m.cobros_vuelo.no_bancario,
    m.depositos_por_volar.monto,
    m.aplicado_de_anticipos.monto,
    m.otros_ingresos.monto,
    m.anticipos.recibido,
    m.anticipos.aplicado,
    m.anticipos.saldo,
    m.fuera_de_resultados.monto,
    m.total_recibido,
    m.neto_de_reembolsos,
    m.abonos_por_identificar.n,
    m.abonos_por_identificar.monto,
  ]);
  const ingresosFilas = p.ingresos.map(filaExcelIngreso);
  const cobrosFilas = p.cobros.map(filaExcelCobro);
  const anticiposFilas = p.anticipos.map((a) => [
    a.etiqueta,
    ddmmaaaa(a.fecha),
    a.cliente_nombre ?? a.pagador ?? '',
    a.moneda,
    a.monto,
    a.anticipo?.aplicado ?? 0,
    a.anticipo?.saldo ?? a.monto,
    (p.vuelosPorAnticipo.get(a.id) ?? []).map((f) => `#${f}`).join(', '),
  ]);
  return {
    titulo: 'Ingresos',
    subtitulo: periodo,
    columnas: [texto('Resumen')],
    filas: [],
    hojas: [
      {
        titulo: 'Resumen',
        subtitulo: `Dinero que entró (no es utilidad: incluye anticipos y préstamos) · por fecha de pago, hora Cancún · los totales NO convierten monedas · ${periodo}`,
        columnas: COLUMNAS_RESUMEN,
        filas: resumenFilas,
      },
      {
        titulo: 'Ingresos',
        subtitulo: `${ingresosFilas.length} ingresos registrados (no son cobros de vuelos) · ${periodo}`,
        columnas: COLUMNAS_INGRESOS,
        filas: ingresosFilas,
        resaltes: p.ingresos
          .map((i, fila) =>
            i.conciliacion.estado === 'SIN_CONCILIAR'
              ? { fila, col: COL_MONTO_INGRESO }
              : null,
          )
          .filter((x): x is { fila: number; col: number } => x !== null),
      },
      {
        titulo: 'Cobros de vuelos',
        subtitulo: `${cobrosFilas.length} cobros de vuelos (se registran en cada vuelo) · los aplicados de un anticipo no suman otra vez · ${periodo}`,
        columnas: COLUMNAS_COBROS,
        filas: cobrosFilas,
        resaltes: p.cobros
          .map((e, fila) =>
            e.conciliacion.estado === 'SIN_CONCILIAR'
              ? { fila, col: COL_MONTO_COBRO }
              : null,
          )
          .filter((x): x is { fila: number; col: number } => x !== null),
      },
      {
        titulo: 'Anticipos',
        subtitulo: `${anticiposFilas.length} anticipos de clientes (fuera de resultados hasta aplicarse a un vuelo) · ${periodo}`,
        columnas: COLUMNAS_ANTICIPOS,
        filas: anticiposFilas,
      },
    ],
  };
}

/** Nombre del archivo: «Ingresos 2026-09-01 a 2026-09-30.xlsx». */
export function nombreArchivoIngresos(desde: string, hasta: string): string {
  return `Ingresos ${desde} a ${hasta}.xlsx`;
}
