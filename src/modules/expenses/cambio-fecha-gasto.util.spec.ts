import { readFileSync } from 'fs';
import { join } from 'path';
import { diasEntreDiasCancun } from '../../common/fecha-cancun.util';
import { MEDIOS_BANCARIOS } from '../conciliacion/gastos-candidatos.util';
import { CategoriaGasto } from './dto/expenses.dto';
import {
  CAMBIO_FECHA_DIAS_ATRAS_MAX,
  CODIGO_CAMBIO_FECHA,
  GASTO_CAMBIO_FECHA_COLS,
  alcanceRepartoPorFecha,
  avionesParaTextos,
  decidirCambioFechaGasto,
  diaTexto,
  errorDeFechasCambio,
  errorMedioNoBancario,
  fechaHoraCargaAlDia,
  libroDineroPorFecha,
  type EntradaCambioFecha,
  type GastoCambioFecha,
} from './cambio-fecha-gasto.util';

/**
 * FECHA DEL PAGO desde Conciliación (14-oct-2026, invariante 74): la regla
 * PURA y sus textos, con los casos REALES de prod leídos el 14-oct (Winjet
 * 08c0632c, 92bd5379 y b15080c3) y la ALARMA DE PARIDAD contra los libros
 * que los textos imitan (balance, reparto y Libro Dinero).
 */
const N41 = 'av-n4142r';
const PEV = 'av-xb-pev';
const MATRICULAS: Record<string, string> = { [N41]: 'N4142R', [PEV]: 'XB-PEV' };
const matricula = (a: string): string | null => MATRICULAS[a] ?? null;
const sinMatricula = (): string | null => null;

const LINEA_TC =
  'El reparto convierte este gasto en pesos con el tipo de cambio oficial del día del gasto: con la fecha nueva cambia lo que vale en dólares.';
const SEP_TERMINO =
  'Septiembre 2026 ya terminó: si ya se entregaron sus libros o su reparto, hay que regenerarlos después de este cambio.';

/** Winjet (prod): TAXI con tarjeta, vuelo #436 de XB-PEV del 10-oct. */
function winjet(extra: Partial<GastoCambioFecha> = {}): GastoCambioFecha {
  return {
    id: '08c0632c-5711-4f0d-affd-591d756dd9fc',
    categoria: 'TAXI',
    medio_pago: 'TARJETA_CORP',
    moneda: 'MXN',
    tc_gasto: null,
    monto: '321.54',
    fecha_gasto: '2026-10-10',
    fecha_hora_carga: null,
    updated_at: '2026-10-12T19:53:54.941784+00:00',
    vuelo_id: 'v-436',
    aeronave_id: PEV,
    escala_id: null,
    inventario_movimiento_id: null,
    escala: null,
    vuelo: {
      folio: 436,
      fecha_vuelo: '2026-10-10T22:00:00+00:00',
      aeronave_id: PEV,
      es_externo: false,
    },
    ...extra,
  };
}

/** 92bd5379 (prod): OPERACIONES por SPEI del vuelo #201 de N4142R (27-ago). */
const caso92bd = (extra: Partial<GastoCambioFecha> = {}) =>
  winjet({
    id: '92bd5379-66de-4536-b3be-d25d2096a8db',
    categoria: 'OPERACIONES',
    medio_pago: 'TRANSFERENCIA',
    monto: '2231.37',
    fecha_gasto: '2026-08-27',
    vuelo_id: 'v-201',
    aeronave_id: N41,
    vuelo: {
      folio: 201,
      fecha_vuelo: '2026-08-27T13:50:00+00:00',
      aeronave_id: N41,
      es_externo: false,
    },
    ...extra,
  });

/** b15080c3 (prod): OPERACIONES por PayWise del vuelo #190 de XB-PEV (25-ago), fechado 09-sep. */
const casoB150 = (extra: Partial<GastoCambioFecha> = {}) =>
  winjet({
    id: 'b15080c3-21d6-4720-9439-7583d751c52a',
    categoria: 'OPERACIONES',
    medio_pago: 'PAYWISE',
    monto: '3648.00',
    fecha_gasto: '2026-09-09',
    vuelo_id: 'v-190',
    aeronave_id: PEV,
    vuelo: {
      folio: 190,
      fecha_vuelo: '2026-08-25T18:00:00+00:00',
      aeronave_id: PEV,
      es_externo: false,
    },
    ...extra,
  });

