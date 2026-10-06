// Dependencias que arrastran módulos pesados: fuera del spec.
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));

import { Logger } from '@nestjs/common';
import { FolioRelecturaService } from './folio-relectura.service';
import {
  CONFIG_FOLIOS_RELEER_ACTIVO,
  CONFIG_FOLIOS_RELEER_CAPTURADOS_HASTA,
  CONFIG_FOLIOS_RELEER_DESDE,
  CONFIG_FOLIOS_RELEER_LOTE,
  type ConfiguracionService,
} from '../configuracion/configuracion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { VisionService } from '../vision/vision.service';
import { normalizarFolio } from './folio-ticket.util';

/**
 * RELECTURA CON IA DEL FOLIO DE LOS COMPROBANTES (6-oct-2026, API 0.0.58,
 * invariante 46). Se congela:
 *  - sin la migración 20261006000001 o con `folios_releer_activo` apagada
 *    el cron no lee nada (ni Storage ni IA);
 *  - (a) folio leído ⇒ `folio_ticket`, la llave `folio` de la lectura y el
 *    sello, con `updated_by = null` (bitácora «Sistema»);
 *  - (b) 23505 del índice único ⇒ sin folio, posible duplicado y la línea
 *    en notas;
 *  - (c) legible sin folio / ilegible / archivo ausente o vacío ⇒ solo el
 *    sello;
 *  - (d) pyservices caído / IA sin saldo / red ⇒ NO se sella y se corta;
 *  - lote, orden, cola de postergados, CAS y candado anti-solape;
 *  - foto u hojas reemplazadas mientras la IA leía ⇒ OMITIDO (revisión
 *    6-oct-2026);
 *  - un gasto que falla siempre se lee con tope: 1 vez por hora, sellado
 *    tras 3 fallos con la IA viva, fuera de la cola tras 6 sin prueba.
 */

type Row = Record<string, unknown>;
type Op = { m: string; args: unknown[] };
type Lectura = Record<string, unknown> | null;

const PILOTO = '11111111-1111-1111-1111-111111111111';

interface Mundo {
  /** Migración 20261006000001 aplicada (columna `folio_releido_at`). */
  conColumna?: boolean;
  gastos?: Row[];
  /** Archivos que existen en `gasto-fotos` (path ⇒ contenido). */
  archivos?: Record<string, string>;
  /** Storage caído: `createSignedUrls` / `download` responden error de red. */
  storageCaido?: boolean;
  /** Lectura por URL/PDF (la recibe la entrada de visión). */
  leer?: (input: Row, reg: Row) => Promise<Lectura> | Lectura;
  /** Configuración (clave ⇒ valor); sin clave ⇒ el default del llamador. */
  config?: Record<string, unknown>;
  visionApagada?: boolean;
  /**
   * Se llama justo ANTES de aplicar cada UPDATE de `gasto` (carreras). Si
   * devuelve un objeto, ese es el `error` del UPDATE (no se escribe nada).
   */
  antesDeUpdate?: (db: Row[], patch: Row, n: number) => Row | void;
}

const valorIaFolio = (r: Row): string | null => {
  const v = r.valor_ia_extraido as Row | null | undefined;
  if (!v || typeof v !== 'object') return null;
  const f = v.folio;
  if (f == null) return null;
  return typeof f === 'string' ? f : JSON.stringify(f);
};

const valorDe = (r: Row, col: string): unknown =>
  col === 'valor_ia_extraido->>folio' ? valorIaFolio(r) : r[col];

