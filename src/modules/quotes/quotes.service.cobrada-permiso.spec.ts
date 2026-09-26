// Módulos pesados que quotes.service importa solo para inyección: se
// sustituyen por clases vacías — notifications arrastra el gateway y `jose`
// (ESM puro), calendar-sync googleapis.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { ConflictException } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { MetodoPago, TipoTarifa, TipoVuelo } from './dto/calculate-quote.dto';
import type { ReviseQuoteDto } from './dto/revise-quote.dto';
import type { AircraftService } from '../aircraft/aircraft.service';
import type { FlightsService } from '../flights/flights.service';
import type { AirportsService } from '../airports/airports.service';
import type { RoutesService } from '../routes/routes.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';

/**
 * PERMISO ESPECIAL «EDITAR COTIZACIONES COBRADAS» (26-sep-2026, API 0.0.37).
 *
 * Pedido de Alejandro y Pablo Canales (WhatsApp, cotizaciones #305 y #317):
 * «un vuelo que se cobró en efectivo pero estaba cotizado como para
 * transferencia, entonces tenía IVA … Yo necesito que eso se desbloquee
 * para mí, no para todos». El permiso es por PERSONA (lista
 * `editores_cotizacion_cobrada`), no por rol: Alejandro Villalobos también es
 * ADMIN y NO lo tiene.
 *
 * Aquí se prueba el CONTRATO de `revise`/`quickAdjust` con un Supabase
 * simulado: quién pasa el candado D3, qué candados siguen, que los COBROS no
 * se escriben, que la bandera `cobrado` se recalcula, el aviso de saldo /
 * sobrecobro, el prefijo del motivo y `edicion_con_cobros`.
 */
type Row = Record<string, unknown>;
type Op = { m: string; args: unknown[] };

const SENECA = 'aaaaaaaa-0000-4000-8000-0000000seneca';
const V305 = 'vvvvvvvv-0000-4000-8000-000000000305';
const ALE = 'c691cc8b-3034-4f04-a383-d0b25c1971ec'; // Alejandro Canales
const PABLO = 'e5aa04a8-ac24-446a-b41d-9af5917cd4f1'; // Pablo Canales
const VILLALOBOS = 'ee3c5690-467c-481d-940f-f4c06010155f'; // ADMIN sin permiso
const EDITORES = [
  { id: ALE, nombre: 'Alejandro Canales' },
  { id: PABLO, nombre: 'Pablo Canales' },
];

const FICHA_SENECA: Row = {
  id: SENECA,
  activa: true,
  matricula: 'XA-VGV',
  modelo: 'PIPER SENECA V',
  pais_registro: 'MX',
  velocidad_crucero_kts: 170,
  tarifa_hora_pub_usd: 1000,
  tarifa_hora_broker_usd: 900,
};

function vueloRow(extra: Row = {}): Row {
  return {
    id: V305,
    folio: 305,
    cliente_id: null,
    aeronave_id: SENECA,
    estado: 'CONFIRMADO',
    es_externo: false,
    cotizacion_version: 1,
    facturado: false,
    cobrado: false,
    itinerario_operativo: false,
    // Cotizado por TRANSFERENCIA: $1,000 + IVA 16 % = $1,160.
    monto_total_usd: 1160,
    metodo_cobro: 'TRANSFERENCIA',
    tc_usd_mxn: null,
    fecha_vuelo: new Date().toISOString(),
    fecha_traslado_final: null,
    extras: [],
    calculo_snapshot: {
      aeronave: { id: SENECA, matricula: 'XA-VGV', modelo: 'PIPER SENECA V' },
    },
    notas: null,
    grupo_id: null,
    ...extra,
  };
}

interface Mundo {
  vuelo?: Row;
  /** Filas de `cobro_vuelo` del vuelo. */
  cobros?: Row[];
  /** Ids con el permiso especial; `null` = sin ConfiguracionService (legado). */
  editores?: string[] | null;
  /** La lectura de la lista falla (el service responde false: falla cerrado). */
  listaIlegible?: boolean;
  /**
   * Fallos DESPUÉS de guardar la versión (refreshCobradoTrasRecotizar): la
   * re-lectura de los cobros o el UPDATE de la bandera `cobrado`.
   */
  fallaTrasGuardar?: 'releer_cobros' | 'update_cobrado';
}