/** Gasto SIN vuelo (por default REFACCION de N4142R del 30-sep). */
const sinVuelo = (extra: Partial<GastoCambioFecha> = {}) =>
  winjet({
    id: 'g-sin-vuelo',
    categoria: 'REFACCION',
    medio_pago: 'TRANSFERENCIA',
    monto: '1500.00',
    fecha_gasto: '2026-09-30',
    vuelo_id: null,
    vuelo: null,
    aeronave_id: N41,
    ...extra,
  });

function decidir(
  g: GastoCambioFecha,
  nueva: string,
  extra: Partial<EntradaCambioFecha> = {},
) {
  return decidirCambioFechaGasto({
    gasto: g,
    nueva,
    anterior: String(g.fecha_gasto),
    hoy: '2026-10-14',
    confirmar: false,
    repartos: [],
    matricula,
    ...extra,
  });
}

/** El texto (y details) de un 409 FECHA_GASTO_CONFIRMAR. */
function confirmacion(d: ReturnType<typeof decidir>) {
  expect(d.tipo).toBe('CONFIRMAR');
  if (d.tipo !== 'CONFIRMAR') throw new Error('no es CONFIRMAR');
  expect(d.error.status).toBe(409);
  expect(d.error.code).toBe('FECHA_GASTO_CONFIRMAR');
  return d.error;
}

describe('diaTexto y columnas', () => {
  it("'2026-09-07' ⇒ '07 sep 2026' (el formato de fmtDateOnly del panel)", () => {
    expect(diaTexto('2026-09-07')).toBe('07 sep 2026');
    expect(diaTexto('2026-10-31')).toBe('31 oct 2026');
  });

  it('GASTO_CAMBIO_FECHA_COLS: los embeds de Conciliación + folio, medio, moneda, T.C., hora de carga y updated_at', () => {
    for (const c of [
      'medio_pago',
      'moneda',
      'tc_gasto',
      'fecha_hora_carga',
      'updated_at',
      'inventario_movimiento_id',
      'escala:escala_id(aeronave_id)',
      'vuelo:vuelo_id(folio, fecha_vuelo, aeronave_id, es_externo)',
    ]) {
      expect(GASTO_CAMBIO_FECHA_COLS).toContain(c);
    }
  });

  it('los 7 códigos llevan el prefijo FECHA_GASTO_ (FECHA_PAGO_* es de las entregas a socios)', () => {
    expect(Object.values(CODIGO_CAMBIO_FECHA)).toEqual([
      'FECHA_GASTO_INVALIDA',
      'FECHA_GASTO_FUTURA',
      'FECHA_GASTO_MUY_ANTIGUA',
      'FECHA_GASTO_SOLO_BANCARIOS',
      'FECHA_GASTO_CAMBIO',
      'FECHA_GASTO_FUERA_DEL_MES_DEL_VUELO',
      'FECHA_GASTO_CONFIRMAR',
    ]);
  });
});

describe('errorDeFechasCambio — las fechas ANTES de tocar la BD (hoy 2026-10-14)', () => {
  const HOY = '2026-10-14';

  it('posterior a hoy ⇒ 400 FECHA_GASTO_FUTURA con el texto exacto', () => {
    expect(errorDeFechasCambio('2026-10-15', '2026-10-10', HOY)).toEqual({
      status: 400,
      code: 'FECHA_GASTO_FUTURA',
      message:
        'La fecha del pago (15 oct 2026) es posterior a hoy (14 oct 2026): el banco no cobra en días que no han pasado.',
    });
  });

  it('hoy pasa; JUSTO 365 días atrás pasa (el borde de update()); 366 ⇒ 400 FECHA_GASTO_MUY_ANTIGUA', () => {
    expect(errorDeFechasCambio('2026-10-14', '2026-10-10', HOY)).toBeNull();
    expect(CAMBIO_FECHA_DIAS_ATRAS_MAX).toBe(365);
    expect(diasEntreDiasCancun('2025-10-14', HOY)).toBe(365);
    expect(errorDeFechasCambio('2025-10-14', '2026-10-10', HOY)).toBeNull();
    expect(errorDeFechasCambio('2025-10-13', '2026-10-10', HOY)).toEqual({
      status: 400,
      code: 'FECHA_GASTO_MUY_ANTIGUA',
      message:
        'La fecha del pago (13 oct 2025) es de hace más de un año: revisa el año. Una fecha tan antigua se corrige en Gastos → Verificar / editar.',
    });
  });

  it('un día que no existe (la nueva o la anterior) ⇒ 400 FECHA_GASTO_INVALIDA', () => {
    const esperado = {
      status: 400,
      code: 'FECHA_GASTO_INVALIDA',
      message:
        'La fecha «2026-02-30» no existe en el calendario: elígela con el calendario.',
    };
    expect(errorDeFechasCambio('2026-02-30', '2026-10-10', HOY)).toEqual(
      esperado,
    );
    expect(errorDeFechasCambio('2026-10-12', '2026-02-30', HOY)).toEqual(
      esperado,
    );
    expect(errorDeFechasCambio('2026-10-1', '2026-10-10', HOY)?.code).toBe(
      'FECHA_GASTO_INVALIDA',
    );
  });
});

