/**
 * TARIFA POR HORA — PRECISIÓN ÚNICA DEL SISTEMA (22-sep-2026).
 *
 * EL PROBLEMA (cotización #105, caso REAL de producción): la oficina cerró el
 * **servicio aéreo** de un vuelo de 2.4 hr en $2,375.00 exactos tecleando la
 * tarifa personalizada **989.583333** (= 2,375 ÷ 2.4). El motor multiplicó
 * con esa precisión completa —2.4 × 989.583333 = 2,375.00— pero PERSISTIÓ la
 * tarifa redondeada: `round2` en `calculo_snapshot.tarifa.usd_por_hora` y
 * `numeric(10,2)` en `vuelo.tarifa_hora_usd` ⇒ **989.58**. Desde ahí, el
 * panel y `quickAdjust` REHIDRATAN la tarifa de esa columna/snapshot y
 * recalculan: 2.4 × 989.58 = 2,374.99. Reabrir la cotización y guardarla sin
 * tocar nada bajaba el total un centavo.
 *
 * (Al verificar #105: los $2,375.00 son el `subtotal_vuelo_usd`. El vuelo
 * lleva un descuento de $200.00 y $0 de IVA, así que su `monto_total_usd` es
 * **$2,175.00** — el par correcto tras el backfill es 2,375.00 / 2,175.00,
 * y con la tarifa truncada era 2,374.99 / 2,174.99.)
 *
 * ES EL TERCER FACTOR DE LA MISMA FAMILIA:
 *   · `tc.util`    — T.C. de 4 → 6 decimales (17-sep, vuelo #314).
 *   · `horas.util` — horas pactadas de 4 → 8 decimales (22-sep, #322/#302).
 *   · `tarifa.util` — ESTE (22-sep, #105).
 * Los tres dicen lo mismo, el **invariante 23** del repo: *lo que se PERSISTE
 * es EXACTAMENTE lo que se usó para MULTIPLICAR*. El motor normaliza la
 * tarifa efectiva ANTES de calcular el subtotal y guarda ese mismo número
 * (`numeric(14,6)`, migración `20260922000002_tarifa_hora_seis_decimales`).
 *
 * POR QUÉ 6 Y NO 8: una tarifa es el precio de UNA hora, y 6 decimales bastan
 * para cerrar el centavo en cualquier vuelo cotizable — el error máximo es
 * 5e-7 USD/hr × 48 hr (el tope del DTO) = 2.4e-5 USD, muy por debajo del
 * centavo. Son además los mismos 6 del T.C., que es el otro precio unitario
 * del sistema.
 *
 * FUERA DE ALCANCE (a propósito): los CATÁLOGOS de tarifa
 * —`aeronave.tarifa_hora_pub_usd`, `aeronave.tarifa_hora_broker_usd` y
 * `tarifa_cliente_aeronave.tarifa_hora_usd`— se quedan en `numeric(_,2)`: son
 * precios de lista que la oficina teclea en pesos y centavos. Su corolario
 * útil: **la ÚNICA tarifa que puede traer más de 2 decimales es la
 * personalizada de una cotización** (`tarifa_hora_override_usd`), y por eso
 * `esEcoDeTarifa` nunca se activa sobre una tarifa de catálogo.
 */

import { decimalesSignificativos, redondearA } from './redondeo.util';

/** Decimales canónicos de una tarifa por hora en este sistema. */
export const TARIFA_DECIMALES = 6;

/**
 * Media unidad del 2.º decimal: el error MÁXIMO que puede introducir un viaje
 * de ida y vuelta por la precisión vieja (`round2` / `numeric(10,2)`). Por
 * debajo de esto no hay intención humana posible —nadie corrige una tarifa
 * por medio centavo— así que una diferencia menor es SIEMPRE el eco de una
 * copia truncada, nunca una edición.
 */
export const TARIFA_TOLERANCIA_ECO = 0.005;

/**
 * Redondeo a 6 decimales (la precisión con la que la BD guarda una tarifa).
 */
export function round6(n: number): number {
  return redondearA(n, TARIFA_DECIMALES);
}

/**
 * Normaliza una tarifa capturada (DTO, snapshot, columna) a la precisión
 * canónica. `null` cuando no es un número POSITIVO: "sin tarifa" se propaga
 * explícito.
 *
 * Un **0 también devuelve null** a propósito, igual que `normalizarHoras`:
 * la tarifa 0 del cliente INTERNO no se rehidrata como override (el motor la
 * re-deriva sola desde `es_interno`), y todos los lectores que rehidratan ya
 * preguntaban `> 0`. Para normalizar la tarifa EFECTIVA del motor —donde el
 * 0 del interno sí es un valor legítimo— se usa `round6` directo.
 *
 * Es IDEMPOTENTE: aplicarla a una tarifa ya normalizada devuelve el mismo
 * número, así que el motor puede llamarla al calcular y otra vez al persistir
 * sin que el valor se mueva.
 */
