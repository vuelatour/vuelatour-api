import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CajaChicaService } from './caja-chica.service';
import {
  COLUMNAS_EXCEL_CAJA,
  dispositionXlsx,
  fechaDmy,
  nombreArchivoCaja,
} from './caja-chica-reposicion-xlsx';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  CajaChicaReposicionPayload,
  PyservicesService,
  TablaXlsxPayload,
} from '../pyservices/pyservices.service';
import { hoyCancun } from '../../common/fecha-cancun.util';

/**
 * EXCEL DE LA REPOSICIÓN de caja chica (24-sep-2026). Pedido del cliente:
 * «al momento de reembolsar la caja de cada uno, me puede arrojar un Excel
 * descargable con la información de lo que estoy reembolsando».
 *
 * Libro SINTÉTICO (caja ACUMULADA de un piloto) con dos reposiciones, gastos
 * en medio, un AJUSTE y un REINTEGRO. Se congela qué filas lleva el Excel de
 * cada reposición y del pendiente — en el orden del libro, con los saldos
 * del historial — y los candados (404 / 409 / 503).
 */

const FONDO = 'f-luis';
const MADRE = 'f-mari';

type Fila = Record<string, unknown>;

const movimientos: Fila[] = [
  {
    id: 'r1',
    fondo_id: FONDO,
    tipo: 'REPOSICION',
    monto: 500,
    moneda: 'MXN',
    fecha: '2026-09-05',
    referencia: null,
    notas: 'reembolso del 01 al 05 de septiembre',
    espejo_de_id: null,
    created_at: '2026-09-05T15:00:00+00:00',
    autorizado: { nombre: 'Ale' },
    registrado: { nombre: 'Mari' },
  },
  {
    id: 'aj',
    fondo_id: FONDO,
    tipo: 'AJUSTE',
    monto: -20,
    moneda: 'MXN',
    fecha: '2026-09-07',
    referencia: null,
    notas: 'faltante del conteo',
    espejo_de_id: null,
    created_at: '2026-09-07T15:00:00+00:00',
    autorizado: null,
    registrado: { nombre: 'Mari' },
  },
  {
    id: 'ri',
    fondo_id: FONDO,
    tipo: 'REINTEGRO',
    monto: 30,
    moneda: 'MXN',
    fecha: '2026-09-09',
    referencia: 'Regresó cambio',
    notas: null,
    espejo_de_id: null,
    created_at: '2026-09-09T15:00:00+00:00',
    autorizado: null,
    registrado: { nombre: 'Mari' },
  },
  {
    id: 'r2',
    fondo_id: FONDO,
    tipo: 'REPOSICION',
    monto: 600,
    moneda: 'MXN',
    fecha: '2026-09-10',
    referencia: 'Transferencia 123',
    notas: 'reembolso del 06 al 10 de septiembre',
    espejo_de_id: null,
    created_at: '2026-09-10T15:00:00+00:00',
    autorizado: { nombre: 'Ale' },
    registrado: [{ nombre: 'Mari' }],
  },
];

const gasto = (
  id: string,
  fecha: string,
  monto: number,
  extra: Fila = {},
): Fila => ({
  id,
  monto,
  moneda: 'MXN',
  fecha_gasto: fecha,
  categoria: 'ALIMENTOS',
  lugar: null,
  notas: null,
  vuelo_id: null,
  created_at: `${fecha}T12:00:00+00:00`,
  vuelo: null,
  ...extra,
});

const gastos: Fila[] = [
  gasto('g1', '2026-09-01', 300, {
    categoria: 'TAXI',
    lugar: 'MID',
    notas: 'Taxi al FBO\n[sello de captura]',
    vuelo_id: 'v-1',
    vuelo: { folio: 297 },
  }),
  gasto('g2', '2026-09-03', 200),
  // Mismo día que r1 pero capturado DESPUÉS de registrarla: entra en r1.
  gasto('g4', '2026-09-05', 50, { created_at: '2026-09-05T22:00:00+00:00' }),
  gasto('g3', '2026-09-06', 100),
  gasto('g5', '2026-09-08', 400),
  gasto('g6', '2026-09-11', 70),
  // Otra moneda: no es de este fondo.
  gasto('g-usd', '2026-09-08', 40, { moneda: 'USD' }),
];

/** Datos de presentación (la consulta aparte por id). */
const extras: Fila[] = gastos.map((g) => ({
  id: g.id,
  estatus_comprobante: g.id === 'g1' ? 'FACTURA' : 'SIN_COMPROBANTE',
  estatus_facturacion: g.id === 'g1' ? 'FACTURADA' : 'PENDIENTE',
  capturado_en: g.created_at,
  created_at: g.created_at,
  aeronave: g.id === 'g1' ? { matricula: 'XA-VGV' } : null,
  creador: { nombre: 'Luis Piloto' },
}));