describe('errorMedioNoBancario — solo los medios que tocan el banco', () => {
  it('los 4 bancarios (fuente única MEDIOS_BANCARIOS) ⇒ null', () => {
    expect([...MEDIOS_BANCARIOS].sort()).toEqual([
      'DOMICILIADO',
      'PAYWISE',
      'TARJETA_CORP',
      'TRANSFERENCIA',
    ]);
    for (const m of MEDIOS_BANCARIOS) {
      expect(errorMedioNoBancario(m)).toBeNull();
    }
  });

  it('EFECTIVO, BODEGA, PERSONAL_* y sin medio ⇒ 409 FECHA_GASTO_SOLO_BANCARIOS con su texto y details.medio_pago', () => {
    expect(errorMedioNoBancario('EFECTIVO')).toEqual({
      status: 409,
      code: 'FECHA_GASTO_SOLO_BANCARIOS',
      message:
        'Este gasto se pagó en efectivo: su fecha decide qué reposición de caja chica lo cubre y no se cambia desde Conciliación. Si está mal, corrígela en Gastos → Verificar / editar.',
      details: { medio_pago: 'EFECTIVO' },
    });
    expect(errorMedioNoBancario('BODEGA')).toEqual({
      status: 409,
      code: 'FECHA_GASTO_SOLO_BANCARIOS',
      message:
        'Es una salida de inventario (bodega): su fecha es la del movimiento de la bodega y no se cambia desde Conciliación.',
      details: { medio_pago: 'BODEGA' },
    });
    const generico =
      'Este gasto no se pagó por el banco: desde Conciliación solo se corrige la fecha de los pagos con tarjeta, transferencia, PayWise o pago domiciliado. Si está mal, corrígela en Gastos → Verificar / editar.';
    for (const m of ['PERSONAL_PABLO', 'PERSONAL_ALE', null]) {
      expect(errorMedioNoBancario(m)).toEqual({
        status: 409,
        code: 'FECHA_GASTO_SOLO_BANCARIOS',
        message: generico,
        details: { medio_pago: m },
      });
    }
  });
});

describe('decidirCambioFechaGasto — candados en orden', () => {
  it('el medio va primero: un EFECTIVO con la misma fecha también es 409', () => {
    const d = decidir(winjet({ medio_pago: 'EFECTIVO' }), '2026-10-10');
    expect(d).toMatchObject({
      tipo: 'ERROR',
      error: { status: 409, code: 'FECHA_GASTO_SOLO_BANCARIOS' },
    });
  });

  it('misma fecha ⇒ SIN_CAMBIO aunque fecha_anterior difiera (doble clic)', () => {
    expect(decidir(winjet(), '2026-10-10', { anterior: '2026-10-09' })).toEqual(
      { tipo: 'SIN_CAMBIO' },
    );
  });

  it('fecha_anterior ≠ la vigente ⇒ 409 FECHA_GASTO_CAMBIO con la fecha vigente', () => {
    expect(decidir(winjet(), '2026-10-12', { anterior: '2026-10-09' })).toEqual(
      {
        tipo: 'ERROR',
        error: {
          status: 409,
          code: 'FECHA_GASTO_CAMBIO',
          message:
            'La fecha de este gasto cambió mientras tanto (ahora dice 10 oct 2026): revisa y vuelve a intentarlo.',
          details: { fecha_actual: '2026-10-10' },
        },
      },
    );
  });

  it('Winjet (caso de la captura): 10-oct → 12-oct, octubre en curso ⇒ APLICAR sin confirmación', () => {
    const esperado = {
      tipo: 'APLICAR',
      fecha_hora_carga: null,
      cambia_de_mes: false,
      aviso: null,
    };
    expect(decidir(winjet(), '2026-10-12')).toEqual(esperado);
    expect(decidir(winjet(), '2026-10-12', { confirmar: true })).toEqual(
      esperado,
    );
  });
});