const comparar = (a: unknown, b: unknown): number => {
  const ta = Date.parse(String(a));
  const tb = Date.parse(String(b));
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

let reloj = Date.parse('2026-10-06T15:00:00.000Z');
const ahoraIso = () => {
  reloj += 1000;
  return new Date(reloj).toISOString();
};

function armar(m: Mundo = {}) {
  const db: Row[] = (m.gastos ?? []).map((r) => ({ ...r }));
  const llamadas: Array<{ tabla: string; ops: Op[] }> = [];
  const firmas: Array<{ paths: string[]; segundos: number }> = [];
  const descargas: string[] = [];
  let updates = 0;

  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      llamadas.push({ tabla, ops });
      const q: Record<string, unknown> = {};
      const op = (n: string) => ops.find((o) => o.m === n);
      const sel = () => {
        const s = op('select')?.args[0];
        return typeof s === 'string' ? s : '';
      };
      const resolver = (): { data: unknown; error: Row | null } => {
        if (tabla !== 'gasto') return { data: [], error: null };
        const upd = op('update');
        const nombra =
          /folio_releido_at/.test(sel()) ||
          ops.some(
            (o) =>
              (o.m === 'is' || o.m === 'eq') &&
              o.args[0] === 'folio_releido_at',
          ) ||
          (upd && 'folio_releido_at' in (upd.args[0] as Row));
        if (!m.conColumna && nombra) {
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column gasto.folio_releido_at does not exist',
            },
          };
        }
        const pasa = (r: Row) =>
          ops.every((o) => {
            const [col, val] = o.args as [string, unknown];
            if (o.m === 'eq') return valorDe(r, col) === val;
            if (o.m === 'is') return (valorDe(r, col) ?? null) === null;
            if (o.m === 'not') return (valorDe(r, col) ?? null) !== null;
            if (o.m === 'gte') return comparar(valorDe(r, col), val) >= 0;
            if (o.m === 'lte') return comparar(valorDe(r, col), val) <= 0;
            if (o.m === 'lt') return comparar(valorDe(r, col), val) < 0;
            return true;
          });
        if (upd) {
          updates += 1;
          const patch = upd.args[0] as Row;
          const errUpd = m.antesDeUpdate?.(db, patch, updates);
          if (errUpd) return { data: null, error: errUpd };
          const filas = db.filter(pasa);
          if (typeof patch.folio_ticket === 'string') {
            const norm = normalizarFolio(patch.folio_ticket);
            const choca =
              norm &&
              norm.length >= 4 &&
              db.some(
                (r) =>
                  !filas.includes(r) &&
                  normalizarFolio(r.folio_ticket as string | null) === norm,
              );
            if (choca) {
              return {
                data: null,
                error: {
                  code: '23505',
                  message:
                    'duplicate key value violates unique constraint "uq_gasto_folio_ticket_norm"',
                },
              };
            }
          }
          for (const r of filas) {
            Object.assign(r, patch, { updated_at: ahoraIso() });
          }
          return { data: filas.map((r) => ({ id: r.id })), error: null };
        }
        let filas = db.filter(pasa);
        const ordenes = ops.filter((o) => o.m === 'order');
        if (ordenes.length > 0) {
          filas = [...filas].sort((a, b) => {
            for (const o of ordenes) {
              const [col, opts] = o.args as [string, { ascending?: boolean }];
              const c = comparar(a[col], b[col]);
              if (c !== 0) return opts?.ascending === false ? -c : c;
            }
            return 0;
          });
        }
        const lim = op('limit');
        if (lim) filas = filas.slice(0, lim.args[0] as number);
        // Como PostgREST: SOLO las columnas pedidas (una columna que el
        // código olvide pedir llega undefined y el spec lo nota).
        const cols = sel()
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
        const proyectar = (r: Row): Row => {
          if (cols.length === 0 || cols.includes('*')) return { ...r };
          const out: Row = {};
          for (const c of cols) {
            if (c === 'ia_folio:valor_ia_extraido->>folio') {
              out.ia_folio = valorIaFolio(r);
            } else {
              out[c] = r[c];
            }
          }
          return out;
        };
        return { data: filas.map(proyectar), error: null };
      };
      for (const met of [
        'select',
        'eq',
        'neq',
        'is',
        'not',
        'gte',
        'lte',
        'lt',
        'order',
        'limit',
        'update',
      ]) {
        q[met] = (...args: unknown[]) => {
          ops.push({ m: met, args });
          return q;
        };
      }
      q.maybeSingle = () => {
        const r = resolver();
        const lista = Array.isArray(r.data) ? (r.data as unknown[]) : null;
        return Promise.resolve({
          data: lista ? (lista[0] ?? null) : r.data,
          error: r.error,
        });
      };
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resolver()).then(res, rej);
      return q;
    },
    storage: {
      from(bucket: string) {
        expect(bucket).toBe('gasto-fotos');
        return {
          createSignedUrls: (paths: string[], segundos: number) => {
            firmas.push({ paths, segundos });
            if (m.storageCaido) {
              return Promise.resolve({
                data: null,
                error: { message: 'fetch failed' },
              });
            }
            return Promise.resolve({
              data: paths.map((p) =>
                m.archivos?.[p] != null
                  ? { path: p, signedUrl: `https://firmada/${p}`, error: null }
                  : {
                      path: p,
                      signedUrl: null,
                      error:
                        'Either the object does not exist or you do not have access to it',
                    },
              ),
              error: null,
            });
          },
          download: (path: string) => {
            descargas.push(path);
            if (m.storageCaido) {
              return Promise.resolve({
                data: null,
                error: { message: 'fetch failed' },
              });
            }
            const a = m.archivos?.[path];
            if (a == null) {
              return Promise.resolve({
                data: null,
                error: { message: 'Object not found' },
              });
            }
            const buf = Buffer.from(a);
            return Promise.resolve({
              data: {
                arrayBuffer: () =>
                  Promise.resolve(
                    buf.buffer.slice(
                      buf.byteOffset,
                      buf.byteOffset + buf.byteLength,
                    ),
                  ),
              },
              error: null,
            });
          },
        };
      },
    },
  };

  const readGastoTicket = jest.fn(async (input: Row, reg: Row) =>
    m.leer ? await m.leer(input, reg) : null,
  );
  const vision = {
    enabled: !m.visionApagada,
    readGastoTicket,
  } as unknown as VisionService;
  const cfg = m.config ?? {};
  const configuracion = {
    isActiva: jest.fn((clave: string, def: boolean) =>
      Promise.resolve(clave in cfg ? Boolean(cfg[clave]) : def),
    ),
    numero: jest.fn((clave: string, def: number) =>
      Promise.resolve(clave in cfg ? Number(cfg[clave]) : def),
    ),
    fecha: jest.fn((clave: string, def: string) =>
      Promise.resolve(clave in cfg ? String(cfg[clave]) : def),
    ),
  } as unknown as ConfiguracionService;

  const svc = new FolioRelecturaService(
    { service } as unknown as SupabaseService,
    vision,
    configuracion,
  );
  /** UPDATEs a `gasto` con su patch y sus filtros. */
  const escrituras = () =>
    llamadas
      .filter((l) => l.tabla === 'gasto' && l.ops.some((o) => o.m === 'update'))
      .map((l) => ({
        patch: l.ops.find((o) => o.m === 'update')!.args[0] as Row,
        id: l.ops.find((o) => o.m === 'eq')?.args[1],
        is: l.ops.filter((o) => o.m === 'is').map((o) => o.args[0]),
        cas: l.ops.some((o) => o.m === 'gte' && o.args[0] === 'updated_at'),
      }));
  /** Consultas de la cola (select de candidatos). */
  const colas = () =>
    llamadas.filter(
      (l) =>
        l.tabla === 'gasto' &&
        l.ops.some(
          (o) =>
            o.m === 'select' &&
            o.args[0] === 'id, fecha_gasto, foto_url, valor_ia_extraido',
        ),
    );
  return {
    svc,
    db,
    llamadas,
    firmas,
    descargas,
    readGastoTicket,
    configuracion,
    escrituras,
    colas,
  };
}

/** Gasto candidato (foto, sin folio) del mes de septiembre. */
const gasto = (id: string, extra: Row = {}): Row => ({
  id,
  fecha_gasto: '2026-09-04',
  foto_url: `${PILOTO}/2026-09/${id}.jpg`,
  folio_ticket: null,
  factura_recibida_id: null,
  folio_releido_at: null,
  valor_ia_extraido: {
    legible: true,
    monto: 4549.06,
    proveedor: 'ASUR',
    matricula: 'XA-VGV',
    folio: null,
  },
  notas: null,
  duplicado_sospechado: false,
  created_at: '2026-09-04T18:00:00.000Z',
  updated_at: '2026-09-04T18:00:00.000000+00:00',
  updated_by: PILOTO,
  ...extra,
});

