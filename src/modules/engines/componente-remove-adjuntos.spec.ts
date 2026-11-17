// BORRAR UN MOTOR O UNA HÉLICE CON ARCHIVOS DE INGENIERÍA (17-nov-2026, API
// 0.0.140, invariante 135). La llave foránea de `adjunto_ingenieria` va sin
// cascada (la migración no puede llevar esa cláusula): el API retira ANTES
// sus filas por código, las repone si el borrado del componente falla y, si
// el componente sí se borró, retira sus archivos del bucket.
jest.mock('../aircraft/aircraft.service', () => ({
  AircraftService: class {},
}));

import { Logger, NotFoundException } from '@nestjs/common';
import { EnginesService } from './engines.service';
import { PropellersService } from '../propellers/propellers.service';
import {
  armarFalso,
  tieneOp,
  uuid,
  type Fila,
  type OpcionesFalso,
} from '../engineering/ingenieria.fixture-spec';

const N990GG = uuid(1);
const MOTOR = uuid(401);
const OTRO_MOTOR = uuid(402);
const HELICE = uuid(501);
const T = 'adjunto_ingenieria';
const BUCKET = 'documentos-flota';

function adj(n: number, extra: Fila): Fila {
  return {
    id: uuid(n),
    aeronave_id: N990GG,
    mantenimiento_id: null,
    componente_id: null,
    motor_id: null,
    helice_id: null,
    storage_path: `oficina/archivo-${n}.pdf`,
    nombre: `archivo-${n}.pdf`,
    mime: 'application/pdf',
    bytes: 1000 + n,
    etiqueta: 'CERTIFICADO',
    nota: null,
    subido_por: null,
    created_at: '2026-11-17T15:00:00.000Z',
    eliminado_at: null,
    eliminado_por: null,
    ...extra,
  };
}

const CASOS = [
  {
    nombre: 'motor',
    tabla: 'motor',
    columna: 'motor_id',
    id: MOTOR,
    armarServicio: (falso: ReturnType<typeof armarFalso>) =>
      new EnginesService(falso.supabase, {} as never),
  },
  {
    nombre: 'hélice',
    tabla: 'helice',
    columna: 'helice_id',
    id: HELICE,
    armarServicio: (falso: ReturnType<typeof armarFalso>) =>
      new PropellersService(falso.supabase, {} as never),
  },
] as const;

describe.each(CASOS)(
  'Borrar $nombre con archivos de ingeniería (invariante 135)',
  ({ tabla, columna, id, armarServicio }) => {
    const PROPIO_1 = adj(1, { [columna]: id });
    const PROPIO_BAJA = adj(2, {
      [columna]: id,
      eliminado_at: '2026-11-10T00:00:00Z', // dado de baja: la llave sigue ahí
    });
    const AJENO = adj(3, { motor_id: OTRO_MOTOR });

    function armar(opciones: Partial<OpcionesFalso> = {}) {
      const falso = armarFalso({
        tablas: {
          motor: [
            { id: MOTOR, aeronave_id: N990GG, numero_serie: 'L-1234' },
            { id: OTRO_MOTOR, aeronave_id: N990GG, numero_serie: 'L-5678' },
          ],
          helice: [{ id: HELICE, aeronave_id: N990GG, numero_serie: 'H-1' }],
          vencimiento: [],
          [T]: [PROPIO_1, PROPIO_BAJA, AJENO],
        },
        objetos: [
          PROPIO_1.storage_path as string,
          PROPIO_BAJA.storage_path as string,
          AJENO.storage_path as string,
        ],
        ...opciones,
      });
      return { falso, service: armarServicio(falso) };
    }

    it('retira SUS filas (también las dadas de baja) ANTES de borrar el componente, y luego sus archivos del bucket', async () => {
      const { falso, service } = armar();
      const res = await service.remove(id);
      expect(res).toMatchObject({ deleted: true, id });
      // El componente ya no está y los archivos de OTRO componente siguen.
      expect(falso.de(tabla).some((f) => f.id === id)).toBe(false);
      expect(falso.de(T).map((f) => f.id)).toEqual([AJENO.id]);
      // Orden: primero las filas de adjunto, después el componente.
      const borrados = falso.consultas
        .filter((c) => tieneOp(c.ops, 'delete'))
        .map((c) => c.tabla);
      expect(borrados).toEqual([T, tabla]);
      // Sus archivos salen del bucket (nadie más conoce esas llaves).
      expect(falso.borrados).toContainEqual({
        bucket: BUCKET,
        paths: [PROPIO_1.storage_path, PROPIO_BAJA.storage_path],
      });
      expect(falso.objetos.has(AJENO.storage_path as string)).toBe(true);
    });

    it('si el borrado del componente FALLA, las filas se REPONEN y los archivos no se tocan', async () => {
      const { falso, service } = armar();
      falso.fallar(tabla, (ops) => tieneOp(ops, 'delete'), {
        code: '23503',
        message: `update or delete on table "${tabla}" violates foreign key constraint`,
      });
      await expect(service.remove(id)).rejects.toThrow(/foreign key/);
      // El componente sigue y sus archivos están exactamente como antes.
      expect(falso.de(tabla).some((f) => f.id === id)).toBe(true);
      const repuestas = falso
        .de(T)
        .map((f) => f.id)
        .sort();
      expect(repuestas).toEqual([PROPIO_1.id, PROPIO_BAJA.id, AJENO.id].sort());
      const baja = falso.de(T).find((f) => f.id === PROPIO_BAJA.id) as Fila;
      expect(baja.eliminado_at).toBe('2026-11-10T00:00:00Z');
      expect(baja.storage_path).toBe(PROPIO_BAJA.storage_path);
      expect(falso.borrados).toHaveLength(0);
    });

    it('sin archivos de ingeniería no se borra nada de esa tabla', async () => {
      const { falso, service } = armar({
        tablas: {
          motor: [{ id: MOTOR, aeronave_id: N990GG, numero_serie: 'L-1234' }],
          helice: [{ id: HELICE, aeronave_id: N990GG, numero_serie: 'H-1' }],
          vencimiento: [],
          [T]: [AJENO],
        },
      });
      await service.remove(id);
      expect(falso.conOp(T, 'delete')).toHaveLength(0);
      expect(falso.borrados).toHaveLength(0);
      expect(falso.de(T)).toHaveLength(1);
    });

    it('migración sin aplicar (la tabla no existe): el componente se borra como siempre', async () => {
      const { falso, service } = armar({ ausentes: [T] });
      await expect(service.remove(id)).resolves.toMatchObject({
        deleted: true,
      });
      expect(falso.de(tabla).some((f) => f.id === id)).toBe(false);
      expect(falso.borrados).toHaveLength(0);
    });

    it('un fallo al retirar del bucket NO tumba el borrado (best-effort)', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      const { falso, service } = armar();
      falso.fallarBorradoDeArchivos({ message: 'storage caído' });
      await expect(service.remove(id)).resolves.toMatchObject({
        deleted: true,
      });
      expect(falso.de(tabla).some((f) => f.id === id)).toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('un componente que no existe ⇒ 404 sin tocar los archivos', async () => {
      const { falso, service } = armar();
      await expect(service.remove(uuid(999))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(falso.conOp(T, 'delete')).toHaveLength(0);
    });
  },
);
