import { Rol } from '../../common/types/auth.types';
import {
  BUCKETS_FIRMABLES,
  BUCKETS_TRIPULACION,
  LARGO_MAX_PATH,
  MAX_PATHS_FIRMA,
  ROLES_FIRMA,
  ROLES_POR_BUCKET,
  esBucketFirmable,
  motivoPathInvalido,
  pathsAFirmar,
  rolPuedeFirmar,
  validarSolicitudFirma,
} from './storage-firma.util';
import {
  BUCKET_REPARTO_COMPROBANTES,
  ROLES_PAGOS_SOCIOS_LECTURA,
} from '../profit-sharing/reparto-pago.util';

// Paths REALES de prod (1-oct-2026): así se guardan en la BD.
const GASTO =
  '02996dd1-417d-4871-b4eb-87c4a9697cac/2026-09/20c7ef4a-889c-47a4-bcac-d3aafb08d96d.jpg';
const TACO =
  '3d5b8f23-dde7-4204-954c-07d3f5483fc7/2026-07/00dbe54c-acf8-4687-81a0-c4dda71210cd.jpg';
const VOUCHER =
  'oficina/60b0cb85-fb27-4bf9-a5fa-a103d23fff25/eb784055-17c6-4b1d-9232-566b6c5838de/a61632f8-d803-4188-bb80-eea7b5c34741.jpg';