const fondoRow = (over: Fila = {}): Fila => ({
  id: FONDO,
  usuario_id: 'u-luis',
  moneda: 'MXN',
  activo: true,
  es_acumulada: true,
  monto_fondo: null,
  fondo_origen_id: null,
  usuario: { nombre: 'Luis Piloto', email: 'l@x.mx', rol: 'PILOTO' },
  ...over,
});

function armar(
  opts: { fondo?: Fila; sinPyservices?: boolean; sinEndpoint?: boolean } = {},
) {
  const dedicados: CajaChicaReposicionPayload[] = [];
  const genericos: TablaXlsxPayload[] = [];
  const consultas: Array<{ tabla: string; select: string }> = [];
  const from = (tabla: string) => {
    const filtros: Record<string, unknown> = {};
    let inIds: unknown[] | null = null;
    const q: Record<string, unknown> = {};
    q.select = (s: string) => {
      consultas.push({ tabla, select: s });
      return q;
    };
    q.eq = (c: string, v: unknown) => {
      filtros[c] = v;
      return q;
    };
    q.in = (_c: string, arr: unknown[]) => {
      inIds = arr;
      return q;
    };
    q.order = () => q;
    q.limit = () => q;
    const filas = (): Fila[] => {
      if (tabla === 'caja_chica_fondo') {
        const f = opts.fondo ?? fondoRow();
        if (filtros.id === MADRE) {
          return [{ id: MADRE, usuario: { nombre: 'Mary Cruz' } }];
        }
        return filtros.id === f.id ? [f] : [];
      }
      if (tabla === 'caja_chica_movimiento') {
        if (filtros.id) return movimientos.filter((m) => m.id === filtros.id);
        return movimientos.filter((m) => m.fondo_id === filtros.fondo_id);
      }
      if (tabla === 'gasto') {
        if (inIds) return extras.filter((x) => inIds!.includes(x.id));
        return gastos;
      }
      return [];
    };
    q.maybeSingle = () =>
      Promise.resolve({ data: filas()[0] ?? null, error: null });
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: filas(), error: null }).then(res);
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  const pyservices = {
    generateCajaChicaReposicionXlsx: (p: CajaChicaReposicionPayload) => {
      dedicados.push(p);
      // `null` = el pyservices desplegado todavía no tiene el endpoint.
      return Promise.resolve(
        opts.sinEndpoint ? null : Buffer.from('xlsx-dedicado'),
      );
    },
    generateTablaXlsx: (p: TablaXlsxPayload) => {
      genericos.push(p);
      return Promise.resolve(Buffer.from('xlsx-generico'));
    },
  } as unknown as PyservicesService;
  const svc = new CajaChicaService(
    supabase,
    opts.sinPyservices ? undefined : pyservices,
  );
  return { svc, dedicados, genericos, consultas };
}

/** Valor por etiqueta en el encabezado o en los totales. */
const par = (p: CajaChicaReposicionPayload, etiqueta: string) =>
  [...p.encabezado, ...p.totales].find((d) => d.etiqueta === etiqueta);
const dato = (p: CajaChicaReposicionPayload, etiqueta: string) =>
  par(p, etiqueta)?.valor;
/** Índice de columna del export genérico (respaldo). */
const col = (label: string) =>
  COLUMNAS_EXCEL_CAJA.findIndex((c) => c.label === label);