function armar(m: Mundo = {}) {
  const updates: { tabla: string; patch: Row; ops: Op[] }[] = [];
  const inserts: { tabla: string; fila: Row }[] = [];
  const escrituras: { tabla: string; op: string }[] = [];
  let vuelo = m.vuelo ?? vueloRow();
  const escala: Row = {
    id: 'e-1',
    vuelo_id: V305,
    orden: 1,
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    aeronave_id: SENECA,
    millas_nauticas: 80,
    pasajeros: 3,
    es_ferry: false,
    solo_operativa: false,
    cancelada_at: null,
    taco_salida: null,
    taco_llegada: null,
    tipo_parada: 'NORMAL',
    requiere_pernocta: false,
    fecha_salida_plan: null,
  };
  const cobros = m.cobros ?? [];
  const supabase = {
    service: {
      from(tabla: string) {
        const ops: Op[] = [];
        const q: Record<string, unknown> = {};
        const selectDe = () => {
          const sel = ops.find((o) => o.m === 'select')?.args[0];
          return typeof sel === 'string' ? sel : '';
        };
        const resolve = (lista: boolean): Row => {
          const upd = ops.find((o) => o.m === 'update');
          const ins = ops.find((o) => o.m === 'insert');
          const del = ops.find((o) => o.m === 'delete');
          if (upd) {
            updates.push({ tabla, patch: upd.args[0] as Row, ops });
            escrituras.push({ tabla, op: 'update' });
          }
          if (ins) {
            inserts.push({ tabla, fila: ins.args[0] as Row });
            escrituras.push({ tabla, op: 'insert' });
          }
          if (del) escrituras.push({ tabla, op: 'delete' });
          if (tabla === 'vuelo') {
            if (
              upd &&
              m.fallaTrasGuardar === 'update_cobrado' &&
              'cobrado' in (upd.args[0] as Row) &&
              !('cotizacion_version' in (upd.args[0] as Row))
            ) {
              return { data: null, error: { message: 'timeout' } };
            }
            if (upd) {
              vuelo = { ...vuelo, ...(upd.args[0] as Row) };
              return { data: vuelo };
            }
            return lista ? { data: [vuelo] } : { data: vuelo };
          }
          if (tabla === 'cobro_vuelo') {
            // La re-lectura de refreshCobradoTrasRecotizar NO pide
            // `cobro_grupo_id` (la del candado sí).
            if (
              m.fallaTrasGuardar === 'releer_cobros' &&
              !selectDe().includes('cobro_grupo_id')
            ) {
              return { data: null, error: { message: 'ECONNRESET' } };
            }
            return lista ? { data: cobros } : { data: cobros[0] ?? null };
          }
          if (tabla === 'escala') {
            if (upd || ins) return { data: escala };
            const sel = selectDe();
            if (sel === 'aeronave_id') return { data: escala };
            if (sel === 'orden, destino_iata') return { data: [] };
            return lista ? { data: [escala] } : { data: escala };
          }
          if (tabla === 'aeronave') {
            return lista ? { data: [FICHA_SENECA] } : { data: FICHA_SENECA };
          }
          return lista ? { data: [] } : { data: null };
        };
        for (const met of [
          'select',
          'eq',
          'neq',
          'in',
          'is',
          'not',
          'or',
          'gte',
          'lte',
          'order',
          'limit',
          'range',
          'insert',
          'update',
          'delete',
        ]) {
          q[met] = (...args: unknown[]) => {
            ops.push({ m: met, args });
            return q;
          };
        }
        q.maybeSingle = () =>
          Promise.resolve({ error: null, ...resolve(false) });
        q.single = () => Promise.resolve({ error: null, ...resolve(false) });
        q.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ error: null, ...resolve(true) }).then(res);
        return q;
      },
    },
  } as unknown as SupabaseService;

  const aircraft = {
    findById: jest.fn(() => Promise.resolve(FICHA_SENECA)),
  } as unknown as AircraftService;
  const airports = {
    computeTuasUsdPax: jest
      .fn()
      .mockResolvedValue({ aplica: false, usd_pax: 0, razon: 'exenta' }),
    refreshPermisosDeVuelo: jest.fn().mockResolvedValue(undefined),
  } as unknown as AirportsService;
  const flights = {
    validateAssignTargets: jest
      .fn()
      .mockResolvedValue({ squawksAceptados: [], avisos: [] }),
    notificarSquawkAceptado: jest.fn(),
    avisoTallerDe: jest.fn().mockResolvedValue([]),
  } as unknown as FlightsService;
  const puedeEditarCotizacionCobrada = jest.fn(
    (uid: string | null | undefined) =>
      Promise.resolve(
        m.listaIlegible ? false : (m.editores ?? []).includes(uid ?? ''),
      ),
  );
  const editoresCotizacionCobradaNombres = jest.fn(() =>
    Promise.resolve(
      m.listaIlegible
        ? []
        : EDITORES.filter((e) => (m.editores ?? []).includes(e.id)),
    ),
  );
  const configuracion =
    m.editores === null
      ? undefined
      : ({
          puedeEditarCotizacionCobrada,
          editoresCotizacionCobradaNombres,
        } as unknown as ConfiguracionService);
  const service = new QuotesService(
    aircraft,
    airports,
    {} as RoutesService,
    supabase,
    { syncFlight: jest.fn() } as unknown as CalendarSyncService,
    {} as EmailService,
    {
      notifyUser: jest.fn().mockResolvedValue(true),
      notifyRole: jest.fn().mockResolvedValue(true),
    } as unknown as NotificationsService,
    flights,
    // `facturaSolicitud` (@Optional) no interviene en la revisión.
    undefined,
    configuracion,
  );
  /** El UPDATE de la revisión (el que escribe montos y snapshot). */
  const patchRevision = () =>
    updates.find((u) => u.tabla === 'vuelo' && 'cotizacion_version' in u.patch)
      ?.patch ?? null;
  /** El UPDATE de la bandera `cobrado` (refreshCobradoTrasRecotizar). */
  const patchCobrado = () =>
    updates.find(
      (u) =>
        u.tabla === 'vuelo' &&
        'cobrado' in u.patch &&
        !('cotizacion_version' in u.patch),
    )?.patch ?? null;
  const version = () =>
    inserts.find((i) => i.tabla === 'cotizacion_version_history')?.fila ?? null;
  return {
    service,
    updates,
    inserts,
    escrituras,
    patchRevision,
    patchCobrado,
    version,
    puedeEditarCotizacionCobrada,
    editoresCotizacionCobradaNombres,
  };
}

