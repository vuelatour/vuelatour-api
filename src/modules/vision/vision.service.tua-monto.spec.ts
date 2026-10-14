import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import { VisionService } from './vision.service';

/**
 * Lectura de comprobantes con la TUA leída APARTE (13-oct-2026, TUA
 * sistémica, invariante 66). pyservices manda `tua_monto` (ADITIVO); el API
 * arma `desglose_lineas` con la MISMA fuente única del desglose y agrega
 * `tua_detectada` (lo que separaría ESTA lectura). Sin `tua_monto`, las
 * líneas son las de siempre.
 */
const config = {
  get: (k: string) => {
    if (k === 'PYSERVICES_BASE_URL') return 'http://py/';
    if (k === 'INTERNAL_SHARED_TOKEN') return 'tok';
    return 30000;
  },
} as unknown as ConfigService<EnvVars, true>;

const iaUso = { registrar: jest.fn() } as unknown as IaUsoService;

function ok(cuerpo: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(cuerpo),
    text: () => Promise.resolve(JSON.stringify(cuerpo)),
  } as unknown as Response;
}

/** Respuesta de pyservices (la forma de GastoTicketResponse). */
function lectura(extra: Record<string, unknown> = {}) {
  return {
    monto: 1925.27,
    propina: null,
    moneda: 'MXN',
    fecha: '2026-10-06',
    proveedor: 'ASUR',
    folio: 'FEACUN 1234',
    concepto: 'Servicios aeroportuarios',
    categoria_sugerida: 'OPERACIONES',
    medio_pago: 'TARJETA_CORP',
    tarjeta_terminacion: '0585',
    conceptos: [
      { concepto: 'Operaciones', monto: 1365.64 },
      { concepto: 'Autobuses', monto: 559.63 },
    ],
    matricula: null,
    confianza: 0.9,
    legible: true,
    notas: '',
    modelo: 'claude-opus-4-8',
    ...extra,
  };
}

async function leer(respuesta: Record<string, unknown>) {
  const fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(ok(respuesta));
  const v = new VisionService(config, iaUso);
  v.onModuleInit();
  try {
    return await v.readGastoTicket({ imageUrl: 'https://firmada/x.jpg' });
  } finally {
    fetchSpy.mockRestore();
  }
}

describe('VisionService.readGastoTicket — tua_monto (13-oct-2026)', () => {
  it('#383 (la IA llamó «Autobuses» a la TUA) + tua_monto 559.63 ⇒ líneas separadas y tua_detectada', async () => {
    const r = await leer(lectura({ tua_monto: 559.63 }));
    expect(r?.desglose_lineas).toEqual([
      'Operación - $1365.64 MXN',
      'TUA (IVA incluido) - $559.63 MXN',
    ]);
    expect(r?.tua_detectada).toBe(559.63);
    expect(r?.tua_monto).toBe(559.63);
  });

  it('sin tua_monto ⇒ las líneas crudas de siempre y tua_detectada null', async () => {
    const r = await leer(lectura());
    expect(r?.desglose_lineas).toEqual([
      'Operaciones - $1365.64 MXN',
      'Autobuses - $559.63 MXN',
    ]);
    expect(r?.tua_detectada).toBeNull();
  });

  it('un renglón «Tarifa TUA» MANDA sobre tua_monto', async () => {
    const r = await leer(
      lectura({
        monto: 1673.67,
        conceptos: [
          { concepto: 'Operaciones', monto: 554.41 },
          { concepto: 'Tarifa TUA', monto: 1119.26 },
        ],
        tua_monto: 999,
      }),
    );
    expect(r?.desglose_lineas).toEqual([
      'Operación - $554.41 MXN',
      'TUA (IVA incluido) - $1119.26 MXN',
    ]);
    expect(r?.tua_detectada).toBe(1119.26);
  });

  it('un solo renglón que cuadra + señal ⇒ 2 líneas (sin señal: sin líneas, como hoy)', async () => {
    const uno = [{ concepto: 'Operaciones', monto: 1925.27 }];
    const con = await leer(lectura({ conceptos: uno, tua_monto: 559.63 }));
    expect(con?.desglose_lineas).toEqual([
      'Operación - $1365.64 MXN',
      'TUA (IVA incluido) - $559.63 MXN',
    ]);
    const sin = await leer(lectura({ conceptos: uno }));
    expect(sin).not.toHaveProperty('desglose_lineas');
    expect(sin?.tua_detectada).toBeNull();
  });

  it('pyservices previo (sin la llave) ⇒ respuesta idéntica a la de hoy salvo tua_detectada', async () => {
    const respuesta = lectura({
      conceptos: [
        { concepto: 'Operaciones', monto: 554.41 },
        { concepto: 'Tarifa TUA', monto: 1119.26 },
      ],
      monto: 1673.67,
    });
    const r = await leer(respuesta);
    expect(r).toEqual({
      ...respuesta,
      desglose_lineas: [
        'Operación - $554.41 MXN',
        'TUA (IVA incluido) - $1119.26 MXN',
      ],
      tua_detectada: 1119.26,
    });
  });
});