describe('GET movimientos/:id/reposicion.xlsx — lo que repuso UNA reposición', () => {
  it('r2: gastos y movimientos ENTRE r1 y r2, en el orden del libro', async () => {
    const { svc, dedicados, genericos } = armar();
    const r = await svc.reposicionXlsx('r2');
    expect(r.buffer.toString()).toBe('xlsx-dedicado');
    expect(genericos).toHaveLength(0);
    expect(r.filename).toBe('Reposicion caja Luis Piloto 2026-09-10.xlsx');
    const p = dedicados[0];
    expect(p.hoja).toBe('Reposición 10-09-2026');
    expect(p.filas.map((f) => f.fecha)).toEqual([
      '2026-09-06',
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
    ]);
    expect(p.filas.map((f) => f.tipo)).toEqual([
      'Gasto en efectivo',
      'Ajuste',
      'Gasto en efectivo',
      'Reintegro a dirección',
    ]);
    // Gasto en su columna (positivo); reintegro/ajuste con signo en la suya.
    expect(p.filas.map((f) => f.gasto)).toEqual([100, null, 400, null]);
    expect(p.filas.map((f) => f.otro)).toEqual([null, -20, null, -30]);
    // Saldo del libro por fila = el del historial (−50 heredado de r1).
    expect(p.filas.map((f) => f.saldo)).toEqual([-150, -170, -570, -600]);
    expect(p.filas.map((f) => f.por_reponer)).toEqual([150, 170, 570, 600]);
    expect(p.n_gastos).toBe(2);
    expect(p.total_gastos).toBe(500);
    expect(p.total_otros).toBe(-50);
    // Movimiento de caja: referencia y nota.
    expect(p.filas[3].descripcion).toBe('Regresó cambio');
    expect(p.filas[1].descripcion).toBe('faltante del conteo');
  });

  it('r2: el encabezado trae responsable, caja, fondo, fecha, monto, quién, notas y periodo', async () => {
    const { svc, dedicados } = armar();
    await svc.reposicionXlsx('r2');
    const p = dedicados[0];
    expect(p.titulo).toBe('Reposición de caja chica · Luis Piloto');
    expect(p.subtitulo).toMatch(
      /^Reposición del 10\/09\/2026 por \$600\.00 MXN · generado /,
    );
    expect(p.encabezado.map((d) => d.etiqueta)).toEqual([
      'Responsable',
      'Caja',
      'Moneda',
      'Monto del fondo',
      'Fecha de la reposición',
      'Monto repuesto',
      'Autorizó',
      'Registró',
      'Notas / referencia',
      'Periodo cubierto',
      'Reposición anterior',
    ]);
    expect(dato(p, 'Responsable')).toBe('Luis Piloto');
    expect(dato(p, 'Caja')).toBe('Acumulada (se repone lo gastado)');
    expect(dato(p, 'Moneda')).toBe('MXN');
    expect(dato(p, 'Monto del fondo')).toBe('Sin monto fijo');
    expect(dato(p, 'Fecha de la reposición')).toBe('10/09/2026');
    expect(dato(p, 'Monto repuesto')).toBe(600);
    expect(dato(p, 'Autorizó')).toBe('Ale');
    expect(dato(p, 'Registró')).toBe('Mari');
    expect(dato(p, 'Notas / referencia')).toBe(
      'reembolso del 06 al 10 de septiembre · Transferencia 123',
    );
    expect(dato(p, 'Periodo cubierto')).toBe('del 06/09/2026 al 08/09/2026');
    expect(dato(p, 'Reposición anterior')).toBe('05/09/2026 · $500.00');
  });

  it('r2: los totales (Σ, reintegros/ajustes, repuesto, diferencia, saldo antes/después)', async () => {
    const { svc, dedicados } = armar();
    await svc.reposicionXlsx('r2');
    const p = dedicados[0];
    expect(p.totales.map((d) => [d.etiqueta, d.valor])).toEqual([
      ['Gastos del periodo', '2 gastos'],
      // Lo que r1 dejó (g4 se capturó DESPUÉS de r1): sin estas líneas el
      // Excel no cuadra a la vista — 50 que venían + 500 de gastos + 50 de
      // reintegro/ajuste = 600 por reponer (revisión 24-sep con prod).
      ['Saldo del libro al abrir el periodo', -50],
      ['Por reponer que venía de antes', 50],
      ['Σ gastos del periodo', 500],
      ['Reintegros / ajustes del periodo', -50],
      ['Por reponer antes de esta reposición', 600],
      ['Monto repuesto', 600],
      ['Diferencia (repuesto − por reponer)', 0],
      ['Saldo del libro antes', -600],
      ['Saldo del libro después', 0],
      ['Por reponer después', 0],
    ]);
    expect(par(p, 'Diferencia (repuesto − por reponer)')).toMatchObject({
      nota: 'Cuadra exacto',
      destacado: true,
    });
    expect(par(p, 'Reintegros / ajustes del periodo')?.nota).toBe(
      '2 movimientos',
    );
    expect(par(p, 'Saldo del libro al abrir el periodo')?.nota).toBe(
      'Tras la reposición del 05/09/2026',
    );
    expect(par(p, 'Por reponer que venía de antes')?.nota).toBe(
      'Quedó pendiente de la reposición anterior',
    );
    // Cuadre a la vista: venía + Σ gastos − reintegros/ajustes = por reponer.
    expect(
      Number(dato(p, 'Por reponer que venía de antes')) +
        Number(dato(p, 'Σ gastos del periodo')) -
        Number(dato(p, 'Reintegros / ajustes del periodo')),
    ).toBe(dato(p, 'Por reponer antes de esta reposición'));
    // Sin gastos capturados después: ni aviso ni resaltes.
    expect(p.avisos).toEqual([]);
    expect(p.filas.some((f) => f.resaltar)).toBe(false);
  });

  it('r1: el gasto del MISMO día capturado DESPUÉS entra, se resalta y se avisa', async () => {
    const { svc, dedicados } = armar();
    await svc.reposicionXlsx('r1');
    const p = dedicados[0];
    expect(p.filas.map((f) => f.fecha)).toEqual([
      '2026-09-01',
      '2026-09-03',
      '2026-09-05',
    ]);
    expect(p.filas.map((f) => f.resaltar)).toEqual([false, false, true]);
    expect(dato(p, 'Diferencia (repuesto − por reponer)')).toBe(-50);
    expect(par(p, 'Diferencia (repuesto − por reponer)')?.nota).toBe(
      'Quedó pendiente por reponer',
    );
    expect(dato(p, 'Reposición anterior')).toBe(
      'Ninguna (es la primera reposición del fondo)',
    );
    expect(p.avisos).toHaveLength(1);
    expect(p.avisos[0]).toMatch(
      /^1 gasto se capturó DESPUÉS de registrar esta reposición/,
    );
    // Caja acumulada: sin la nota de «entrega inicial del fondo».
    expect(par(p, 'Nota')).toBeUndefined();
  });

  it('r1: cada gasto con categoría es-MX, descripción, vuelo, matrícula, comprobante, facturación y quién capturó', async () => {
    const { svc, dedicados } = armar();
    await svc.reposicionXlsx('r1');
    const [g1, g2] = dedicados[0].filas;
    expect(g1.categoria).toBe('Taxi / estacionamiento');
    // Primera línea de las notas + lugar (el sello de captura no se cuela).
    expect(g1.descripcion).toBe('Taxi al FBO · MID');
    expect(g1.vuelo).toBe('#297');
    expect(g1.matricula).toBe('XA-VGV');
    expect(g1.comprobante).toBe('Con comprobante');
    expect(g1.facturacion).toBe('Facturada');
    expect(g1.capturo).toBe('Luis Piloto');
    expect(g1.capturado).toBe('2026-09-01 07:00');
    expect(g2.comprobante).toBe('Sin comprobante');
    expect(g2.facturacion).toBe('Pendiente');
    expect(g2.vuelo).toBe('');
  });

  it('caja VINCULADA de fondo fijo: dice de qué caja se fondea, el monto del fondo y la nota de la primera', async () => {
    const { svc, dedicados } = armar({
      fondo: fondoRow({
        es_acumulada: false,
        monto_fondo: 8000,
        fondo_origen_id: MADRE,
      }),
    });
    await svc.reposicionXlsx('r1');
    const p = dedicados[0];
    expect(dato(p, 'Caja')).toBe(
      'Fondo fijo (se rellena hasta el monto del fondo)',
    );
    expect(dato(p, 'Monto del fondo')).toBe(8000);
    expect(dato(p, 'Se fondea desde')).toBe('Caja de Mary Cruz');
    expect(dato(p, 'Nota')).toBe(
      'Primera reposición del fondo: la diferencia incluye la entrega inicial del fondo.',
    );
  });

  it('pyservices SIN el endpoint nuevo (deploy desfasado) ⇒ el MISMO contenido por el export genérico', async () => {
    const { svc, dedicados, genericos } = armar({ sinEndpoint: true });
    const r = await svc.reposicionXlsx('r1');
    expect(r.buffer.toString()).toBe('xlsx-generico');
    const d = dedicados[0];
    const g = genericos[0];
    expect(g.titulo).toBe(d.titulo);
    expect(g.columnas).toBe(COLUMNAS_EXCEL_CAJA);
    // Fechas dd/mm/aaaa (el genérico no formatea fechas).
    expect(g.filas.map((f) => f[0])).toEqual([
      '01/09/2026',
      '03/09/2026',
      '05/09/2026',
    ]);
    expect(g.filas[0][col('Gasto')]).toBe(300);
    expect(g.totales?.[col('Gasto')]).toBe(d.total_gastos);
    // Encabezado + totales + aviso en el bloque resumen.
    expect(g.resumen?.find((x) => x[0] === 'Responsable')?.[1]).toBe(
      'Luis Piloto',
    );
    expect(
      g.resumen?.find((x) => x[0] === 'Diferencia (repuesto − por reponer)'),
    ).toEqual([
      'Diferencia (repuesto − por reponer)',
      -50,
      'Quedó pendiente por reponer',
    ]);
    expect(g.resumen?.at(-1)?.[0]).toBe('Aviso');
    // El resalte de la fila capturada después: fecha y captura.
    expect(g.resaltes).toEqual([
      { fila: 2, col: 0, color: 'ED7D31' },
      { fila: 2, col: col('Capturado (hora Cancún)'), color: 'ED7D31' },
    ]);
  });

  it('un AJUSTE/REINTEGRO ⇒ 409 MOVIMIENTO_NO_ES_REPOSICION y no se genera nada', async () => {
    const { svc, dedicados, genericos } = armar();
    const err = await svc.reposicionXlsx('aj').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err).toMatchObject({
      response: {
        error: 'MOVIMIENTO_NO_ES_REPOSICION',
        message:
          'Solo las reposiciones tienen Excel de lo repuesto; este movimiento es «Ajuste».',
      },
    });
    expect(dedicados).toHaveLength(0);
    expect(genericos).toHaveLength(0);
  });

  it('movimiento inexistente ⇒ 404', async () => {
    const { svc } = armar();
    await expect(svc.reposicionXlsx('nada')).rejects.toThrow(NotFoundException);
  });

  it('sin pyservices ⇒ 503 claro (nunca un archivo vacío)', async () => {
    const { svc } = armar({ sinPyservices: true });
    await expect(svc.reposicionXlsx('r2')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('los datos de presentación se piden EN LOTE solo para los gastos del periodo', async () => {
    const { svc, consultas } = armar();
    await svc.reposicionXlsx('r2');
    const extrasQ = consultas.filter(
      (c) => c.tabla === 'gasto' && c.select.includes('estatus_comprobante'),
    );
    expect(extrasQ).toHaveLength(1);
  });
});

describe('GET fondos/:id/por-reponer.xlsx — lo PENDIENTE hoy', () => {
  it('solo lo posterior a la última reposición, con el POR REPONER HOY', async () => {
    const { svc, dedicados } = armar();
    const r = await svc.porReponerXlsx(FONDO);
    expect(r.filename).toBe(`Por reponer caja Luis Piloto ${hoyCancun()}.xlsx`);
    const p = dedicados[0];
    expect(p.titulo).toBe('Por reponer · caja chica · Luis Piloto');
    expect(p.hoja).toBe('Por reponer');
    expect(p.filas.map((f) => f.fecha)).toEqual(['2026-09-11']);
    expect(dato(p, 'Última reposición')).toBe('10/09/2026 · $600.00');
    expect(dato(p, 'Periodo pendiente')).toBe('del 11/09/2026 al 11/09/2026');
    expect(dato(p, 'Corte al')).toBe(fechaDmy(hoyCancun()));
    expect(p.totales.map((d) => [d.etiqueta, d.valor])).toEqual([
      ['Gastos pendientes', '1 gasto'],
      ['Saldo del libro al abrir el periodo', 0],
      ['Por reponer que venía de antes', 0],
      ['Σ gastos pendientes', 70],
      ['Saldo del libro hoy', -70],
      ['POR REPONER HOY', 70],
    ]);
    expect(par(p, 'POR REPONER HOY')?.destacado).toBe(true);
    // En pendiente no hay «reposición» que comparar ni gasto «después».
    expect(dato(p, 'Monto repuesto')).toBeUndefined();
    expect(p.filas.some((f) => f.resaltar)).toBe(false);
  });

  it('fondo inexistente ⇒ 404', async () => {
    const { svc } = armar();
    await expect(svc.porReponerXlsx('otro')).rejects.toThrow(NotFoundException);
  });
});

describe('nombre del archivo', () => {
  it('«Reposicion caja <responsable> <fecha>.xlsx» en ASCII', () => {
    expect(nombreArchivoCaja('reposicion', 'José Núñez', '2026-09-21')).toBe(
      'Reposicion caja Jose Nunez 2026-09-21.xlsx',
    );
    expect(nombreArchivoCaja('pendiente', '', '2026-09-24')).toBe(
      'Por reponer caja sin nombre 2026-09-24.xlsx',
    );
  });

  it('Content-Disposition attachment con filename y filename*', () => {
    expect(
      dispositionXlsx('Reposicion caja Alexander E. Saab 2026-09-21.xlsx'),
    ).toBe(
      'attachment; filename="Reposicion caja Alexander E. Saab 2026-09-21.xlsx"; ' +
        "filename*=UTF-8''Reposicion%20caja%20Alexander%20E.%20Saab%202026-09-21.xlsx",
    );
  });
});