export function normalizarTarifa(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return round6(n);
}

/**
 * ¿`entrante` es el ECO TRUNCADO de `persistida` (y no una edición real)?
 *
 * Verdadero solo si difieren por MENOS de media unidad del 2.º decimal Y el
 * entrante tiene MENOS decimales: la firma exacta de un cliente que leyó una
 * tarifa guardada con la precisión vieja y la devolvió tal cual (panel
 * anterior al 22-sep, `quickAdjust` leyendo la columna `numeric(10,2)`,
 * borrador viejo en caché, integración externa).
 *
 * Nunca se cumple cuando la oficina teclea MÁS precisión (989.58 →
 * 989.583333) ni cuando cambia la tarifa de verdad (989.583333 → 990, o →
 * 989.59: delta 6.7e-3 > la tolerancia): esas ediciones se respetan siempre.
 * Tampoco sobre una tarifa de CATÁLOGO, que nunca tiene más de 2 decimales
 * (ver la cabecera): ahí el entrante jamás puede traer MENOS.
 *
 * LA BANDA es «medio centavo por hora», no «2 decimales»: 989.5834 sobre
 * 989.583333 persistido también se ancla (difiere 6.7e-5 y trae 4 decimales
 * contra 6). Es deliberado y es inofensivo — 5e-3 USD/hr sobre el tope del
 * DTO (48 hr) son 0.24 USD y sobre un vuelo normal ni un centavo—, y es la
 * MISMA disciplina que `esEcoDeHorasPactadas`, cuya tolerancia es media
 * unidad de SU precisión vieja. Por debajo de medio centavo por hora no hay
 * intención humana que valga la pena adivinar.
 *
 * PUNTO CIEGO CONOCIDO (el mismo que `esEcoDeHorasPactadas`, decírselo a
 * quien toque esto): un eco truncado y un REDONDEO DELIBERADO a 2 decimales
 * son el MISMO número y no hay forma de distinguirlos. Si lo persistido es
 * 989.583333 y la oficina teclea «989.58» a propósito, se ancla y su edición
 * de **menos de un centavo por hora** se descarta en silencio. Es el precio
 * de que reabrir y guardar jamás mueva un total, y la decisión está tomada en
 * ese sentido: con el campo nuevo el operador VE «989.583333» antes de
 * teclear, y para mover el precio de verdad tiene el ajuste/descuento. Si
 * algún día hace falta permitirlo, el camino limpio es un campo ADITIVO en el
 * DTO («el humano tocó la tarifa»), no bajar la tolerancia.
 */
export function esEcoDeTarifa(entrante: number, persistida: number): boolean {
  if (!Number.isFinite(entrante) || !Number.isFinite(persistida)) return false;
  if (entrante === persistida) return false;
  if (Math.abs(entrante - persistida) > TARIFA_TOLERANCIA_ECO) return false;
  return (
    decimalesSignificativos(entrante, TARIFA_DECIMALES) <
    decimalesSignificativos(persistida, TARIFA_DECIMALES)
  );
}

/**
 * TARIFA REALMENTE PERSISTIDA de un vuelo: entre el snapshot
 * (`calculo_snapshot.tarifa.usd_por_hora`) y la columna
 * (`vuelo.tarifa_hora_usd`) gana la que conserve MÁS decimales, siempre que
 * sean la MISMA tarifa (difieren solo por el truncamiento viejo).
 *
 * Por qué hacen falta las dos: el snapshot es `jsonb` y lleva los 6 decimales
 * desde el primer deploy, mientras que la columna sigue en `numeric(10,2)`
 * hasta aplicar la migración `20260922000002` — leer la más precisa es lo que
 * hace que el total no se mueva **aunque la migración no esté aplicada**.
 * Después de aplicarla el criterio sigue valiendo al revés: una fila escrita
 * por un API viejo puede tener el snapshot truncado y la columna completa.
 * Si divergen DE VERDAD (otra tarifa), manda el snapshot: es el registro
 * propio del motor, el mismo con el que compuso el precio.
 */
export function tarifaPersistida(
  snapshot: unknown,
  columna: unknown,
): number | null {
  const s = normalizarTarifa(snapshot);
  const c = normalizarTarifa(columna);
  if (s == null) return c;
  if (c == null) return s;
  if (esEcoDeTarifa(s, c)) return c;
  return s;
}
