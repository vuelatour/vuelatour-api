/**
 * AVISO EN PROCESO: «LO QUE GENERAN LOS SOCIOS CAMBIÓ» (10-nov-2026, API
 * 0.0.135, invariante 130).
 *
 * La cuenta corriente de los socios memoiza 10 min la utilidad de los meses
 * ya terminados (`reparto-utilidades.memo`). Cambiar la tarifa de la reserva
 * de overhaul mueve esos meses EN EL ACTO en el Balance (que no memoiza) y
 * la cuenta tardaba hasta 10 min en enterarse: el cliente comparó las dos
 * pantallas justo después de cambiar la tarifa y vio dos números distintos
 * («solo afecta al mes en curso»).
 *
 * Quien cambia algo que mueve la utilidad de meses pasados avisa aquí y el
 * dueño de la memoria (`ProfitSharingService`) la olvida. Sin inyección de
 * dependencias a propósito: `AircraftModule` no importa `ProfitSharingModule`
 * (ni al revés) y un `forwardRef` solo para esto sería un ciclo más.
 * Un solo proceso (Railway = 1 réplica): basta la memoria.
 */
type Oyente = () => void;

const oyentes = new Set<Oyente>();

/** Suscribe un oyente; devuelve cómo darlo de baja. */
export function alCambiarUtilidadesSocios(oyente: Oyente): () => void {
  oyentes.add(oyente);
  return () => {
    oyentes.delete(oyente);
  };
}

/** Avisa a todos; un oyente que falle no tumba a quien avisa. */
export function avisarCambioUtilidadesSocios(): void {
  for (const oyente of [...oyentes]) {
    try {
      oyente();
    } catch {
      // Olvidar una memoria nunca debe romper la escritura que avisó.
    }
  }
}
