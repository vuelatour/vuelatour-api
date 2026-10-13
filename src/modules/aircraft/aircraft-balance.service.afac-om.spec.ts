// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('./aircraft.service', () => ({ AircraftService: class {} }));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));

import { AircraftBalanceService } from './aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceAvionHojaGastosPayload,
  BalanceAvionPayload,
  BalanceEmpresaBloquePayload,
  BalanceHojaOtrosMovimientosPayload,
  BalanceOtroMovimientoFilaPayload,
} from '../pyservices/pyservices.service';
import type { ModoBalanceGeneral } from './balance-general-modo.util';
import {
  AV,
  DESDE,
  GOLDEN_OM,
  HASTA,
  V1,
  V2,
  fakeSupabase,
  gastoBase,
  mundoCon,
  vuelo2,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

/**
 * PERMISOS AFAC COMO FILAS QUE SUMAN en «otros movimientos» del Balance
 * general (13-oct-2026, API 0.0.74, invariante 62). Decisión 2 del lote del
 * cliente: «AFAC en "otros movimientos" del Balance general: filas en la
 * tabla principal que suman en TOTALES (provisión AFAC del periodo =
 * ingreso de VuelaTour por avión; cada permiso pagado = egreso), ya no
 * bloque informativo bajo totales».
 *
 * Contrato: `payloadGeneral` ANEXA al final de `filas` una fila «AFAC ·
 * matrícula» por avión real (ingreso = `totales.permiso_afac_mxn` de su
 * libro; egreso = Σ `monto_mxn` de su hoja «permisos»), empuja su T.C.
 * (`totales.tc_promedio`) y su «por cobrar» 0 en `tcFilasOM` y pone
 * `afac_en_filas: true` como ÚLTIMA llave; el bloque informativo `afac` ya
 * no viaja. Sin tarifa AFAC ni PERMISO con avión, el payload es el de
 * siempre (`GOLDEN_OM`).
 *
 * Mundo: el de los libros (XB-TST, vuelo #501, K 20) + tarifa AFAC 25 USD/hr
 * y tres permisos PAGADOS: g1 MXN 2,500 el 05-sep sin vuelo, g2 USD 100 con
 * `tc_gasto` 18 el 12-sep sin vuelo (1,800 MXN) y g3 MXN 1,000 ligado al
 * #501 con `fecha_gasto` 03-OCT (fuera del periodo: cuenta en el MES DEL
 * VUELO, como en su hoja «permisos»).
 */

/** Vigencia de las comisiones a cargo del avión POSTERIOR a septiembre. */
const POSTERIOR = '2026-12-01';
const TARIFA = 25;

const G1: Fila = {
  ...gastoBase,
  id: 'g-permiso-1',
  aeronave_id: AV,
  categoria: 'PERMISO',
  monto: 2500,
  fecha_gasto: '2026-09-05',
  notas: 'AFAC anual',
};
const G2: Fila = {
  ...gastoBase,
  id: 'g-permiso-2',
  aeronave_id: AV,
  categoria: 'PERMISO',
  monto: 100,
  moneda: 'USD',
  tc_gasto: 18,
  fecha_gasto: '2026-09-12',
  notas: 'Internación',
};
const G3: Fila = {
  ...gastoBase,
  id: 'g-permiso-3',
  vuelo_id: V1,
  vuelo: { folio: 501, aeronave_id: AV },
  categoria: 'PERMISO',
  monto: 1000,
  fecha_gasto: '2026-10-03',
  notas: 'Permiso nocturno MID',
};
/** P = lo que pagó el XB-TST en permisos en el periodo (2,500 + 1,800 + 1,000). */
const P = 5300;

function conTarifa(
  mundo: Record<string, Fila[]>,
  tarifas: Record<string, number>,
): Record<string, Fila[]> {
  return {
    ...mundo,
    aeronave: mundo.aeronave.map((a) =>
      tarifas[a.id as string] != null
        ? { ...a, permiso_afac_usd_hr: tarifas[a.id as string] }
        : a,
    ),
  };
}

/** El mundo AFAC: tarifa 25 en el XB-TST + g1, g2 y g3 (+ gastos extra). */
function mundoAfac(extra: Fila[] = []): Record<string, Fila[]> {
  return conTarifa(mundoCon({ gastos: [G1, G2, G3, ...extra] }), {
    [AV]: TARIFA,
  });
}

type General = {
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
  gastos_empresa: BalanceAvionHojaGastosPayload;
  empresa: BalanceEmpresaBloquePayload;
  variante: ModoBalanceGeneral;
};

function servicio(mundo: Record<string, Fila[]>) {
  const enviados: { general?: General } = {};
  const service = new AircraftBalanceService(
    fakeSupabase(mundo).supabase as unknown as SupabaseService,
    {
      generateBalanceGeneralXlsx: (p: General) => {
        enviados.general = p;
        return Promise.resolve(Buffer.from('xlsx'));
      },
    } as never,
    { proximoServicio: () => null } as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
    { fecha: () => Promise.resolve(POSTERIOR) } as never,
  );
  return { service, enviados };
}

/** El payload COMPLETO del Balance general (lo que recibe pyservices). */
async function general(
  mundo: Record<string, Fila[]>,
  modo: ModoBalanceGeneral = 'mensual',
): Promise<General> {
  const { service, enviados } = servicio(mundo);
  await service.xlsxGeneral(DESDE, HASTA, modo);
  return enviados.general!;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const om = (g: General): BalanceHojaOtrosMovimientosPayload =>
  g.consolidado.otros_movimientos!;
const filasAfac = (g: General): BalanceOtroMovimientoFilaPayload[] =>
  om(g).filas.filter((f) => f.seccion === 'AFAC');
const libroDe = (g: General, matricula: string): BalanceAvionPayload =>
  g.aviones.find((a) => a.matricula === matricula)!;
/** Marca del amarillo de pyservices (`_MARCA_PROVISION`). */
const MARCA_PROVISION = /·\s*PROVISI[OÓ]N\s*\(/;

/**
 * Dinero total del general (receta de `comisiones-general.spec`): Σ
 * ganancia de los vuelos de los libros + Σ remanente de la pestaña.
 */
function dineroTotal(g: General): number {
  return r2(
    g.consolidado.vuelos.reduce((a, v) => a + (v.ganancia_mxn ?? 0), 0) +
      [...om(g).filas, ...om(g).filas_sueltas].reduce(
        (a, f) => a + (f.remanente_mxn ?? 0),
        0,
      ),
  );
}

describe('Balance GENERAL — PERMISOS AFAC como filas que SUMAN en «otros movimientos» (invariante 62)', () => {
  it('(1) la fila «AFAC · XB-TST» va AL FINAL de `filas`: ingreso = la provisión del libro (Σ columna T), egreso = su hoja «permisos» (g3 en el MES DEL VUELO)', async () => {
    const g = await general(mundoAfac());
    const tst = libroDe(g, 'XB-TST');
    const filas = om(g).filas;
    const fila = filas.at(-1)!;
    expect(fila.clave).toBe('AFAC · XB-TST');
    expect(fila.seccion).toBe('AFAC');
    expect(Object.keys(fila).at(-1)).toBe('seccion');
    expect('estado' in fila).toBe(false);
    expect(fila.avion_color).toBe(tst.avion_color);
    expect([fila.fecha_vuelo, fila.fecha_ingreso, fila.factura]).toEqual([
      null,
      null,
      null,
    ]);
    // INGRESO = la provisión TAL CUAL la trae el libro (nadie la recalcula).
    const provisionFilas = r2(
      tst.vuelos.reduce((a, v) => a + (v.permiso_afac_mxn ?? 0), 0),
    );
    expect(provisionFilas).toBeGreaterThan(0);
    expect(tst.totales.permiso_afac_mxn).toBe(provisionFilas);
    expect(fila.ingreso_mxn).toBe(tst.totales.permiso_afac_mxn);
    expect(fila.concepto_ingreso).toBe(
      'provisión AFAC del periodo · 1 vuelo · tarifa 25.00 USD/hr',
    );
    expect(fila.nota_ingreso).toBe(
      [
        'Provisión AFAC de cada vuelo de XB-TST (columna PERMISO AFAC de su hoja de vuelos): tarifa 25.00 USD/hr × T.C. de costos × horas cobradas',
        `${tst.vuelos[0].clave} = $${provisionFilas.toLocaleString('es-MX', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`,
      ].join('\n'),
    );
    // EGRESO = Σ de la hoja «permisos» del libro: g1 + g2 (1,800) + g3 (del
    // #501 aunque se pagó el 03-oct: cuenta en el mes del vuelo).
    expect(tst.permisos.filas).toHaveLength(3);
    expect(tst.permisos.total_mxn).toBe(P);
    expect(fila.egreso_mxn).toBe(tst.permisos.total_mxn);
    expect(fila.concepto_egreso).toBe(
      'permisos AFAC pagados · 3 conceptos (ver nota)',
    );
    expect(fila.fecha_egreso).toBe('2026-09-05');
    expect(fila.nota_egreso).toBe(
      [
        'permiso AFAC pagado · AFAC anual = $2,500.00 · 05/09/2026',
        'permiso AFAC pagado · Internación = $1,800.00 · 12/09/2026',
        'permiso AFAC pagado · Permiso nocturno MID = $1,000.00 · 03/10/2026',
      ].join('\n'),
    );
    expect(fila.remanente_mxn).toBe(r2(fila.ingreso_mxn! - fila.egreso_mxn!));
    // Las filas de antes, intactas (la AFAC se ANEXA; las sueltas no cambian).
    expect(filas.slice(0, -1)).toEqual(GOLDEN_OM.filas);
    expect(om(g).filas_sueltas).toEqual(GOLDEN_OM.filas_sueltas);
    expect(filasAfac(g)).toHaveLength(1);
    // Ningún texto con la marca del amarillo.
    for (const t of [
      fila.concepto_ingreso,
      fila.nota_ingreso,
      fila.concepto_egreso,
      fila.nota_egreso,
    ]) {
      expect(t).not.toMatch(MARCA_PROVISION);
    }
  });

  it('(2) `afac_en_filas: true` es la ÚLTIMA llave y el bloque informativo `afac` ya no viaja', async () => {
    const g = await general(mundoAfac());
    const hoja = om(g);
    expect(hoja.afac_en_filas).toBe(true);
    expect(Object.keys(hoja).at(-1)).toBe('afac_en_filas');
    expect('afac' in hoja).toBe(false);
  });

  it('(3) Σ remanente de toda la pestaña == Σ ingresos − Σ egresos (la fila AFAC suma en TOTALES como cualquiera)', async () => {
    const g = await general(mundoAfac());
    const todas = [...om(g).filas, ...om(g).filas_sueltas];
    const s = (k: 'ingreso_mxn' | 'egreso_mxn' | 'remanente_mxn') =>
      r2(todas.reduce((a, f) => a + (f[k] ?? 0), 0));
    expect(s('remanente_mxn')).toBe(r2(s('ingreso_mxn') - s('egreso_mxn')));
  });

  it('(4) bloque VUELATOUR: ingresos y egresos propios suben EXACTAMENTE la fila AFAC ÷ el T.C. promedio del libro; la nota lo dice', async () => {
    const base = await general(mundoCon());
    const g = await general(mundoAfac());
    const tst = libroDe(g, 'XB-TST');
    const tc = tst.totales.tc_promedio!;
    expect(tc).toBeGreaterThan(0);
    const fila = filasAfac(g)[0];
    const e = g.empresa;
    expect(e.movimientos_sin_tc).toBe(base.empresa.movimientos_sin_tc);
    expect(
      Math.abs(
        e.ingresos_propios_usd! -
          r2(base.empresa.ingresos_propios_usd! + fila.ingreso_mxn! / tc),
      ),
    ).toBeLessThanOrEqual(0.01 + 1e-9);
    expect(
      Math.abs(
        e.pagos_vendedor_usd! -
          r2(base.empresa.pagos_vendedor_usd! + fila.egreso_mxn! / tc),
      ),
    ).toBeLessThanOrEqual(0.01 + 1e-9);
    expect(e.nota).toContain(
      "hoja 'otros movimientos' (por vuelo, AFAC por avión y sueltas)",
    );
    expect(e.nota).toContain(
      'las filas «AFAC · matrícula» con el T.C. promedio de costos del libro de su avión (sin vuelos, el oficial del cierre)',
    );
    expect(e.nota).toContain(
      'más la provisión AFAC del periodo de cada avión (la que ese avión ya carga como costo en su columna PERMISO AFAC)',
    );
    expect(e.nota).toContain(
      'comisión bancaria, permisos AFAC pagados y gastos sueltos.',
    );
  });

  it('(5) CONSERVACIÓN en dos identidades: la provisión NETEA (−T en el avión, +T en la pestaña) y el permiso pagado egresa UNA vez en la pestaña… además de restar en la cascada del avión (doble conteo VIVO, pregunta abierta)', async () => {
    const base = await general(mundoCon());
    const g = await general(mundoAfac());
    const tst = libroDe(g, 'XB-TST');
    const fila = filasAfac(g)[0];
    // (a) Σ ganancia de los vuelos (ya sin la provisión T) + Σ remanente
    // de la pestaña (+T − P) == el mundo sin AFAC − P.
    expect(dineroTotal(g)).toBe(r2(dineroTotal(base) - P));
    // (b) ALERTA DE DINERO (riesgo 1 de la decisión 2; «Pendientes
    // conocidos» del CLAUDE.md): el MISMO permiso pagado YA resta en la
    // cascada del avión (hoja «permisos» → `permisos_usd` → utilidad
    // cobrada → socios y, en el reparto, el grupo PERMISO) Y ADEMÁS egresa
    // en VuelaTour. Pregunta al cliente: «¿el permiso AFAC pagado deja de
    // restar en el avión ahora que es egreso de VuelaTour, o se queda en
    // los dos?». Si responde «sale del avión», ESTA aserción cambia (la
    // cascada), no la pestaña.
    expect(tst.balance.permisos_usd).toBe(r2(P / tst.totales.tc_promedio!));
    expect(fila.egreso_mxn).toBe(P);
  });

  it('(6) SIN tarifa AFAC ni PERMISO con avión: payload de la pestaña BYTE A BYTE el de siempre y la nota del bloque sin AFAC', async () => {
    const g = await general(mundoCon());
    expect(JSON.stringify(om(g))).toBe(JSON.stringify(GOLDEN_OM));
    expect('afac_en_filas' in om(g)).toBe(false);
    expect(g.empresa.nota).toContain(
      "Ingresos y egresos propios: hoja 'otros movimientos' (por vuelo y sueltas), cada fila a USD con el T.C. de su vuelo; las sueltas con su T.C. o el oficial del día.",
    );
    expect(g.empresa.nota).not.toContain('AFAC');
    // Solo la tarifa (sin vuelos con horas cobradas no hay provisión) o
    // solo un permiso sin avión tampoco generan fila: ver (10).
  });

  it('(7) una fila por avión real en el orden de `aviones` (el de los bloques de «balance»); el libro EXTERNOS nunca genera fila y su PERMISO se queda en su libro', async () => {
    const AV2 = 'av-2';
    const V9 = 'v-9';
    const f2 = '2026-09-20T15:00:00+00:00';
    const f9 = '2026-09-25T15:00:00+00:00';
    const escala = (
      id: string,
      vueloId: string,
      fecha: string,
      avion: string | null,
      tacos: [number | null, number | null],
    ): Fila => ({
      id,
      vuelo_id: vueloId,
      orden: 1,
      aeronave_id: null,
      cancelada_at: null,
      taco_salida: tacos[0],
      taco_llegada: tacos[1],
      solo_operativa: false,
      es_ferry: false,
      origen_iata: 'CUN',
      destino_iata: 'CZM',
      es_sobrevuelo: false,
      tipo_parada: 'NORMAL',
      pasajeros: 2,
      fecha_salida_plan: fecha,
      vuelo: { fecha_vuelo: fecha, aeronave_id: avion },
    });
    const m = mundoAfac([
      {
        ...gastoBase,
        id: 'g-permiso-externo',
        vuelo_id: V9,
        vuelo: { folio: 509, aeronave_id: null },
        categoria: 'PERMISO',
        monto: 700,
        notas: 'Permiso del operador externo',
      },
    ]);
    const mundo = conTarifa(
      {
        ...m,
        aeronave: [
          ...m.aeronave,
          {
            id: AV2,
            // «XA-…» va ANTES que «XB-TST» en los bloques de «balance».
            matricula: 'XA-DOS',
            modelo: 'C206',
            color_calendario: '#10B981',
            permiso_afac_usd_hr: null,
            servicio_intervalos: [],
            servicio_horas_base: 0,
          },
        ],
        vuelo: [
          ...m.vuelo,
          vuelo2({ aeronave_id: AV2 }),
          vuelo2({
            id: V9,
            folio: 509,
            aeronave_id: null,
            es_externo: true,
            operador_externo: 'Operador Ajeno',
            costo_externo_usd: 500,
            fecha_vuelo: f9,
          }),
        ],
        escala: [
          ...m.escala,
          escala('e-2', V2, f2, AV2, [200, 201]),
          escala('e-9', V9, f9, null, [null, null]),
        ],
      },
      { [AV2]: 30 },
    );
    const g = await general(mundo);
    const afac = filasAfac(g);
    const conAfac = g.aviones.filter(
      (a) =>
        (a.totales.permiso_afac_mxn ?? 0) !== 0 ||
        (a.permisos?.filas ?? []).length > 0,
    );
    expect(g.aviones.map((a) => a.matricula)).toEqual(['XA-DOS', 'XB-TST']);
    expect(afac.map((f) => f.clave)).toEqual(
      conAfac.map((a) => `AFAC · ${a.matricula}`),
    );
    expect(afac.map((f) => f.clave)).toEqual([
      'AFAC · XA-DOS',
      'AFAC · XB-TST',
    ]);
    // XA-DOS: solo provisión (tarifa 30, sin permisos pagados).
    const dos = libroDe(g, 'XA-DOS');
    expect(afac[0].ingreso_mxn).toBe(dos.totales.permiso_afac_mxn);
    expect(afac[0].concepto_ingreso).toBe(
      'provisión AFAC del periodo · 1 vuelo · tarifa 30.00 USD/hr',
    );
    expect([afac[0].concepto_egreso, afac[0].egreso_mxn]).toEqual([null, null]);
    expect(afac[0].avion_color).toBe('#10B981');
    // Las filas AFAC van DESPUÉS de la última fila por vuelo.
    const primera = om(g).filas.findIndex((f) => f.seccion === 'AFAC');
    expect(
      om(g)
        .filas.slice(primera)
        .every((f) => f.seccion === 'AFAC'),
    ).toBe(true);
    // EXTERNOS: sin fila; su PERMISO sigue en su libro (la hoja «permisos»
    // de la flota lo trae) y no egresa en VuelaTour.
    expect(g.aviones.some((a) => a.matricula === 'EXTERNOS')).toBe(false);
    expect(afac.some((f) => f.clave.includes('EXTERNOS'))).toBe(false);
    const textoAfac = afac
      .flatMap((f) => [f.concepto_egreso, f.nota_egreso])
      .join('\n');
    expect(textoAfac).not.toContain('Permiso del operador externo');
    expect(
      g.consolidado.permisos.filas.some((f) =>
        String(f.detalle).includes('Permiso del operador externo'),
      ),
    ).toBe(true);
    expect(afac[1].egreso_mxn).toBe(P);
  });

  it('(8) inverso del caso «consolidado == buildOtrosMovimientos directo»: con AFAC, las filas son las directas MÁS las AFAC al final', async () => {
    const mundo = mundoAfac();
    const g = await general(mundo);
    const { service } = servicio(mundo);
    const priv = service as unknown as {
      gastosEmpresaYSueltos: (d: string, h: string) => Promise<unknown>;
      buildOtrosMovimientos: (
        d: string,
        h: string,
        memo: Map<string, unknown>,
        e: unknown,
      ) => Promise<BalanceHojaOtrosMovimientosPayload>;
    };
    const solo = await priv.buildOtrosMovimientos(
      DESDE,
      HASTA,
      new Map(),
      await priv.gastosEmpresaYSueltos(DESDE, HASTA),
    );
    const afac = filasAfac(g);
    expect(afac).toHaveLength(1);
    expect(om(g).filas).toEqual([...solo.filas, ...afac]);
    // Fuera de las filas AFAC y su bandera, el objeto es el directo, byte a byte.
    const { afac_en_filas: bandera, ...resto } = om(g);
    expect(bandera).toBe(true);
    expect(
      JSON.stringify({ ...resto, filas: resto.filas.slice(0, -afac.length) }),
    ).toBe(JSON.stringify(solo));
    // `buildOtrosMovimientos` no conoce los libros: nunca trae filas AFAC.
    expect(solo.filas.some((f) => f.seccion === 'AFAC')).toBe(false);
    expect('afac_en_filas' in solo).toBe(false);
  });

  it('(9) `modo: general` (costo por hora) produce las MISMAS filas AFAC que el mensual (la provisión sale de `totales`, no de la hoja)', async () => {
    const mensual = await general(mundoAfac(), 'mensual');
    const gen = await general(mundoAfac(), 'general');
    expect(gen.variante).toBe('general');
    expect(mensual.variante).toBe('mensual');
    expect(filasAfac(gen)).toEqual(filasAfac(mensual));
    expect(om(gen).afac_en_filas).toBe(true);
    expect(gen.empresa).toEqual(mensual.empresa);
  });

  it('(10) un PERMISO sin avión ni vuelo sigue en «otros gastos» (UNA vez) y no entra a la fila AFAC', async () => {
    const empresa: Fila = {
      ...gastoBase,
      id: 'g-permiso-empresa',
      categoria: 'PERMISO',
      monto: 400,
      notas: 'Permiso de empresa',
    };
    const con = await general(mundoAfac([empresa]));
    const sin = await general(mundoAfac());
    expect(filasAfac(con)).toEqual(filasAfac(sin));
    expect(
      con.gastos_empresa.filas.filter((f) =>
        String(f.detalle).includes('Permiso de empresa'),
      ),
    ).toHaveLength(1);
    expect(
      r2(con.gastos_empresa.total_mxn - sin.gastos_empresa.total_mxn),
    ).toBe(400);
    // Sin tarifa y sin permisos con avión, un permiso de empresa NO crea fila.
    const soloEmpresa = await general(mundoCon({ gastos: [empresa] }));
    expect(filasAfac(soloEmpresa)).toEqual([]);
    expect('afac_en_filas' in om(soloEmpresa)).toBe(false);
  });
});