describe('mes del vuelo — ESPEJO EXACTO de fechasFuera del balance', () => {
  const FUERA_201 =
    'No se puede: este gasto es del vuelo #201 (27 ago 2026). Con fecha de septiembre 2026 quedaría en otro mes que su vuelo y el balance de agosto 2026 lo marcaría como pendiente («fecha FUERA del periodo del libro»). Déjale una fecha de agosto 2026; para vincularlo no hace falta cambiarla.';

  it('92bd5379: 27-ago → 07-sep (el día del SPEI) ⇒ 409 FUERA, también con confirmar', () => {
    const esperado = {
      tipo: 'ERROR',
      error: {
        status: 409,
        code: 'FECHA_GASTO_FUERA_DEL_MES_DEL_VUELO',
        message: FUERA_201,
        details: {
          vuelo_folio: 201,
          vuelo_dia: '2026-08-27',
          mes_vuelo: '2026-08',
          mes_nuevo: '2026-09',
        },
      },
    };
    expect(decidir(caso92bd(), '2026-09-07')).toEqual(esperado);
    expect(decidir(caso92bd(), '2026-09-07', { confirmar: true })).toEqual(
      esperado,
    );
  });

  it('b15080c3 (ya fuera de su mes): dentro de septiembre ⇒ confirmación por el T.C. del reparto en un mes terminado', () => {
    const e = confirmacion(decidir(casoB150(), '2026-09-30'));
    expect(e.message).toBe(
      `La fecha cambia dentro de septiembre 2026. ${LINEA_TC} ${SEP_TERMINO}`,
    );
    expect(e.details).toEqual({
      cambia_de_mes: false,
      mes_antes: '2026-09',
      mes_despues: '2026-09',
      etiqueta_mes_despues: 'septiembre 2026',
      meses_terminados: ['2026-09'],
    });
    expect(decidir(casoB150(), '2026-09-30', { confirmar: true })).toEqual({
      tipo: 'APLICAR',
      fecha_hora_carga: null,
      cambia_de_mes: false,
      aviso: SEP_TERMINO,
    });
  });

  it('b15080c3: REGRESAR al mes de su vuelo se permite y se confirma («se quita su pendiente»)', () => {
    const e = confirmacion(decidir(casoB150(), '2026-08-25'));
    expect(e.message).toBe(
      'Pasa de septiembre 2026 a agosto 2026. Regresa al mes de su vuelo #190 (agosto 2026): se quita su pendiente «fecha FUERA del periodo del libro». En el reparto a socios de XB-PEV pasa a agosto 2026. ' +
        `${LINEA_TC} Agosto 2026 y septiembre 2026 ya terminaron: si ya se entregaron sus libros o su reparto, hay que regenerarlos después de este cambio.`,
    );
    expect(e.details).toMatchObject({
      cambia_de_mes: true,
      mes_antes: '2026-09',
      mes_despues: '2026-08',
      etiqueta_mes_despues: 'agosto 2026',
      meses_terminados: ['2026-08', '2026-09'],
    });
  });

  it('b15080c3: a OTRO mes que ni el del vuelo ni el que tenía ⇒ 409 FUERA', () => {
    expect(decidir(casoB150(), '2026-10-02')).toMatchObject({
      tipo: 'ERROR',
      error: {
        code: 'FECHA_GASTO_FUERA_DEL_MES_DEL_VUELO',
        details: { mes_vuelo: '2026-08', mes_nuevo: '2026-10' },
      },
    });
  });

  it('GAS con vuelo también (fechasFuera lo marca): 30-oct → 02-nov ⇒ 409 FUERA', () => {
    const gas = winjet({
      categoria: 'GAS',
      fecha_gasto: '2026-10-30',
      vuelo: {
        folio: 480,
        fecha_vuelo: '2026-10-30T20:00:00Z',
        aeronave_id: PEV,
        es_externo: false,
      },
    });
    expect(decidir(gas, '2026-11-02', { hoy: '2026-11-20' })).toMatchObject({
      tipo: 'ERROR',
      error: { code: 'FECHA_GASTO_FUERA_DEL_MES_DEL_VUELO' },
    });
  });

  it('TUAS con vuelo al salir de su mes ⇒ 409 FUERA', () => {
    const tuas = caso92bd({ categoria: 'TUAS' });
    expect(decidir(tuas, '2026-09-07')).toMatchObject({
      tipo: 'ERROR',
      error: { code: 'FECHA_GASTO_FUERA_DEL_MES_DEL_VUELO' },
    });
  });

  it('frontera Cancún: el vuelo de las 22:30 del 31-oct (03:30Z del 1-nov) es de OCTUBRE', () => {
    const g = winjet({
      categoria: 'OPERACIONES',
      fecha_gasto: '2026-10-31',
      vuelo: {
        folio: 500,
        fecha_vuelo: '2026-11-01T03:30:00Z',
        aeronave_id: PEV,
        es_externo: false,
      },
    });
    const d = decidir(g, '2026-11-01', { hoy: '2026-11-05' });
    expect(d).toMatchObject({
      tipo: 'ERROR',
      error: {
        code: 'FECHA_GASTO_FUERA_DEL_MES_DEL_VUELO',
        details: { vuelo_dia: '2026-10-31', mes_vuelo: '2026-10' },
      },
    });
    if (d.tipo === 'ERROR') expect(d.error.message).toContain('(31 oct 2026)');
  });

  it('las DOS comisiones del vendedor con vuelo cambian de mes SIN confirmación (ningún libro las lee por fecha)', () => {
    for (const categoria of ['COMISION_VENDEDOR', 'COMISION_VENDEDOR_AVION']) {
      const g = winjet({
        categoria,
        medio_pago: 'TRANSFERENCIA',
        fecha_gasto: '2026-09-20',
        vuelo: {
          folio: 300,
          fecha_vuelo: '2026-09-20T18:00:00+00:00',
          aeronave_id: PEV,
          es_externo: false,
        },
      });
      expect(decidir(g, '2026-10-02')).toEqual({
        tipo: 'APLICAR',
        fecha_hora_carga: null,
        cambia_de_mes: true,
        aviso: null,
      });
    }
  });

  it('PERSONAL_DUENO con tarjeta ⇒ APLICAR sin confirmación', () => {
    const g = sinVuelo({
      categoria: 'PERSONAL_DUENO',
      medio_pago: 'TARJETA_CORP',
      aeronave_id: null,
    });
    expect(decidir(g, '2026-10-01')).toEqual({
      tipo: 'APLICAR',
      fecha_hora_carga: null,
      cambia_de_mes: true,
      aviso: null,
    });
  });
});