const archivosDe = (...ids: string[]) =>
  Object.fromEntries(ids.map((id) => [`${PILOTO}/2026-09/${id}.jpg`, 'jpg']));

/** Lectura legible de pyservices con el folio dado. */
const lectura = (folio: string | null, extra: Row = {}): Row => ({
  monto: 4549.06,
  moneda: 'MXN',
  fecha: '2026-09-04',
  proveedor: 'ASUR',
  folio,
  concepto: 'Operación',
  categoria_sugerida: 'OPERACIONES',
  medio_pago: null,
  tarjeta_terminacion: null,
  confianza: 0.9,
  legible: true,
  notas: '',
  modelo: 'claude-opus-4-8',
  uso_ia: { modelo: 'claude-opus-4-8', input_tokens: 1, output_tokens: 1 },
  ...extra,
});

/** Lectura por id del gasto (lo saca de la URL firmada). */
const porId =
  (tabla: Record<string, Lectura>) =>
  (input: Row): Lectura => {
    const primera = (input.images as Row[] | undefined)?.[0]?.imageUrl;
    const crudo = input.imageUrl ?? primera;
    const url = typeof crudo === 'string' ? crudo : '';
    const id = Object.keys(tabla).find((k) => url.endsWith(`/${k}.jpg`));
    return id ? tabla[id] : null;
  };

const fallo = (motivo: string): Lectura => ({ motivo });