function dto(extra: Partial<ReviseQuoteDto> = {}): ReviseQuoteDto {
  return {
    aeronave_id: SENECA,
    tipo: TipoVuelo.MULTIESCALA,
    escalas: [{ origen_iata: 'CUN', destino_iata: 'HOL', millas_nauticas: 80 }],
    tipo_tarifa: TipoTarifa.PUBLICO,
    pasajeros: 3,
    // Se cobró en EFECTIVO: sin IVA.
    metodo_pago: MetodoPago.EFECTIVO,
    motivo: 'Se cobró en efectivo: sin IVA',
    ...extra,
  };
}

const cobroUsd = (monto: number, extra: Row = {}): Row => ({
  id: `cob-${monto}`,
  monto,
  moneda: 'USD',
  tc_usd_mxn: null,
  cobro_grupo_id: null,
  ...extra,
});

async function error409(p: Promise<unknown>): Promise<Row> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConflictException);
  return (err as ConflictException).getResponse() as Row;
}

describe('QuotesService.revise — permiso especial «editar cotizaciones cobradas»', () => {
  it('un EDITOR de la lista revisa con cobros: versión nueva, cobros intactos, aviso de saldo y edicion_con_cobros', async () => {
    const w = armar({ cobros: [cobroUsd(600)], editores: [ALE, PABLO] });
    const r = (await w.service.revise(V305, dto(), ALE)) as Row;

    const patch = w.patchRevision()!;
    expect(patch).not.toBeNull();
    expect(patch.cotizacion_version).toBe(2);
    expect(patch.metodo_cobro).toBe('EFECTIVO');
    expect(Number(patch.iva_usd)).toBe(0);
    const total = Number(patch.monto_total_usd);
    expect(total).toBe(1000);

    // La lista se lee SIN caché (una baja aplica al instante).
    expect(w.puedeEditarCotizacionCobrada).toHaveBeenCalledWith(ALE, {
      usarCache: false,
    });
    // Los COBROS no se tocan (el ingreso sigue saliendo de cobrosEnUsd).
    expect(w.escrituras.filter((e) => e.tabla === 'cobro_vuelo')).toEqual([]);
    expect(r.edicion_con_cobros).toBe(true);
    expect(r.avisos).toContain(
      'Se editó con cobros registrados: cobrado $600 USD, nuevo total $1,000 USD, saldo $400 USD. Los cobros no se modificaron.',
    );
    // El historial delata la excepción.
    expect(w.version()!.motivo).toBe(
      '[Con cobros · permiso especial] Se cobró en efectivo: sin IVA',
    );
  });

  it('Pablo (el otro editor) también pasa', async () => {
    const w = armar({ cobros: [cobroUsd(600)], editores: [ALE, PABLO] });
    const r = (await w.service.revise(V305, dto(), PABLO)) as Row;
    expect(r.edicion_con_cobros).toBe(true);
  });

  it('refreshCobradoFlag: quitar el IVA deja el vuelo LIQUIDADO ⇒ cobrado=true («Pagado») y saldo $0', async () => {
    // #305: cotizado con IVA, entró el efectivo por el total sin IVA.
    const w = armar({ cobros: [cobroUsd(1000)], editores: [ALE] });
    const r = (await w.service.revise(V305, dto(), ALE)) as Row;
    expect(w.patchCobrado()).toMatchObject({ cobrado: true, updated_by: ALE });
    expect(r.cobrado).toBe(true);
    expect(r.avisos).toContain(
      'Se editó con cobros registrados: cobrado $1,000 USD, nuevo total $1,000 USD, saldo $0 USD. Los cobros no se modificaron.',
    );
  });

  it('diferencia de REDONDEO (≤ $1): el aviso dice saldo $0 y la diferencia, igual que la bandera «Pagado» y el panel', async () => {
    const w = armar({ cobros: [cobroUsd(999.5)], editores: [ALE] });
    const r = (await w.service.revise(V305, dto(), ALE)) as Row;
    expect(w.patchCobrado()).toMatchObject({ cobrado: true });
    expect(r.cobrado).toBe(true);
    expect(r.avisos).toContain(
      'Se editó con cobros registrados: cobrado $999.50 USD, nuevo total $1,000 USD, saldo $0 USD (diferencia de redondeo de $0.50 USD). Los cobros no se modificaron.',
    );
  });

  it('tras GUARDAR, si la re-lectura de cobros falla: 200 con aviso (sin 500 que invite a guardar otra vez), bandera intacta y saldo con lo leído antes', async () => {
    const w = armar({
      cobros: [cobroUsd(600)],
      editores: [ALE],
      fallaTrasGuardar: 'releer_cobros',
    });
    const r = (await w.service.revise(V305, dto(), ALE)) as Row;
    expect(w.version()).not.toBeNull();
    expect(w.patchCobrado()).toBeNull();
    expect(r.cobrado).toBe(false);
    expect(
      (r.avisos as string[]).some((a) =>
        a.startsWith(
          'La versión se guardó, pero no se pudieron leer los cobros para recalcular el estado «Pagado» del vuelo (ECONNRESET).',
        ),
      ),
    ).toBe(true);
    expect(r.avisos).toContain(
      'Se editó con cobros registrados: cobrado $600 USD, nuevo total $1,000 USD, saldo $400 USD. Los cobros no se modificaron.',
    );
  });

  it('tras GUARDAR, si el UPDATE de la bandera falla: 200 con aviso y la respuesta NO dice «pagado»', async () => {
    const w = armar({
      cobros: [cobroUsd(1000)],
      editores: [ALE],
      fallaTrasGuardar: 'update_cobrado',
    });
    const r = (await w.service.revise(V305, dto(), ALE)) as Row;
    expect(w.version()).not.toBeNull();
    expect(r.cobrado).toBe(false);
    expect(
      (r.avisos as string[]).some((a) =>
        a.startsWith(
          'La versión se guardó, pero el estado «Pagado» del vuelo no se pudo actualizar (timeout).',
        ),
      ),
    ).toBe(true);
  });

  it('SOBRECOBRO: lo cobrado rebasa el total nuevo ⇒ aviso «sobrecobro» y el vuelo queda pagado', async () => {
    const w = armar({ cobros: [cobroUsd(1160)], editores: [ALE] });
    const r = (await w.service.revise(V305, dto(), ALE)) as Row;
    expect(r.avisos).toContain(
      'Se editó con cobros registrados: cobrado $1,160 USD, nuevo total $1,000 USD, sobrecobro $160 USD. Los cobros no se modificaron.',
    );
    expect(w.patchCobrado()).toMatchObject({ cobrado: true });
  });

  it('refreshCobradoFlag al revés: un vuelo pagado que SUBE de total deja de estar cobrado', async () => {
    const w = armar({
      vuelo: vueloRow({ cobrado: true, monto_total_usd: 1000 }),
      cobros: [cobroUsd(1000)],
      editores: [ALE],
    });
    const r = (await w.service.revise(
      V305,
      dto({ metodo_pago: MetodoPago.TRANSFERENCIA }),
      ALE,
    )) as Row;
    expect(w.patchCobrado()).toMatchObject({ cobrado: false });
    expect(r.cobrado).toBe(false);
    expect(r.avisos).toContain(
      'Se editó con cobros registrados: cobrado $1,000 USD, nuevo total $1,160 USD, saldo $160 USD. Los cobros no se modificaron.',
    );
  });

  it('cobro en PESOS convertido (#317): el saldo usa cobrosEnUsd con el T.C. del cobro', async () => {
    const w = armar({
      cobros: [cobroUsd(17500, { moneda: 'MXN', tc_usd_mxn: 17.5 })],
      editores: [ALE],
    });
    const r = (await w.service.revise(V305, dto(), ALE)) as Row;
    expect(r.avisos).toContain(
      'Se editó con cobros registrados: cobrado $1,000 USD, nuevo total $1,000 USD, saldo $0 USD. Los cobros no se modificaron.',
    );
  });

  it('cobro MXN sin tipo de cambio: se revisa y el aviso lo dice aparte', async () => {
    const w = armar({
      cobros: [cobroUsd(18000, { moneda: 'MXN', tc_usd_mxn: null })],
      editores: [ALE],
    });
    const r = (await w.service.revise(V305, dto(), ALE)) as Row;
    const aviso = (r.avisos as string[]).find((a) =>
      a.startsWith('Se editó con cobros'),
    )!;
    expect(aviso).toContain(
      'cobrado $0 USD, nuevo total $1,000 USD, saldo $1,000 USD',
    );
    expect(aviso).toContain(
      '1 cobro en MXN sin tipo de cambio ($18,000 MXN) que no entra en esta cuenta',
    );
  });

  it('otro ADMIN (Alejandro Villalobos) ⇒ 409 COTIZACION_COBRADA que NOMBRA a quién puede editarla; nada escrito', async () => {
    const w = armar({ cobros: [cobroUsd(600)], editores: [ALE, PABLO] });
    const body = await error409(w.service.revise(V305, dto(), VILLALOBOS));
    expect(body.error).toBe('COTIZACION_COBRADA');
    expect(String(body.message)).toContain(
      'Solo pueden editarla: Alejandro Canales, Pablo Canales.',
    );
    expect(String(body.message)).toContain('#305');
    expect(body.details).toMatchObject({
      vuelo_id: V305,
      cobros: 1,
      cobrado_usd: 600,
      editores: EDITORES,
    });
    expect(w.patchRevision()).toBeNull();
    expect(w.version()).toBeNull();
  });

  it('sin ConfiguracionService (arranque parcial/specs viejos) ⇒ el 409 de siempre, sin nombres', async () => {
    const w = armar({ cobros: [cobroUsd(600)], editores: null });
    const body = await error409(w.service.revise(V305, dto(), ALE));
    expect(body.error).toBe('COTIZACION_COBRADA');
    expect(String(body.message)).toContain(
      'mientras exista dinero cobrado no se puede revisar. Elimina o reembolsa el cobro en "Cobros del vuelo" y vuelve a intentar.',
    );
    expect(String(body.message)).not.toContain('Solo pueden');
    expect(body.details).toMatchObject({ editores: [] });
  });

  it('lista ilegible ⇒ falla CERRADO (409), también para un editor', async () => {
    const w = armar({
      cobros: [cobroUsd(600)],
      editores: [ALE],
      listaIlegible: true,
    });
    const body = await error409(w.service.revise(V305, dto(), ALE));
    expect(body.error).toBe('COTIZACION_COBRADA');
    expect(w.patchRevision()).toBeNull();
  });

  it('el CFDI del PAC sigue bloqueando al editor (ni se consulta el permiso)', async () => {
    const w = armar({
      vuelo: vueloRow({ facturado: true }),
      cobros: [cobroUsd(600)],
      editores: [ALE],
    });
    await expect(w.service.revise(V305, dto(), ALE)).rejects.toThrow(/CFDI/);
    expect(w.puedeEditarCotizacionCobrada).not.toHaveBeenCalled();
    expect(w.patchRevision()).toBeNull();
  });

  it('el MES CERRADO sigue bloqueando al editor', async () => {
    const w = armar({
      vuelo: vueloRow({ fecha_vuelo: '2025-01-15T15:00:00.000Z' }),
      cobros: [cobroUsd(600)],
      editores: [ALE],
    });
    await expect(w.service.revise(V305, dto(), ALE)).rejects.toThrow(
      /mes ya cerrado/,
    );
    expect(w.puedeEditarCotizacionCobrada).not.toHaveBeenCalled();
  });

  it('el camino del GRUPO sigue bloqueando (el permiso no abre a los hijos cobrados desde el grupo)', async () => {
    const w = armar({ cobros: [cobroUsd(600)], editores: [ALE] });
    const body = await error409(
      w.service.reviseParaGrupo(V305, dto(), ALE, {
        id: 'g-1',
        folio: 12,
        posicion: 1,
        pax: 3,
        total_aviones: 2,
      }),
    );
    expect(body.error).toBe('COTIZACION_COBRADA');
    // Desde el grupo no se nombra a nadie: ahí el permiso no abre nada.
    expect(String(body.message)).not.toContain('Solo pueden');
    expect(w.puedeEditarCotizacionCobrada).not.toHaveBeenCalled();
    expect(w.patchRevision()).toBeNull();
  });

  it('avión de GRUPO con cobros del SOBRE: se revisa y avisa que el sobre no se re-parte solo', async () => {
    const w = armar({
      vuelo: vueloRow({ grupo_id: 'g-1' }),
      cobros: [cobroUsd(600, { cobro_grupo_id: 'sobre-1' })],
      editores: [ALE],
    });
    const r = (await w.service.revise(V305, dto(), ALE)) as Row;
    expect(r.edicion_con_cobros).toBe(true);
    expect((r.avisos as string[]).some((a) => a.includes('«Re-partir»'))).toBe(
      true,
    );
  });

  it('SIN cobros la revisión es la de siempre: edicion_con_cobros=false, motivo sin prefijo y sin consultar la lista', async () => {
    const w = armar({ cobros: [], editores: [ALE] });
    const r = (await w.service.revise(V305, dto(), VILLALOBOS)) as Row;
    expect(r.edicion_con_cobros).toBe(false);
    expect(w.version()!.motivo).toBe('Se cobró en efectivo: sin IVA');
    expect(w.puedeEditarCotizacionCobrada).not.toHaveBeenCalled();
    expect(
      (r.avisos as string[]).some((a) => a.startsWith('Se editó con cobros')),
    ).toBe(false);
  });

  it('cobro reembolsado completo (neto 0): no hay dinero retenido ⇒ revisión normal para cualquiera', async () => {
    const w = armar({
      cobros: [cobroUsd(600), cobroUsd(-600, { id: 'reemb' })],
      editores: [ALE],
    });
    const r = (await w.service.revise(V305, dto(), VILLALOBOS)) as Row;
    expect(r.edicion_con_cobros).toBe(false);
    expect(w.puedeEditarCotizacionCobrada).not.toHaveBeenCalled();
  });

  it('CANCELADO con cobros: sin candado de cobro (1-sep) ⇒ tampoco es «edición con cobros»', async () => {
    const w = armar({
      vuelo: vueloRow({ estado: 'CANCELADO' }),
      cobros: [cobroUsd(600)],
      editores: [],
    });
    const r = (await w.service.revise(V305, dto(), VILLALOBOS)) as Row;
    expect(r.edicion_con_cobros).toBe(false);
    // En CANCELADO la bandera no se toca (regla de siempre).
    expect(w.patchCobrado()).toBeNull();
  });

  it('quickAdjust (ajuste rápido) también respeta el permiso: pasa para el editor con su prefijo', async () => {
    const w = armar({ cobros: [cobroUsd(600)], editores: [ALE] });
    const r = (await w.service.quickAdjust(V305, { pasajeros: 4 }, ALE)) as Row;
    expect(r.edicion_con_cobros).toBe(true);
    expect(String(w.version()!.motivo)).toMatch(
      /^\[Con cobros · permiso especial\] /,
    );
  });

  it('quickAdjust para quien NO tiene el permiso ⇒ 409 COTIZACION_COBRADA', async () => {
    const w = armar({ cobros: [cobroUsd(600)], editores: [ALE] });
    const body = await error409(
      w.service.quickAdjust(V305, { pasajeros: 4 }, VILLALOBOS),
    );
    expect(body.error).toBe('COTIZACION_COBRADA');
    expect(String(body.message)).toContain(
      'Solo pueden editarla: Alejandro Canales.',
    );
  });
});