describe('confirmación — los textos son espejo de los libros', () => {
  it('REFACCION sin vuelo de N4142R, 30-sep → 01-oct: balance, reparto, Libro Dinero, T.C. y mes terminado', () => {
    const e = confirmacion(decidir(sinVuelo(), '2026-10-01'));
    expect(e.message).toBe(
      'Pasa de septiembre 2026 a octubre 2026. En el balance de N4142R pasa a octubre 2026. En el reparto a socios de N4142R pasa a octubre 2026. En el Libro Dinero pasa a octubre 2026. ' +
        `${LINEA_TC} ${SEP_TERMINO}`,
    );
    expect(e.details).toEqual({
      cambia_de_mes: true,
      mes_antes: '2026-09',
      mes_despues: '2026-10',
      etiqueta_mes_despues: 'octubre 2026',
      meses_terminados: ['2026-09'],
    });
  });

  it('OTRO sin vuelo ni avión: balance general y Libro Dinero, SIN reparto ni T.C. (EXCLUIDO como empresa)', () => {
    const g = sinVuelo({ categoria: 'OTRO', aeronave_id: null });
    expect(confirmacion(decidir(g, '2026-10-01')).message).toBe(
      `Pasa de septiembre 2026 a octubre 2026. En el balance general pasa a octubre 2026. En el Libro Dinero pasa a octubre 2026. ${SEP_TERMINO}`,
    );
  });

  it('FIJO: el reparto lo prorratea entre TODA la flota', () => {
    const g = sinVuelo({ categoria: 'FIJO', aeronave_id: null });
    expect(confirmacion(decidir(g, '2026-10-01')).message).toBe(
      'Pasa de septiembre 2026 a octubre 2026. En el balance general pasa a octubre 2026. Es un gasto fijo: el reparto a socios lo prorratea entre toda la flota, así que cambia la utilidad de todos los aviones en los dos meses. En el Libro Dinero pasa a octubre 2026. ' +
        `${LINEA_TC} ${SEP_TERMINO}`,
    );
  });

  it('OTRO repartido N4142R $600 / XB-PEV $400 (monto $1,500, remanente $500): general + aviones y sus partes', () => {
    const g = sinVuelo({ categoria: 'OTRO', aeronave_id: null });
    const repartos = [
      { aeronave_id: N41, monto: 600 },
      { aeronave_id: PEV, monto: 400 },
    ];
    expect(confirmacion(decidir(g, '2026-10-01', { repartos })).message).toBe(
      'Pasa de septiembre 2026 a octubre 2026. En el balance general y en el de N4142R y XB-PEV pasa a octubre 2026. En el reparto a socios pasan a octubre 2026 sus partes (N4142R y XB-PEV). En el Libro Dinero pasa a octubre 2026. ' +
        `${LINEA_TC} ${SEP_TERMINO}`,
    );
  });

  it('GAS sin vuelo de N4142R con hora de carga: confirma y, confirmado, mueve la carga a la misma hora Cancún del día nuevo', () => {
    const g = sinVuelo({
      categoria: 'GAS',
      fecha_hora_carga: '2026-09-30T12:40:00.000Z', // 07:40 Cancún
    });
    expect(confirmacion(decidir(g, '2026-10-01')).message).toBe(
      'Pasa de septiembre 2026 a octubre 2026. En el balance general y en el de N4142R pasa a octubre 2026. En el reparto a socios de N4142R pasa a octubre 2026. En el Libro Dinero pasa a octubre 2026. ' +
        `${LINEA_TC} ${SEP_TERMINO}`,
    );
    expect(decidir(g, '2026-10-01', { confirmar: true })).toEqual({
      tipo: 'APLICAR',
      fecha_hora_carga: '2026-10-01T12:40:00.000Z',
      cambia_de_mes: true,
      aviso: SEP_TERMINO,
    });
  });

  it('TUAS sin vuelo con avión: «otros movimientos» del general y Libro Dinero, sin reparto', () => {
    const g = sinVuelo({ categoria: 'TUAS' });
    expect(confirmacion(decidir(g, '2026-10-01')).message).toBe(
      `Pasa de septiembre 2026 a octubre 2026. En el balance general pasa a octubre 2026. En el Libro Dinero pasa a octubre 2026. ${SEP_TERMINO}`,
    );
  });

  it('mes en curso: OPERACIONES en pesos sin T.C. dentro de octubre ⇒ APLICAR sin confirmación', () => {
    const g = winjet({ categoria: 'OPERACIONES', fecha_gasto: '2026-10-03' });
    expect(decidir(g, '2026-10-12')).toEqual({
      tipo: 'APLICAR',
      fecha_hora_carga: null,
      cambia_de_mes: false,
      aviso: null,
    });
  });

  it('en dólares (cruzado) o en pesos CON tc_gasto no hay línea de T.C.: dentro de un mes terminado se guarda directo', () => {
    for (const extra of [
      { moneda: 'USD' },
      { tc_gasto: 18.2 },
      { tc_gasto: '18.200000' },
    ] as Array<Partial<GastoCambioFecha>>) {
      expect(decidir(casoB150(extra), '2026-09-30')).toEqual({
        tipo: 'APLICAR',
        fecha_hora_carga: null,
        cambia_de_mes: false,
        aviso: null,
      });
    }
    const e = confirmacion(decidir(sinVuelo({ tc_gasto: 18.2 }), '2026-10-01'));
    expect(e.message).not.toContain('tipo de cambio');
  });

  it('el 1-nov octubre ya terminó', () => {
    const g = sinVuelo({
      categoria: 'OTRO',
      aeronave_id: null,
      fecha_gasto: '2026-10-31',
    });
    const e = confirmacion(decidir(g, '2026-11-01', { hoy: '2026-11-01' }));
    expect(e.message).toContain(
      'Octubre 2026 ya terminó: si ya se entregaron sus libros o su reparto, hay que regenerarlos después de este cambio.',
    );
    expect(e.details).toMatchObject({ meses_terminados: ['2026-10'] });
  });

  it('matrícula desconocida ⇒ «del avión» (nunca un texto roto)', () => {
    const e = confirmacion(
      decidir(sinVuelo(), '2026-10-01', { matricula: sinMatricula }),
    );
    expect(e.message).toContain('En el balance del avión pasa a octubre 2026.');
    expect(e.message).toContain(
      'En el reparto a socios del avión pasa a octubre 2026.',
    );
    const repartido = confirmacion(
      decidir(
        sinVuelo({ categoria: 'OTRO', aeronave_id: null }),
        '2026-10-01',
        {
          matricula: sinMatricula,
          repartos: [
            { aeronave_id: N41, monto: 600 },
            { aeronave_id: PEV, monto: 400 },
          ],
        },
      ),
    );
    expect(repartido.message).toContain(
      'En el balance general y en el del avión pasa a octubre 2026.',
    );
    expect(repartido.message).toContain(
      'En el reparto a socios pasan a octubre 2026 sus partes.',
    );
  });
});