describe('cron gastos-releer-folio', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sin la migración NO hace nada: ni Storage ni IA', async () => {
    const { svc, firmas, readGastoTicket, colas } = armar({
      conColumna: false,
      gastos: [gasto('g1')],
      archivos: archivosDe('g1'),
      leer: () => lectura('A-1'),
    });
    const r = await svc.releerFoliosGastos();
    expect(r).toMatchObject({ activo: true, disponible: false, tomados: 0 });
    expect(firmas).toHaveLength(0);
    expect(readGastoTicket).not.toHaveBeenCalled();
    expect(colas()).toHaveLength(0);
  });

  it('con `folios_releer_activo` apagada NO hace nada (ni sonda)', async () => {
    const { svc, llamadas, readGastoTicket } = armar({
      conColumna: true,
      gastos: [gasto('g1')],
      archivos: archivosDe('g1'),
      leer: () => lectura('A-1'),
      config: { [CONFIG_FOLIOS_RELEER_ACTIVO]: false },
    });
    const r = await svc.releerFoliosGastos();
    expect(r).toMatchObject({ activo: false, disponible: false, tomados: 0 });
    expect(llamadas).toHaveLength(0);
    expect(readGastoTicket).not.toHaveBeenCalled();
  });

  it('sin visión IA configurada no lee nada', async () => {
    const { svc, readGastoTicket, colas } = armar({
      conColumna: true,
      gastos: [gasto('g1')],
      archivos: archivosDe('g1'),
      visionApagada: true,
    });
    const r = await svc.releerFoliosGastos();
    expect(r).toMatchObject({ activo: true, disponible: true, tomados: 0 });
    expect(readGastoTicket).not.toHaveBeenCalled();
    expect(colas()).toHaveLength(0);
  });

  it('(a) folio leído ⇒ folio_ticket, la llave `folio` de la lectura PREVIA y el sello, actor «Sistema»', async () => {
    const previa = {
      legible: true,
      monto: 4549.06,
      proveedor: 'ASUR',
      matricula: 'XA-VGV',
      folio: null,
      desglose_lineas: ['Operación - $3,921.60 MXN'],
    };
    const { svc, db, firmas, readGastoTicket, escrituras } = armar({
      conColumna: true,
      gastos: [gasto('asur', { valor_ia_extraido: previa })],
      archivos: archivosDe('asur'),
      leer: () => lectura(' FEACZM-72128 ', { proveedor: 'Otra lectura' }),
    });
    const r = await svc.releerFoliosGastos();
    expect(r).toEqual({
      activo: true,
      disponible: true,
      tomados: 1,
      con_folio: 1,
      duplicados: 0,
      sin_folio: 0,
      ilegibles: 0,
      omitidos: 0,
      fallos: 0,
    });
    const g = db[0];
    expect(g.folio_ticket).toBe('FEACZM-72128');
    // La lectura que la oficina ya revisó se conserva: solo se llena `folio`.
    expect(g.valor_ia_extraido).toEqual({ ...previa, folio: 'FEACZM-72128' });
    expect(typeof g.folio_releido_at).toBe('string');
    expect(g.updated_by).toBeNull();
    // URL firmada de 1 h (se le entrega a un tercero).
    expect(firmas).toEqual([
      { paths: [`${PILOTO}/2026-09/asur.jpg`], segundos: 3600 },
    ]);
    expect(readGastoTicket).toHaveBeenCalledWith(
      { imageUrl: `https://firmada/${PILOTO}/2026-09/asur.jpg` },
      {
        categoria: 'RELEER_FOLIO',
        usuarioId: null,
        contexto: { gasto_id: 'asur', origen: 'releer_folio' },
      },
    );
    const [w] = escrituras();
    expect(w.patch).toMatchObject({ updated_by: null });
    expect(w.is).toEqual(
      expect.arrayContaining([
        'folio_ticket',
        'folio_releido_at',
        'factura_recibida_id',
      ]),
    );
    expect(w.cas).toBe(true);
  });

  it('(a) sin lectura previa ⇒ guarda la lectura completa (sin `motivo`) con el folio', async () => {
    const { svc, db } = armar({
      conColumna: true,
      gastos: [gasto('g1', { valor_ia_extraido: null })],
      archivos: archivosDe('g1'),
      leer: () => lectura('A-0411'),
    });
    await svc.releerFoliosGastos();
    expect(db[0].valor_ia_extraido).toEqual(lectura('A-0411'));
    expect(db[0].folio_ticket).toBe('A-0411');
  });

  it('(b) el folio ya es de OTRO gasto (23505) ⇒ sin folio, posible duplicado y la línea en notas', async () => {
    const { svc, db, escrituras } = armar({
      conColumna: true,
      gastos: [
        gasto('nuevo', { notas: 'Pago ASUR\n' }),
        gasto('viejo', {
          fecha_gasto: '2026-09-01',
          folio_ticket: 'FAC 1234',
          folio_releido_at: null,
        }),
      ],
      archivos: archivosDe('nuevo'),
      leer: () => lectura('fac-1234'),
    });
    const r = await svc.releerFoliosGastos();
    expect(r).toMatchObject({ tomados: 1, duplicados: 1, con_folio: 0 });
    const g = db.find((x) => x.id === 'nuevo')!;
    expect(g.folio_ticket).toBeNull();
    expect(g.duplicado_sospechado).toBe(true);
    expect(g.notas).toBe(
      'Pago ASUR\n⚠ IA: folio fac-1234 ya existe en otro gasto — revisar',
    );
    expect(g.folio_releido_at).not.toBeNull();
    expect(g.updated_by).toBeNull();
    // El otro gasto no se toca.
    expect(db.find((x) => x.id === 'viejo')!.folio_ticket).toBe('FAC 1234');
    const ws = escrituras();
    expect(ws).toHaveLength(2);
    expect(ws[0].patch).toHaveProperty('folio_ticket', 'fac-1234');
    expect(ws[1].patch).not.toHaveProperty('folio_ticket');
    expect(ws[1].patch).toMatchObject({
      duplicado_sospechado: true,
      updated_by: null,
    });
  });

  it('(c) legible sin folio, ilegible, «S/N», comprobante que la IA no procesa y archivo ausente ⇒ solo el sello', async () => {
    const pdf = `${PILOTO}/2026-09/factura.pdf`;
    const { svc, db, escrituras, readGastoTicket, descargas } = armar({
      conColumna: true,
      gastos: [
        gasto('sin', { fecha_gasto: '2026-09-09' }),
        gasto('ilegible', { fecha_gasto: '2026-09-08' }),
        gasto('sn', { fecha_gasto: '2026-09-07' }),
        gasto('pesada', { fecha_gasto: '2026-09-06' }),
        gasto('borrada', { fecha_gasto: '2026-09-05' }),
        gasto('pdf', { fecha_gasto: '2026-09-04', foto_url: pdf }),
      ],
      archivos: {
        ...archivosDe('sin', 'ilegible', 'sn', 'pesada'),
        [pdf]: '%PDF-1.4',
      },
      leer: (input) =>
        input.pdfBase64
          ? lectura(null)
          : porId({
              sin: lectura(null),
              ilegible: lectura('ZZ-999', { legible: false }),
              sn: lectura('S/N'),
              pesada: fallo(
                'La foto o el archivo pesa demasiado para la IA (máx. 5 MB por foto, 32 MB por PDF): toma otra foto o recórtala',
              ),
            })(input),
    });
    const r = await svc.releerFoliosGastos();
    expect(r).toMatchObject({
      tomados: 6,
      sin_folio: 3,
      ilegibles: 3,
      con_folio: 0,
      fallos: 0,
    });
    // El archivo borrado no se manda a la IA; el PDF va en bytes.
    expect(readGastoTicket).toHaveBeenCalledTimes(5);
    expect(descargas).toEqual([pdf]);
    expect(readGastoTicket.mock.calls[4][0]).toEqual({
      pdfBase64: Buffer.from('%PDF-1.4').toString('base64'),
    });
    for (const g of db) {
      expect(g.folio_ticket).toBeNull();
      expect(g.folio_releido_at).not.toBeNull();
      expect(g.updated_by).toBe(PILOTO);
    }
    // Solo el sello: ni updated_by (no hay renglón de bitácora), ni notas.
    for (const w of escrituras()) {
      expect(Object.keys(w.patch)).toEqual(['folio_releido_at']);
    }
  });

  it('(d) pyservices CAÍDO ⇒ no sella nada y corta tras DOS fallos seguidos', async () => {
    const { svc, db, escrituras, readGastoTicket } = armar({
      conColumna: true,
      gastos: [
        gasto('a', { fecha_gasto: '2026-09-09' }),
        gasto('b', { fecha_gasto: '2026-09-08' }),
        gasto('c', { fecha_gasto: '2026-09-07' }),
      ],
      archivos: archivosDe('a', 'b', 'c'),
      leer: () => fallo('Sin conexión con pyservices: fetch failed'),
    });
    const r = await svc.releerFoliosGastos();
    expect(r).toMatchObject({ tomados: 2, fallos: 2, sin_folio: 0 });
    expect(readGastoTicket).toHaveBeenCalledTimes(2);
    expect(escrituras()).toHaveLength(0);
    expect(db.every((g) => g.folio_releido_at === null)).toBe(true);
    // Los dos van al final de la cola para la siguiente corrida.
    expect(svc.postergadosActuales()).toEqual(['a', 'b']);
  });

  it('(d) IA SIN SALDO ⇒ corta en el PRIMERO, sin sellar ni postergar', async () => {
    const { svc, db, readGastoTicket } = armar({
      conColumna: true,
      gastos: [gasto('a'), gasto('b')],
      archivos: archivosDe('a', 'b'),
      leer: () =>
        fallo(
          'Sin saldo de créditos de IA en Anthropic: hay que recargar (Plans & Billing) y registrar el nuevo saldo en Configuración → Consumo de IA',
        ),
    });
    const r = await svc.releerFoliosGastos();
    expect(r).toMatchObject({ tomados: 1, fallos: 1 });
    expect(readGastoTicket).toHaveBeenCalledTimes(1);
    expect(db.every((g) => g.folio_releido_at === null)).toBe(true);
    expect(svc.postergadosActuales()).toEqual([]);
  });

  it('(d) «Claude no disponible (400)» genérico y timeout son TRANSITORIOS: una sola falla no corta, la siguiente se lee', async () => {
    const { svc, db } = armar({
      conColumna: true,
      gastos: [
        gasto('a', { fecha_gasto: '2026-09-09' }),
        gasto('b', { fecha_gasto: '2026-09-08' }),
        gasto('c', { fecha_gasto: '2026-09-07' }),
        gasto('d', { fecha_gasto: '2026-09-06' }),
      ],
      archivos: archivosDe('a', 'b', 'c', 'd'),
      leer: porId({
        a: fallo('Claude no disponible (400): Unable to download the file'),
        b: lectura('B-1'),
        c: fallo('La lectura tardó demasiado (timeout API→pyservices)'),
        d: lectura('D-1'),
      }),
    });
    const r = await svc.releerFoliosGastos();
    expect(r).toMatchObject({ tomados: 4, fallos: 2, con_folio: 2 });
    expect(db.find((g) => g.id === 'a')!.folio_releido_at).toBeNull();
    expect(db.find((g) => g.id === 'b')!.folio_ticket).toBe('B-1');
    expect(db.find((g) => g.id === 'd')!.folio_ticket).toBe('D-1');
  });

  it('(d) Storage con error de red ⇒ salta esa fila (no sella, no cuenta para el corte)', async () => {
    const { svc, db, readGastoTicket } = armar({
      conColumna: true,
      gastos: [gasto('a')],
      archivos: archivosDe('a'),
      storageCaido: true,
      leer: () => lectura('A-1'),
    });
    const r = await svc.releerFoliosGastos();
    expect(r).toMatchObject({ tomados: 1, fallos: 1 });
    expect(readGastoTicket).not.toHaveBeenCalled();
    expect(db[0].folio_releido_at).toBeNull();
  });

  it('lote y orden: fecha_gasto desc, filtros de la cola y `folios_releer_lote`', async () => {
    const { svc, readGastoTicket, colas, db } = armar({
      conColumna: true,
      gastos: [
        gasto('sep-04', { fecha_gasto: '2026-09-04' }),
        gasto('sep-20', { fecha_gasto: '2026-09-20' }),
        gasto('oct-02', { fecha_gasto: '2026-10-02' }),
        gasto('sep-10', { fecha_gasto: '2026-09-10' }),
        // Fuera de la cola:
        gasto('agosto', { fecha_gasto: '2026-08-30' }),
        gasto('hoy', {
          fecha_gasto: '2026-10-06',
          created_at: '2026-10-06T14:00:00.000Z',
        }),
        gasto('ya-leido', {
          fecha_gasto: '2026-09-25',
          folio_releido_at: '2026-10-06T10:00:00.000Z',
        }),
        gasto('con-folio-ia', {
          fecha_gasto: '2026-09-26',
          valor_ia_extraido: { folio: 'F-77' },
        }),
        gasto('con-ticket', { fecha_gasto: '2026-09-27', folio_ticket: 'T-1' }),
        gasto('con-factura', {
          fecha_gasto: '2026-09-28',
          factura_recibida_id: 'fr-1',
        }),
        gasto('sin-foto', { fecha_gasto: '2026-09-29', foto_url: null }),
      ],
      archivos: archivosDe(
        'sep-04',
        'sep-20',
        'oct-02',
        'sep-10',
        'agosto',
        'hoy',
        'ya-leido',
        'con-folio-ia',
        'con-ticket',
        'con-factura',
      ),
      leer: () => lectura(null),
      config: { [CONFIG_FOLIOS_RELEER_LOTE]: 3 },
    });
    const r = await svc.releerFoliosGastos();
    expect(r).toMatchObject({ tomados: 3, sin_folio: 3 });
    const leidos = readGastoTicket.mock.calls.map((c) =>
      String(c[0].imageUrl).split('/').pop(),
    );
    expect(leidos).toEqual(['oct-02.jpg', 'sep-20.jpg', 'sep-10.jpg']);
    const [cola] = colas();
    expect(cola.ops).toEqual(
      expect.arrayContaining([
        { m: 'not', args: ['foto_url', 'is', null] },
        { m: 'is', args: ['folio_ticket', null] },
        { m: 'is', args: ['factura_recibida_id', null] },
        { m: 'is', args: ['folio_releido_at', null] },
        { m: 'is', args: ['valor_ia_extraido->>folio', null] },
        { m: 'gte', args: ['fecha_gasto', '2026-09-01'] },
        { m: 'lt', args: ['created_at', '2026-10-06T00:00:00-05:00'] },
        { m: 'order', args: ['fecha_gasto', { ascending: false }] },
        { m: 'limit', args: [3] },
      ]),
    );
    // La siguiente corrida toma el que faltó y nada más.
    const r2 = await svc.releerFoliosGastos();
    expect(r2).toMatchObject({ tomados: 1, sin_folio: 1 });
    expect(db.find((g) => g.id === 'sep-04')!.folio_releido_at).not.toBeNull();
    for (const id of ['agosto', 'hoy', 'con-folio-ia', 'sin-foto']) {
      expect(db.find((g) => g.id === id)!.folio_releido_at).toBeNull();
    }
    expect(readGastoTicket).toHaveBeenCalledTimes(4);
  });

  it('configuración: lote por default 15 (tope 50) y fechas configurables', async () => {
    const a = armar({ conColumna: true, gastos: [] });
    await a.svc.releerFoliosGastos();
    expect(a.colas()[0].ops).toContainEqual({ m: 'limit', args: [15] });
    const b = armar({
      conColumna: true,
      gastos: [],
      config: {
        [CONFIG_FOLIOS_RELEER_LOTE]: 500,
        [CONFIG_FOLIOS_RELEER_DESDE]: '2026-07-01',
        [CONFIG_FOLIOS_RELEER_CAPTURADOS_HASTA]: '2026-10-31',
      },
    });
    await b.svc.releerFoliosGastos();
    expect(b.colas()[0].ops).toEqual(
      expect.arrayContaining([
        { m: 'limit', args: [50] },
        { m: 'gte', args: ['fecha_gasto', '2026-07-01'] },
        { m: 'lt', args: ['created_at', '2026-11-01T00:00:00-05:00'] },
      ]),
    );
  });

  it('postergados: el que falló va AL FINAL de la cola en la siguiente corrida (dos fotos venenosas no bloquean)', async () => {
    let intento = 0;
    const { svc, db, readGastoTicket } = armar({
      conColumna: true,
      gastos: [
        gasto('v1', { fecha_gasto: '2026-09-09' }),
        gasto('v2', { fecha_gasto: '2026-09-08' }),
        gasto('ok', { fecha_gasto: '2026-09-07' }),
      ],
      archivos: archivosDe('v1', 'v2', 'ok'),
      leer: (input) => {
        intento += 1;
        return porId({
          v1: fallo('pyservices 500'),
          v2: fallo('pyservices 500'),
          ok: lectura('OK-1'),
        })(input);
      },
      config: { [CONFIG_FOLIOS_RELEER_LOTE]: 2 },
    });
    const r1 = await svc.releerFoliosGastos();
    expect(r1).toMatchObject({ tomados: 2, fallos: 2 });
    const r2 = await svc.releerFoliosGastos();
    // La 2.ª corrida empieza por `ok`, no por las dos venenosas.
    expect(String(readGastoTicket.mock.calls[2][0].imageUrl)).toMatch(
      /ok\.jpg$/,
    );
    expect(r2!.con_folio).toBe(1);
    expect(db.find((g) => g.id === 'ok')!.folio_ticket).toBe('OK-1');
    expect(intento).toBeGreaterThanOrEqual(3);
  });

  it('multi-hoja: manda TODAS las hojas (`fotos_adicionales`) y las conserva en la lectura', async () => {
    const hoja2 = `${PILOTO}/2026-09/h2.jpg`;
    const previa = { legible: true, folio: null, fotos_adicionales: [hoja2] };
    const { svc, db, readGastoTicket, firmas } = armar({
      conColumna: true,
      gastos: [gasto('h1', { valor_ia_extraido: previa })],
      archivos: { ...archivosDe('h1'), [hoja2]: 'jpg' },
      leer: () => lectura('M-55'),
    });
    await svc.releerFoliosGastos();
    expect(firmas[0].paths).toEqual([`${PILOTO}/2026-09/h1.jpg`, hoja2]);
    expect(readGastoTicket.mock.calls[0][0]).toEqual({
      images: [
        { imageUrl: `https://firmada/${PILOTO}/2026-09/h1.jpg` },
        { imageUrl: `https://firmada/${hoja2}` },
      ],
    });
    expect(db[0].valor_ia_extraido).toEqual({ ...previa, folio: 'M-55' });
  });

  it('(c) PDF BORRADO de Storage («Object not found» en download) ⇒ sello ilegible sin llamar a la IA', async () => {
    const pdf = `${PILOTO}/2026-09/borrado.pdf`;
    const { svc, db, readGastoTicket, descargas, escrituras } = armar({
      conColumna: true,
      gastos: [gasto('pdf', { foto_url: pdf })],
      archivos: {},
      leer: () => lectura('NO-DEBE'),
    });
    const r = await svc.releerFoliosGastos();
    expect(r).toMatchObject({ tomados: 1, ilegibles: 1, fallos: 0 });
    expect(descargas).toEqual([pdf]);
    expect(readGastoTicket).not.toHaveBeenCalled();
    expect(db[0].folio_releido_at).not.toBeNull();
    expect(db[0].folio_ticket).toBeNull();
    expect(Object.keys(escrituras()[0].patch)).toEqual(['folio_releido_at']);
    expect(svc.postergadosActuales()).toEqual([]);
  });

  it('(c) PDF VACÍO (0 bytes) ⇒ sello ilegible sin llamar a la IA y la corrida SIGUE (no atora la cola)', async () => {
    const pdf = `${PILOTO}/2026-09/vacio.pdf`;
    const { svc, db, readGastoTicket } = armar({
      conColumna: true,
      gastos: [
        gasto('vacio', { fecha_gasto: '2026-09-09', foto_url: pdf }),
        gasto('sigue', { fecha_gasto: '2026-09-08' }),
      ],
      archivos: { [pdf]: '', ...archivosDe('sigue') },
      leer: () => lectura('S-1'),
    });
    const r = await svc.releerFoliosGastos();
    expect(r).toMatchObject({ tomados: 2, ilegibles: 1, con_folio: 1 });
    expect(readGastoTicket).toHaveBeenCalledTimes(1);
    expect(db.find((g) => g.id === 'vacio')!.folio_releido_at).not.toBeNull();
    expect(db.find((g) => g.id === 'sigue')!.folio_ticket).toBe('S-1');
  });

  it('foto REEMPLAZADA mientras la IA leía ⇒ OMITIDO (el folio de la vieja no se escribe) y la nueva se lee en la siguiente corrida', async () => {
    const nueva = `${PILOTO}/2026-09/g1-nueva.jpg`;
    const a = armar({
      conColumna: true,
      gastos: [gasto('g1')],
      archivos: { ...archivosDe('g1'), [nueva]: 'jpg' },
      leer: (input) => {
        const url = String(input.imageUrl);
        if (url.endsWith('/g1.jpg')) {
          // El piloto cambia la foto (y la app guarda su propia lectura,
          // sin folio) mientras la IA lee la vieja.
          const g = a.db[0];
          g.foto_url = nueva;
          g.valor_ia_extraido = { legible: true, monto: 99, folio: null };
          g.updated_at = ahoraIso();
          return lectura('FOLIO-DE-LA-FOTO-VIEJA');
        }
        return lectura('FOLIO-NUEVO');
      },
    });
    const r1 = await a.svc.releerFoliosGastos();
    expect(r1).toMatchObject({ tomados: 1, omitidos: 1, con_folio: 0 });
    expect(a.escrituras()).toHaveLength(0);
    expect(a.db[0].folio_ticket).toBeNull();
    expect(a.db[0].folio_releido_at).toBeNull();
    expect(a.db[0].valor_ia_extraido).toEqual({
      legible: true,
      monto: 99,
      folio: null,
    });
    // No es un fallo: no se posterga y la siguiente corrida lee la NUEVA.
    expect(a.svc.postergadosActuales()).toEqual([]);
    const r2 = await a.svc.releerFoliosGastos();
    expect(r2).toMatchObject({ tomados: 1, con_folio: 1 });
    expect(a.db[0].folio_ticket).toBe('FOLIO-NUEVO');
    expect(a.readGastoTicket.mock.calls[1][0]).toEqual({
      imageUrl: `https://firmada/${nueva}`,
    });
  });

  it('hojas (`fotos_adicionales`) cambiadas mientras la IA leía ⇒ OMITIDO; un sello tampoco se escribe', async () => {
    const hoja2 = `${PILOTO}/2026-09/h2.jpg`;
    const a = armar({
      conColumna: true,
      gastos: [gasto('g1'), gasto('g2', { fecha_gasto: '2026-09-01' })],
      archivos: { ...archivosDe('g1', 'g2'), [hoja2]: 'jpg' },
      leer: (input) => {
        const url = String(input.imageUrl);
        const id = url.endsWith('/g1.jpg') ? 'g1' : 'g2';
        const g = a.db.find((x) => x.id === id)!;
        g.valor_ia_extraido = {
          ...(g.valor_ia_extraido as Row),
          fotos_adicionales: [hoja2],
        };
        g.updated_at = ahoraIso();
        return id === 'g1' ? lectura('H-1') : lectura(null);
      },
    });
    const r = await a.svc.releerFoliosGastos();
    expect(r).toMatchObject({ tomados: 2, omitidos: 2, sin_folio: 0 });
    expect(a.escrituras()).toHaveLength(0);
    for (const g of a.db) {
      expect(g.folio_ticket).toBeNull();
      expect(g.folio_releido_at).toBeNull();
    }
  });

  describe('reintentos acotados: ningún gasto se lee sin tope', () => {
    let reloj = Date.parse('2026-10-06T18:00:00.000Z');
    const MIN = 60 * 1000;
    beforeEach(() => {
      jest.spyOn(Date, 'now').mockImplementation(() => reloj);
    });

    it('timeout SIEMPRE en el mismo gasto con la IA contestando a otros ⇒ 1 lectura por hora y se sella como ilegible', async () => {
      const { svc, db, readGastoTicket } = armar({
        conColumna: true,
        gastos: [
          gasto('veneno', { fecha_gasto: '2026-09-09' }),
          gasto('o1', { fecha_gasto: '2026-09-08' }),
          gasto('o2', { fecha_gasto: '2026-09-07' }),
          gasto('o3', { fecha_gasto: '2026-09-06' }),
        ],
        archivos: archivosDe('veneno', 'o1', 'o2', 'o3'),
        leer: porId({
          veneno: fallo('La lectura tardó demasiado (timeout API→pyservices)'),
          o1: lectura('O-1'),
          o2: lectura('O-2'),
          o3: lectura('O-3'),
        }),
        config: { [CONFIG_FOLIOS_RELEER_LOTE]: 2 },
      });
      const lecturasVeneno = () =>
        readGastoTicket.mock.calls.filter((c) =>
          String(c[0].imageUrl).endsWith('/veneno.jpg'),
        ).length;
      // 4 h de corridas cada 5 min (48 corridas).
      for (let i = 0; i < 48; i += 1) {
        await svc.releerFoliosGastos();
        if (i === 11) {
          // Primera hora: lo leyó UNA vez (no en cada corrida).
          expect(lecturasVeneno()).toBe(1);
        }
        reloj += 5 * MIN;
      }
      const v = db.find((g) => g.id === 'veneno')!;
      expect(v.folio_releido_at).not.toBeNull();
      expect(v.folio_ticket).toBeNull();
      // 1.ª sin prueba (fue el primero de su corrida) + 3 con la IA viva.
      expect(lecturasVeneno()).toBe(4);
      expect(svc.postergadosActuales()).toEqual([]);
      for (const id of ['o1', 'o2', 'o3']) {
        expect(db.find((g) => g.id === id)!.folio_ticket).toBe(
          id.toUpperCase().replace('O', 'O-'),
        );
      }
    });

    it('«Respuesta truncada» (la IA contestó y cobró) no corta la corrida y sella tras 3 lecturas', async () => {
      const { svc, db, readGastoTicket } = armar({
        conColumna: true,
        gastos: [
          gasto('t1', { fecha_gasto: '2026-09-09' }),
          gasto('t2', { fecha_gasto: '2026-09-08' }),
          gasto('t3', { fecha_gasto: '2026-09-07' }),
        ],
        archivos: archivosDe('t1', 't2', 't3'),
        leer: () =>
          fallo('Respuesta truncada por max_tokens (subir el límite)'),
      });
      const r1 = await svc.releerFoliosGastos();
      // Tres seguidos y NO se corta: pyservices y la IA están vivos.
      expect(r1).toMatchObject({ tomados: 3, fallos: 3, ilegibles: 0 });
      expect(svc.estadoPostergado('t1')).toMatchObject({
        intentos: 1,
        conIa: 1,
      });
      for (let i = 0; i < 36; i += 1) {
        reloj += 5 * MIN;
        await svc.releerFoliosGastos();
      }
      expect(readGastoTicket).toHaveBeenCalledTimes(9);
      for (const g of db) {
        expect(g.folio_releido_at).not.toBeNull();
        expect(g.folio_ticket).toBeNull();
      }
    });

    it('solo en la cola, sin nadie más que pruebe que la IA vive ⇒ 6 lecturas y sale de la cola SIN sellarse', async () => {
      const { svc, db, readGastoTicket } = armar({
        conColumna: true,
        gastos: [gasto('solo')],
        archivos: archivosDe('solo'),
        leer: () => fallo('pyservices 500'),
      });
      for (let i = 0; i < 24; i += 1) {
        await svc.releerFoliosGastos();
        reloj += 60 * MIN;
      }
      expect(readGastoTicket).toHaveBeenCalledTimes(6);
      expect(db[0].folio_releido_at).toBeNull();
      expect(svc.estadoPostergado('solo')).toMatchObject({
        intentos: 6,
        conIa: 0,
        retirado: true,
      });
    });

    it('pyservices CAÍDO toda la noche (sin conexión: no cuesta) ⇒ se reintenta cada hora sin sellar ni retirar', async () => {
      const { svc, db, readGastoTicket } = armar({
        conColumna: true,
        gastos: [gasto('a')],
        archivos: archivosDe('a'),
        leer: () => fallo('Sin conexión con pyservices: fetch failed'),
      });
      for (let i = 0; i < 10 * 12; i += 1) {
        await svc.releerFoliosGastos();
        reloj += 5 * MIN;
      }
      expect(readGastoTicket).toHaveBeenCalledTimes(10);
      expect(db[0].folio_releido_at).toBeNull();
      expect(svc.estadoPostergado('a')).toMatchObject({
        intentos: 0,
        conIa: 0,
        retirado: false,
      });
    });

    it('la BD rechaza SIEMPRE el UPDATE de un gasto ⇒ a lo más 6 lecturas (la IA ya cobró cada una) y fuera de la cola', async () => {
      const { svc, db, readGastoTicket } = armar({
        conColumna: true,
        gastos: [gasto('g1')],
        archivos: archivosDe('g1'),
        leer: () => lectura('A-1'),
        antesDeUpdate: () => ({ code: 'P0001', message: 'trigger rechazó' }),
      });
      for (let i = 0; i < 24; i += 1) {
        await svc.releerFoliosGastos();
        reloj += 60 * MIN;
      }
      expect(readGastoTicket).toHaveBeenCalledTimes(6);
      expect(db[0].folio_ticket).toBeNull();
      expect(svc.estadoPostergado('g1')).toMatchObject({
        intentos: 6,
        conIa: 0,
        retirado: true,
      });
    });
  });

  describe('CAS: jamás pisa lo que la oficina hizo mientras la IA leía', () => {
    it('folio tecleado a mano DURANTE la lectura ⇒ OMITIDO, sin escribir', async () => {
      const m: Mundo = {
        conColumna: true,
        gastos: [gasto('g1')],
        archivos: archivosDe('g1'),
      };
      const a = armar({
        ...m,
        leer: () => {
          const g = a.db[0];
          g.folio_ticket = 'MANUAL-9';
          g.updated_at = ahoraIso();
          return lectura('IA-1');
        },
      });
      const r = await a.svc.releerFoliosGastos();
      expect(r).toMatchObject({ omitidos: 1, con_folio: 0, fallos: 0 });
      expect(a.db[0].folio_ticket).toBe('MANUAL-9');
      expect(a.db[0].folio_releido_at).toBeNull();
      expect(a.escrituras()).toHaveLength(0);
    });

    it('folio tecleado ENTRE la relectura y el UPDATE ⇒ el UPDATE escribe 0 filas y no lo pisa', async () => {
      const { svc, db, escrituras } = armar({
        conColumna: true,
        gastos: [gasto('g1')],
        archivos: archivosDe('g1'),
        leer: () => lectura('IA-1'),
        antesDeUpdate: (d, _patch, n) => {
          if (n === 1) {
            d[0].folio_ticket = 'MANUAL-9';
            d[0].updated_at = ahoraIso();
          }
        },
      });
      const r = await svc.releerFoliosGastos();
      expect(r).toMatchObject({ omitidos: 1, con_folio: 0 });
      expect(db[0].folio_ticket).toBe('MANUAL-9');
      expect(db[0].valor_ia_extraido).toMatchObject({ folio: null });
      expect(escrituras()).toHaveLength(1);
    });

    it('notas editadas por la oficina ENTRE la relectura y el UPDATE del duplicado ⇒ se releen y se conservan', async () => {
      const { svc, db } = armar({
        conColumna: true,
        gastos: [
          gasto('g1', { notas: 'Pago ASUR' }),
          gasto('otro', { folio_ticket: 'FAC-1234' }),
        ],
        archivos: archivosDe('g1'),
        leer: () => lectura('FAC-1234'),
        antesDeUpdate: (d, patch, n) => {
          // 1.º = folio (23505); 2.º = duplicado: la oficina edita justo antes.
          if (n === 2 && 'duplicado_sospechado' in patch) {
            const g = d.find((x) => x.id === 'g1')!;
            g.notas = 'Pago ASUR · operación y FBO';
            g.updated_at = ahoraIso();
          }
        },
      });
      const r = await svc.releerFoliosGastos();
      expect(r).toMatchObject({ duplicados: 1 });
      expect(db.find((x) => x.id === 'g1')!.notas).toBe(
        'Pago ASUR · operación y FBO\n⚠ IA: folio FAC-1234 ya existe en otro gasto — revisar',
      );
    });
  });

  it('candado: una segunda corrida simultánea no hace nada', async () => {
    let soltar: () => void = () => undefined;
    const espera = new Promise<void>((res) => {
      soltar = res;
    });
    const { svc, readGastoTicket } = armar({
      conColumna: true,
      gastos: [gasto('g1')],
      archivos: archivosDe('g1'),
      leer: async () => {
        await espera;
        return lectura('A-1');
      },
    });
    const primera = svc.releerFoliosGastos();
    for (let i = 0; i < 10; i += 1) {
      await new Promise((res) => setImmediate(res));
    }
    expect(readGastoTicket).toHaveBeenCalledTimes(1);
    await expect(svc.releerFoliosGastos()).resolves.toBeNull();
    soltar();
    await expect(primera).resolves.toMatchObject({ con_folio: 1 });
    // Ya libre: la siguiente corre (y no encuentra nada).
    await expect(svc.releerFoliosGastos()).resolves.toMatchObject({
      tomados: 0,
    });
  });
});