describe('storage-firma.util — firma genérica acotada (1-oct-2026)', () => {
  describe('lista blanca de buckets', () => {
    it('exactamente los 10 buckets acordados', () => {
      expect([...BUCKETS_FIRMABLES].sort()).toEqual(
        [
          'cobro-vouchers',
          'documentos-flota',
          'estados-cuenta',
          'facturas',
          'gasto-fotos',
          'ingresos',
          'inventario-fotos',
          'planes-vuelo',
          'reparto-comprobantes',
          'taco-fotos',
        ].sort(),
      );
    });

    it('reparto-comprobantes es el bucket de los pagos a socios (fuente única)', () => {
      expect(BUCKETS_FIRMABLES).toContain(BUCKET_REPARTO_COMPROBANTES);
    });

    it('csd (certificados del SAT), avatars, aeronave-imagenes y cualquier otro ⇒ fuera', () => {
      for (const b of [
        'csd',
        'avatars',
        'aeronave-imagenes',
        'GASTO-FOTOS',
        ' gasto-fotos',
        'gasto-fotos/',
        '',
        'gasto-fotos/../csd',
      ]) {
        expect(esBucketFirmable(b)).toBe(false);
      }
      for (const b of BUCKETS_FIRMABLES) expect(esBucketFirmable(b)).toBe(true);
    });
  });

  describe('roles por bucket', () => {
    const OFICINA = [
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
      Rol.SOCIO,
      Rol.ANALISTA,
    ];

    // Matriz esperada: NUNCA más que el endpoint específico del bucket o la
    // política de lectura de Storage (revisión adversarial 1-oct-2026).
    const ADMIN_COORD_FACT = [Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION];
    const MATRIZ: Record<string, Rol[]> = {
      'gasto-fotos': [...OFICINA, Rol.PILOTO, Rol.MECANICO],
      'taco-fotos': [...OFICINA, Rol.PILOTO, Rol.MECANICO],
      'planes-vuelo': OFICINA,
      'inventario-fotos': OFICINA,
      'cobro-vouchers': ADMIN_COORD_FACT,
      facturas: ADMIN_COORD_FACT,
      ingresos: ADMIN_COORD_FACT,
      'documentos-flota': [Rol.ADMIN, Rol.COORDINADOR],
      'estados-cuenta': [Rol.ADMIN, Rol.FACTURACION],
      // = `GET profit-sharing/pagos` (ROLES_PAGOS_SOCIOS_LECTURA).
      'reparto-comprobantes': [
        Rol.ADMIN,
        Rol.FACTURACION,
        Rol.ANALISTA,
        Rol.SOCIO,
      ],
    };

    it('cada bucket de la lista blanca tiene su matriz de roles exacta', () => {
      expect(Object.keys(ROLES_POR_BUCKET).sort()).toEqual(
        [...BUCKETS_FIRMABLES].sort(),
      );
      for (const b of BUCKETS_FIRMABLES) {
        expect([...ROLES_POR_BUCKET[b]].sort()).toEqual([...MATRIZ[b]].sort());
        for (const rol of Object.values(Rol)) {
          expect(rolPuedeFirmar(rol, b)).toBe(MATRIZ[b].includes(rol));
        }
      }
    });

    it('reparto-comprobantes copia los roles de GET profit-sharing/pagos', () => {
      expect([...ROLES_POR_BUCKET['reparto-comprobantes']].sort()).toEqual(
        [...ROLES_PAGOS_SOCIOS_LECTURA].sort(),
      );
      for (const rol of [
        Rol.COORDINADOR,
        Rol.PILOTO,
        Rol.MECANICO,
        Rol.VISITANTE,
      ]) {
        expect(rolPuedeFirmar(rol, 'reparto-comprobantes')).toBe(false);
      }
    });

    it('privados sin política de lectura: ANALISTA y SOCIO NO firman estados de cuenta, CFDI, ingresos ni documentos de flota', () => {
      for (const rol of [Rol.ANALISTA, Rol.SOCIO]) {
        for (const b of [
          'estados-cuenta',
          'facturas',
          'ingresos',
          'documentos-flota',
          'cobro-vouchers',
        ] as const) {
          expect(rolPuedeFirmar(rol, b)).toBe(false);
        }
      }
      expect(rolPuedeFirmar(Rol.COORDINADOR, 'estados-cuenta')).toBe(false);
      expect(rolPuedeFirmar(Rol.FACTURACION, 'documentos-flota')).toBe(false);
    });

    it('oficina sí firma lo que Storage ya le deja leer (gasto-fotos, taco-fotos, planes-vuelo) y el bucket público', () => {
      for (const rol of OFICINA) {
        for (const b of [
          'gasto-fotos',
          'taco-fotos',
          'planes-vuelo',
          'inventario-fotos',
        ] as const) {
          expect(rolPuedeFirmar(rol, b)).toBe(true);
        }
      }
    });

    it('PILOTO/MECANICO solo gasto-fotos y taco-fotos', () => {
      expect([...BUCKETS_TRIPULACION].sort()).toEqual([
        'gasto-fotos',
        'taco-fotos',
      ]);
      for (const rol of [Rol.PILOTO, Rol.MECANICO]) {
        for (const b of BUCKETS_FIRMABLES) {
          expect(rolPuedeFirmar(rol, b)).toBe(
            b === 'gasto-fotos' || b === 'taco-fotos',
          );
        }
      }
    });

    it('VISITANTE no firma nada y ni siquiera está en los roles del endpoint', () => {
      for (const b of BUCKETS_FIRMABLES) {
        expect(rolPuedeFirmar(Rol.VISITANTE, b)).toBe(false);
      }
      expect(ROLES_FIRMA).not.toContain(Rol.VISITANTE);
      expect([...ROLES_FIRMA].sort()).toEqual(
        [...OFICINA, Rol.PILOTO, Rol.MECANICO].sort(),
      );
    });
  });

  describe('paths', () => {
    it('los paths reales de prod son válidos', () => {
      for (const p of [
        GASTO,
        TACO,
        VOUCHER,
        'oficina/1788277802698-ufv45b-anexo-poliza-n990gg.pdf',
      ]) {
        expect(motivoPathInvalido(p)).toBeNull();
      }
    });

    it('rechaza traversal, "/" inicial, "\\", control, URL completa y largo excesivo', () => {
      const casos: Array<[string, RegExp]> = [
        ['../csd/llave.key', /«\.» o «\.\.»/],
        ['a/../../csd/llave.key', /«\.» o «\.\.»/],
        ['a/./b.jpg', /«\.» o «\.\.»/],
        ['a/..', /«\.» o «\.\.»/],
        ['/gasto-fotos/a.jpg', /empieza con «\/»/],
        ['a\\..\\b.jpg', /«\\»/],
        ['a\u0000.jpg', /control/],
        ['a\n.jpg', /control/],
        [
          'https://x.supabase.co/storage/v1/object/sign/gasto-fotos/a.jpg?token=t',
          /URL completa/,
        ],
        ['a'.repeat(LARGO_MAX_PATH + 1), /más de 1024/],
      ];
      for (const [p, re] of casos) expect(motivoPathInvalido(p)).toMatch(re);
      // «..» DENTRO de un nombre no es un segmento: válido.
      expect(motivoPathInvalido('a/factura..pdf')).toBeNull();
      expect(motivoPathInvalido('a'.repeat(LARGO_MAX_PATH))).toBeNull();
    });

    it('pathsAFirmar quita vacíos y repetidos sin reordenar', () => {
      expect(pathsAFirmar([TACO, '', GASTO, TACO, ''])).toEqual([TACO, GASTO]);
      expect(pathsAFirmar([])).toEqual([]);
    });
  });

  describe('validarSolicitudFirma (orden: bucket → rol → tope → paths)', () => {
    it('OK: devuelve el bucket y los paths limpios', () => {
      expect(
        validarSolicitudFirma(Rol.COORDINADOR, 'gasto-fotos', [
          GASTO,
          GASTO,
          '',
        ]),
      ).toEqual({ ok: true, bucket: 'gasto-fotos', paths: [GASTO] });
    });

    it('bucket desconocido ⇒ 400 BUCKET_NO_PERMITIDO aun para ADMIN (y antes que el rol)', () => {
      for (const rol of [Rol.ADMIN, Rol.PILOTO]) {
        const r = validarSolicitudFirma(rol, 'csd', ['x.key']);
        expect(r).toMatchObject({
          ok: false,
          status: 400,
          code: 'BUCKET_NO_PERMITIDO',
          details: { bucket: 'csd' },
        });
      }
    });

    it('ANALISTA con estados de cuenta ⇒ 403 BUCKET_FUERA_DE_ROL con mensaje de oficina', () => {
      const r = validarSolicitudFirma(Rol.ANALISTA, 'estados-cuenta', [
        'cuenta/2026-09/edo.pdf',
      ]);
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: 'BUCKET_FUERA_DE_ROL',
      });
      expect(!r.ok && r.message).not.toMatch(/tacómetros/);
    });

    it('PILOTO con un bucket de oficina ⇒ 403 BUCKET_FUERA_DE_ROL', () => {
      expect(
        validarSolicitudFirma(Rol.PILOTO, 'cobro-vouchers', [VOUCHER]),
      ).toMatchObject({ ok: false, status: 403, code: 'BUCKET_FUERA_DE_ROL' });
      expect(
        validarSolicitudFirma(Rol.MECANICO, 'taco-fotos', [TACO]),
      ).toMatchObject({ ok: true, paths: [TACO] });
    });

    it(`más de ${MAX_PATHS_FIRMA} paths ⇒ 400 DEMASIADOS_PATHS; ${MAX_PATHS_FIRMA} exactos pasan`, () => {
      const muchos = Array.from(
        { length: MAX_PATHS_FIRMA + 1 },
        (_, i) => `a/${i}.jpg`,
      );
      expect(
        validarSolicitudFirma(Rol.ADMIN, 'gasto-fotos', muchos),
      ).toMatchObject({
        ok: false,
        status: 400,
        code: 'DEMASIADOS_PATHS',
        details: { maximo: MAX_PATHS_FIRMA, recibidos: MAX_PATHS_FIRMA + 1 },
      });
      const r = validarSolicitudFirma(
        Rol.ADMIN,
        'gasto-fotos',
        muchos.slice(0, MAX_PATHS_FIRMA),
      );
      expect(r.ok).toBe(true);
    });

    it('un path inválido tumba la solicitud con 400 PATH_INVALIDO', () => {
      expect(
        validarSolicitudFirma(Rol.ADMIN, 'taco-fotos', [TACO, '../csd/k.key']),
      ).toMatchObject({
        ok: false,
        status: 400,
        code: 'PATH_INVALIDO',
        details: { path: '../csd/k.key' },
      });
    });

    it('arreglo vacío es válido (no hay nada que firmar)', () => {
      expect(validarSolicitudFirma(Rol.FACTURACION, 'facturas', [])).toEqual({
        ok: true,
        bucket: 'facturas',
        paths: [],
      });
    });
  });
});