describe('alcanceRepartoPorFecha — espejo del ternario de computeAvion', () => {
  const AVION = [
    'GAS',
    'OPERACIONES',
    'ATERRIZAJE',
    'FBO',
    'COMIDA',
    'HOTEL',
    'TAXI',
    'PILOTO_EXTERNO',
    'COMISARIATO',
    'REFACCION',
    'SERVICIOS',
    'PERMISO',
  ];
  const NULO = [
    'TUAS',
    'COMISION_VENDEDOR',
    'COMISION_VENDEDOR_AVION',
    'INDIRECTO',
    'NOMINA',
    'OTRO',
    'GASOLINA',
    'VISITA',
    'PERSONAL_DUENO',
  ];

  it('tabla CONGELADA de las 22 categorías sin reparto (con y sin avión)', () => {
    const todas = Object.values(CategoriaGasto) as string[];
    expect(todas).toHaveLength(22);
    expect([...AVION, 'FIJO', ...NULO].sort()).toEqual([...todas].sort());
    for (const categoria of todas) {
      const conAvion = alcanceRepartoPorFecha(sinVuelo({ categoria }), []);
      const sinAvion = alcanceRepartoPorFecha(
        sinVuelo({ categoria, aeronave_id: null }),
        [],
      );
      if (AVION.includes(categoria)) {
        expect(conAvion).toEqual({ tipo: 'AVION', avion: N41 });
        expect(sinAvion).toBeNull();
      } else if (categoria === 'FIJO') {
        expect(conAvion).toEqual({ tipo: 'FLOTA' });
        expect(sinAvion).toEqual({ tipo: 'FLOTA' });
      } else {
        expect(conAvion).toBeNull();
        expect(sinAvion).toBeNull();
      }
    }
  });

  it('con partes de reparto: las 6 repartibles ⇒ PARTES con los aviones únicos del reparto', () => {
    const repartos = [
      { aeronave_id: N41, monto: 600 },
      { aeronave_id: PEV, monto: 300 },
      { aeronave_id: PEV, monto: 100 },
    ];
    for (const categoria of [
      'OTRO',
      'FIJO',
      'INDIRECTO',
      'NOMINA',
      'GASOLINA',
      'VISITA',
    ]) {
      expect(
        alcanceRepartoPorFecha(
          sinVuelo({ categoria, aeronave_id: null }),
          repartos,
        ),
      ).toEqual({ tipo: 'PARTES', aviones: [N41, PEV] });
    }
  });

  it('el avión sale como en avionDelGasto: la escala manda; sin avión sellado, el del vuelo', () => {
    expect(alcanceRepartoPorFecha(winjet({ aeronave_id: null }), [])).toEqual({
      tipo: 'AVION',
      avion: PEV,
    });
    expect(
      alcanceRepartoPorFecha(
        winjet({ escala_id: 'e-1', escala: { aeronave_id: N41 } }),
        [],
      ),
    ).toEqual({ tipo: 'AVION', avion: N41 });
  });
});

describe('libroDineroPorFecha — espejo de las dos lecturas por fecha del Libro Dinero', () => {
  it('sin vuelo, de empresa con vuelo y GAS con vuelo ⇒ true; directo con vuelo y PERSONAL_DUENO ⇒ false', () => {
    expect(
      libroDineroPorFecha({ categoria: 'REFACCION', vuelo_id: null }),
    ).toBe(true);
    expect(libroDineroPorFecha({ categoria: 'OTRO', vuelo_id: 'v-1' })).toBe(
      true,
    );
    expect(libroDineroPorFecha({ categoria: 'GAS', vuelo_id: 'v-1' })).toBe(
      true,
    );
    expect(
      libroDineroPorFecha({ categoria: 'OPERACIONES', vuelo_id: 'v-1' }),
    ).toBe(false);
    expect(
      libroDineroPorFecha({ categoria: 'PERSONAL_DUENO', vuelo_id: null }),
    ).toBe(false);
  });
});

describe('fechaHoraCargaAlDia y avionesParaTextos', () => {
  it('conserva la hora de pared Cancún; ya en el día nuevo, sin hora o ilegible ⇒ null (no se toca)', () => {
    expect(fechaHoraCargaAlDia('2026-09-30T12:40:00.000Z', '2026-10-01')).toBe(
      '2026-10-01T12:40:00.000Z',
    );
    // 21:30 Cancún del 30-sep (02:30Z del 1-oct) a un día antes.
    expect(fechaHoraCargaAlDia('2026-10-01T02:30:00+00:00', '2026-09-29')).toBe(
      '2026-09-30T02:30:00.000Z',
    );
    expect(
      fechaHoraCargaAlDia('2026-10-01T12:40:00+00:00', '2026-10-01'),
    ).toBeNull();
    expect(fechaHoraCargaAlDia(null, '2026-10-01')).toBeNull();
    expect(fechaHoraCargaAlDia('ayer en la tarde', '2026-10-01')).toBeNull();
  });

  it('los aviones de los textos: balance con la fecha nueva, el del gasto y los del reparto (únicos)', () => {
    expect(avionesParaTextos(winjet(), '2026-10-12', [])).toEqual([PEV]);
    expect(avionesParaTextos(sinVuelo(), '2026-10-01', [])).toEqual([N41]);
    expect(
      avionesParaTextos(
        sinVuelo({ categoria: 'OTRO', aeronave_id: null }),
        '2026-10-01',
        [
          { aeronave_id: N41, monto: 600 },
          { aeronave_id: PEV, monto: 400 },
        ],
      ),
    ).toEqual([N41, PEV]);
  });
});

describe('ALARMA DE PARIDAD con los libros que los textos imitan', () => {
  // Se compara SIN espacios para que el formato no dispare la alarma. Si
  // alguien cambia una de estas lecturas o reglas, este spec obliga a
  // revisar `cambio-fecha-gasto.util.ts` (solo puede desfasarse un TEXTO).
  const leer = (...ruta: string[]) =>
    readFileSync(join(__dirname, '..', ...ruta), 'utf8').replace(/\s+/g, '');
  const sin = (p: string) => p.replace(/\s+/g, '');
  const enOrden = (fuente: string, ...patrones: string[]) => {
    let desde = 0;
    for (const p of patrones) {
      const i = fuente.indexOf(sin(p), desde);
      expect(i).toBeGreaterThanOrEqual(0);
      desde = i;
    }
  };

  it('balance: el predicado fechasFuera (mes del vuelo) con las categorías fuera del avión', () => {
    const balance = leer('aircraft', 'aircraft-balance.service.ts');
    expect(balance).toContain(
      sin('const CAT_FUERA_DEL_AVION = CATEGORIAS_GASTO_FUERA_DEL_AVION;'),
    );
    enOrden(
      balance,
      'const fechasFuera = vGastos.filter(',
      '!CAT_FUERA_DEL_AVION.has(g.categoria)',
      'g.fecha_gasto != null',
      '(g.fecha_gasto < desde || g.fecha_gasto > hasta)',
    );
  });

  it('Libro Dinero: «otros gastos» (sin vuelo o de empresa, sin PERSONAL_DUENO) y todo GAS, por fecha_gasto', () => {
    const dinero = leer('profit-sharing', 'dinero-report.service.ts');
    enOrden(
      dinero,
      'vuelo_id.is.null,categoria.in.(',
      '[...CATEGORIAS_GASTO_EMPRESA]',
      ".neq('categoria', 'PERSONAL_DUENO')",
      ".gte('fecha_gasto', desde)",
    );
    enOrden(dinero, ".eq('categoria', 'GAS')", ".gte('fecha_gasto', desde)");
  });

  it('reparto: el ternario de computeAvion, los grupos importados, fetchGastos por fecha_gasto y el T.C. oficial del DÍA del gasto', () => {
    const reparto = leer('profit-sharing', 'profit-sharing.service.ts');
    expect(reparto).toContain(sin("from './grupos-reparto.util'"));
    expect(reparto).toContain(sin('esTuas || esPagoVendedor'));
    expect(reparto).toContain(sin('const empresaSinReparto ='));
    expect(reparto).toContain(sin('DIRECTO.has(g.categoria)'));
    expect(reparto).toContain(
      sin('if (g.categoria !== FIJO || g.es_reparto_parcial) continue;'),
    );
    const i = reparto.indexOf(
      sin('private async fetchGastos(desde: string, hasta: string)'),
    );
    expect(i).toBeGreaterThanOrEqual(0);
    const fetchGastos = reparto.slice(
      i,
      reparto.indexOf('privateasync', i + 1),
    );
    expect(fetchGastos).toContain(sin(".gte('fecha_gasto', desde)"));
    expect(fetchGastos).toContain(sin(".lte('fecha_gasto', hasta)"));
    enOrden(
      reparto,
      "if (g.moneda !== 'MXN' || pos(g.tc_gasto) != null) continue;",
      'const dia = diaDeFecha(g.fecha_gasto ?? null);',
    );
  });
});
